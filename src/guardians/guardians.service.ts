import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma, TxClient } from '../database/prisma.service';
import {
  CreateGuardianDto,
  GuardianDto,
  GuardianProfileDto,
  LinkGuardianDto,
  QueryGuardiansDto,
  UpdateGuardianDto,
  UpdateGuardianLinkDto,
} from './dto/guardian.dto';

const WITH_WARD_COUNT = {
  _count: { select: { students: true } },
} satisfies Prisma.GuardianInclude;

const WITH_WARDS = {
  ...WITH_WARD_COUNT,
  students: {
    include: {
      student: {
        select: {
          id: true,
          studentId: true,
          firstName: true,
          lastName: true,
          middleName: true,
          classArm: {
            select: { name: true, class: { select: { name: true } } },
          },
        },
      },
    },
    orderBy: { isPrimary: 'desc' },
  },
} satisfies Prisma.GuardianInclude;

type GuardianRow = Prisma.GuardianGetPayload<{
  include: typeof WITH_WARD_COUNT;
}>;
type GuardianProfileRow = Prisma.GuardianGetPayload<{
  include: typeof WITH_WARDS;
}>;

@Injectable()
export class GuardiansService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async create(dto: CreateGuardianDto, schoolId: string): Promise<GuardianDto> {
    if (dto.email) {
      await this.assertEmailFree(dto.email);
    }

    const created = await this.prisma.guardian.create({
      data: {
        // Prisma's types require the tenant column on create. Supplying it is
        // safe: the guard rejects any value other than the active tenant.
        schoolId,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        altPhone: dto.altPhone ?? null,
        email: dto.email ?? null,
        addressLine: dto.addressLine ?? null,
        occupation: dto.occupation ?? null,
      },
      include: WITH_WARD_COUNT,
    });

    return this.toDto(created);
  }

  async list(query: QueryGuardiansDto): Promise<PaginatedDto<GuardianDto>> {
    const search = query.search?.trim();
    const where: Prisma.GuardianWhereInput = {
      ...(query.studentId
        ? { students: { some: { studentId: query.studentId } } }
        : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
              // Phone is how a school actually looks a parent up.
              { phone: { contains: search } },
              { altPhone: { contains: search } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.guardian.findMany({
        where,
        orderBy:
          query.sortBy === 'lastName'
            ? [{ lastName: query.sortOrder }, { firstName: query.sortOrder }]
            : [{ [query.sortBy]: query.sortOrder }],
        skip: query.skip,
        take: query.limit,
        include: WITH_WARD_COUNT,
      }),
      this.prisma.guardian.count({ where }),
    ]);

    const portal = await this.portalStatuses(rows);
    return paginate(
      rows.map((row) => this.toDto(row, portal)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(id: string): Promise<GuardianProfileDto> {
    const found = await this.prisma.guardian.findUnique({
      where: { id },
      include: WITH_WARDS,
    });

    if (!found) {
      throw AppException.notFound('Guardian');
    }

    return this.toProfileDto(found, await this.portalStatuses([found]));
  }

  async update(id: string, dto: UpdateGuardianDto): Promise<GuardianDto> {
    const existing = await this.getOrThrow(id);

    if (dto.email && dto.email !== existing.email) {
      await this.assertEmailFree(dto.email);
    }

    const updated = await this.prisma.guardian.update({
      where: { id },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        altPhone: dto.altPhone,
        email: dto.email,
        addressLine: dto.addressLine,
        occupation: dto.occupation,
      },
      include: WITH_WARD_COUNT,
    });

    return this.toDto(updated, await this.portalStatuses([updated]));
  }

  async remove(id: string): Promise<void> {
    const existing = await this.getOrThrow(id);

    // Links cascade, so deleting a linked guardian would quietly strip students
    // of their contact. Unlink first and the loss is deliberate.
    if (existing._count.students > 0) {
      throw AppException.conflict(
        `This guardian is still linked to ${existing._count.students} student(s). Unlink them first.`,
      );
    }

    await this.prisma.guardian.delete({ where: { id } });
  }

  // ---------------------------------------------------------------------------
  // Student links
  // ---------------------------------------------------------------------------

  async link(
    studentId: string,
    dto: LinkGuardianDto,
    schoolId: string,
  ): Promise<GuardianProfileDto> {
    await this.assertStudentExists(studentId);
    await this.getOrThrow(dto.guardianId);

    const existing = await this.prisma.studentGuardian.findUnique({
      where: {
        studentId_guardianId: { studentId, guardianId: dto.guardianId },
      },
      select: { studentId: true },
    });

    if (existing) {
      throw AppException.duplicate(
        'This guardian is already linked to the student',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await this.demoteOtherPrimaries(tx, studentId);
      }

      await tx.studentGuardian.create({
        data: {
          // Denormalised tenant column, so the guard can scope the join table.
          schoolId,
          studentId,
          guardianId: dto.guardianId,
          relationship: dto.relationship,
          isPrimary: dto.isPrimary ?? false,
          canPickUp: dto.canPickUp ?? true,
        },
      });
    });

    return this.findOne(dto.guardianId);
  }

  async updateLink(
    studentId: string,
    guardianId: string,
    dto: UpdateGuardianLinkDto,
  ): Promise<GuardianProfileDto> {
    await this.getLinkOrThrow(studentId, guardianId);

    await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary === true) {
        await this.demoteOtherPrimaries(tx, studentId, guardianId);
      }

      await tx.studentGuardian.update({
        where: { studentId_guardianId: { studentId, guardianId } },
        data: {
          relationship: dto.relationship,
          isPrimary: dto.isPrimary,
          canPickUp: dto.canPickUp,
        },
      });
    });

    return this.findOne(guardianId);
  }

  async unlink(studentId: string, guardianId: string): Promise<void> {
    await this.getLinkOrThrow(studentId, guardianId);

    await this.prisma.studentGuardian.delete({
      where: { studentId_guardianId: { studentId, guardianId } },
    });
  }

  /**
   * A student has at most one primary guardian — the person the school calls
   * first — so promoting one demotes the rest in the same transaction.
   */
  private async demoteOtherPrimaries(
    tx: TxClient,
    studentId: string,
    exceptGuardianId?: string,
  ): Promise<void> {
    await tx.studentGuardian.updateMany({
      where: {
        studentId,
        isPrimary: true,
        ...(exceptGuardianId ? { guardianId: { not: exceptGuardianId } } : {}),
      },
      data: { isPrimary: false },
    });
  }

  /** Portal status per linked user, in one query for the whole page. */
  private async portalStatuses(
    rows: { userId: string | null }[],
  ): Promise<Map<string, string>> {
    const userIds = rows
      .map((row) => row.userId)
      .filter((id): id is string => id !== null);
    if (userIds.length === 0) return new Map();

    const memberships = await this.prisma.membership.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, status: true },
    });
    return new Map(memberships.map((m) => [m.userId, m.status]));
  }

  private async getOrThrow(id: string): Promise<GuardianRow> {
    const found = await this.prisma.guardian.findUnique({
      where: { id },
      include: WITH_WARD_COUNT,
    });

    if (!found) {
      throw AppException.notFound('Guardian');
    }

    return found;
  }

  private async getLinkOrThrow(
    studentId: string,
    guardianId: string,
  ): Promise<void> {
    const link = await this.prisma.studentGuardian.findUnique({
      where: { studentId_guardianId: { studentId, guardianId } },
      select: { studentId: true },
    });

    if (!link) {
      throw AppException.notFound('Guardian link');
    }
  }

  /** Cross-tenant ids resolve to nothing: the guard scopes the lookup. */
  private async assertStudentExists(studentId: string): Promise<void> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true },
    });

    if (!student) {
      throw AppException.notFound('Student');
    }
  }

  private async assertEmailFree(email: string): Promise<void> {
    const clash = await this.prisma.guardian.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });

    if (clash) {
      throw AppException.duplicate(
        `A guardian with email "${email}" already exists`,
      );
    }
  }

  private toDto(
    row: GuardianRow,
    portal: Map<string, string> = new Map(),
  ): GuardianDto {
    const portalStatus = row.userId
      ? (portal.get(row.userId) ?? 'NONE')
      : 'NONE';
    return {
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      fullName: `${row.firstName} ${row.lastName}`,
      phone: row.phone,
      altPhone: row.altPhone,
      email: row.email,
      addressLine: row.addressLine,
      occupation: row.occupation,
      wardCount: row._count.students,
      hasPortalAccess: portalStatus === 'ACTIVE',
      portalStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toProfileDto(
    row: GuardianProfileRow,
    portal: Map<string, string>,
  ): GuardianProfileDto {
    return {
      ...this.toDto(row, portal),
      wards: row.students.map((link) => {
        const middle = link.student.middleName
          ? ` ${link.student.middleName}`
          : '';
        return {
          studentId: link.student.id,
          admissionNumber: link.student.studentId,
          fullName: `${link.student.lastName}, ${link.student.firstName}${middle}`,
          className: link.student.classArm
            ? `${link.student.classArm.class.name} ${link.student.classArm.name}`
            : null,
          relationship: link.relationship,
          isPrimary: link.isPrimary,
          canPickUp: link.canPickUp,
        };
      }),
    };
  }
}
