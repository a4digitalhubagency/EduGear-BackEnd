import { Injectable } from '@nestjs/common';
import { MembershipStatus, Prisma, StudentStatus } from '@prisma/client';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import {
  ClassArmDto,
  CreateClassArmDto,
  QueryClassArmsDto,
  UpdateClassArmDto,
} from './dto/class-arm.dto';

const WITH_CONTEXT = {
  class: { select: { name: true, level: true } },
  _count: { select: { students: { where: { status: StudentStatus.ACTIVE } } } },
} satisfies Prisma.ClassArmInclude;

type ArmRow = Prisma.ClassArmGetPayload<{ include: typeof WITH_CONTEXT }>;

@Injectable()
export class ClassArmsService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async create(dto: CreateClassArmDto, schoolId: string): Promise<ClassArmDto> {
    await this.assertClassExists(dto.classId);
    await this.assertNameFree(dto.classId, dto.name);
    if (dto.formTeacherId) {
      await this.assertStaffMember(dto.formTeacherId);
    }

    const created = await this.prisma.classArm.create({
      data: {
        // Prisma's types require the tenant column on create. Supplying it is
        // safe: the guard rejects any value other than the active tenant.
        schoolId,
        classId: dto.classId,
        name: dto.name,
        capacity: dto.capacity ?? null,
        formTeacherId: dto.formTeacherId ?? null,
      },
      include: WITH_CONTEXT,
    });

    return this.toDto(created, await this.teacherNames([created]));
  }

  async list(query: QueryClassArmsDto): Promise<PaginatedDto<ClassArmDto>> {
    const where: Prisma.ClassArmWhereInput = {
      ...(query.classId ? { classId: query.classId } : {}),
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.classArm.findMany({
        where,
        orderBy: [
          // Arms read naturally grouped by class, then by arm name.
          { class: { level: 'asc' } },
          { [query.sortBy]: query.sortOrder },
        ],
        skip: query.skip,
        take: query.limit,
        include: WITH_CONTEXT,
      }),
      this.prisma.classArm.count({ where }),
    ]);

    const names = await this.teacherNames(rows);

    return paginate(
      rows.map((row) => this.toDto(row, names)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(id: string): Promise<ClassArmDto> {
    const row = await this.getOrThrow(id);
    return this.toDto(row, await this.teacherNames([row]));
  }

  async update(id: string, dto: UpdateClassArmDto): Promise<ClassArmDto> {
    const existing = await this.getOrThrow(id);

    if (dto.name && dto.name !== existing.name) {
      await this.assertNameFree(existing.classId, dto.name);
    }
    if (dto.formTeacherId) {
      await this.assertStaffMember(dto.formTeacherId);
    }
    if (dto.capacity !== undefined && dto.capacity !== null) {
      this.assertCapacityFitsRoll(dto.capacity, existing._count.students);
    }

    const updated = await this.prisma.classArm.update({
      where: { id },
      data: {
        name: dto.name,
        // null clears the column; undefined leaves it untouched.
        capacity: dto.capacity,
        formTeacherId: dto.formTeacherId,
      },
      include: WITH_CONTEXT,
    });

    return this.toDto(updated, await this.teacherNames([updated]));
  }

  async remove(id: string): Promise<void> {
    const existing = await this.getOrThrow(id);

    // Students reference the arm with onDelete: SetNull, so deleting an occupied
    // arm would quietly unassign its roll. Make the caller move them first.
    if (existing._count.students > 0) {
      throw AppException.conflict(
        `This arm still has ${existing._count.students} active student(s). Move them first.`,
      );
    }

    await this.prisma.classArm.delete({ where: { id } });
  }

  /** Used by student admission and promotion to check room before assigning. */
  async assertHasRoom(armId: string, incoming = 1): Promise<void> {
    const arm = await this.getOrThrow(armId);
    if (arm.capacity === null) return;

    if (arm._count.students + incoming > arm.capacity) {
      throw AppException.conflict(
        `${arm.class.name} ${arm.name} is full (${arm._count.students}/${arm.capacity})`,
      );
    }
  }

  private async getOrThrow(id: string): Promise<ArmRow> {
    const found = await this.prisma.classArm.findUnique({
      where: { id },
      include: WITH_CONTEXT,
    });

    if (!found) {
      throw AppException.notFound('Class arm');
    }

    return found;
  }

  /** Cross-tenant ids resolve to nothing: the guard scopes the lookup. */
  private async assertClassExists(classId: string): Promise<void> {
    const found = await this.prisma.class.findUnique({
      where: { id: classId },
      select: { id: true },
    });

    if (!found) {
      throw AppException.notFound('Class');
    }
  }

  private async assertNameFree(classId: string, name: string): Promise<void> {
    const clash = await this.prisma.classArm.findFirst({
      where: { classId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });

    if (clash) {
      throw AppException.duplicate(
        `This class already has an arm named "${name}"`,
      );
    }
  }

  /**
   * `formTeacherId` is a membership id with no foreign key — deliberately, so a
   * departing staff member does not drag the arm with them. That means the
   * reference has to be validated by hand.
   */
  private async assertStaffMember(membershipId: string): Promise<void> {
    const membership = await this.prisma.membership.findUnique({
      where: { id: membershipId },
      select: { status: true },
    });

    if (!membership) {
      throw AppException.notFound('Form teacher');
    }
    if (membership.status !== MembershipStatus.ACTIVE) {
      throw AppException.badRequest(
        'The form teacher must be active staff at this school',
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  private assertCapacityFitsRoll(capacity: number, enrolled: number): void {
    if (capacity < enrolled) {
      throw AppException.conflict(
        `Capacity ${capacity} is below the ${enrolled} student(s) already in this arm`,
      );
    }
  }

  /** One lookup for every arm in the page, rather than one per row. */
  private async teacherNames(rows: ArmRow[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows
          .map((row) => row.formTeacherId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (ids.length === 0) return new Map();

    const memberships = await this.prisma.membership.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        user: { select: { firstName: true, lastName: true } },
      },
    });

    return new Map(
      memberships.map((m) => [m.id, `${m.user.firstName} ${m.user.lastName}`]),
    );
  }

  private toDto(row: ArmRow, teacherNames: Map<string, string>): ClassArmDto {
    return {
      id: row.id,
      classId: row.classId,
      className: row.class.name,
      classLevel: row.class.level,
      name: row.name,
      fullName: `${row.class.name} ${row.name}`,
      capacity: row.capacity,
      formTeacherId: row.formTeacherId,
      formTeacherName: row.formTeacherId
        ? (teacherNames.get(row.formTeacherId) ?? null)
        : null,
      studentCount: row._count.students,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
