import { Injectable } from '@nestjs/common';
import { MembershipStatus, Prisma } from '@prisma/client';
import { RequestContext } from '../common/context/request-context';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import {
  AssignTeacherDto,
  ClassSubjectDto,
  CreateSubjectDto,
  OfferSubjectDto,
  QuerySubjectsDto,
  SubjectDto,
  TeachingAssignmentDto,
  TeachingAssignmentQueryDto,
  UpdateClassSubjectDto,
  UpdateSubjectDto,
} from './dto/subject.dto';

const WITH_CLASS_COUNT = {
  _count: { select: { classSubjects: true } },
} satisfies Prisma.SubjectInclude;

type SubjectRow = Prisma.SubjectGetPayload<{
  include: typeof WITH_CLASS_COUNT;
}>;

@Injectable()
export class SubjectsService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  // ---------------------------------------------------------------------------
  // Subjects
  // ---------------------------------------------------------------------------

  async create(dto: CreateSubjectDto, schoolId: string): Promise<SubjectDto> {
    await this.assertUnique(dto.name, dto.code);

    const created = await this.prisma.subject.create({
      data: { schoolId, name: dto.name, code: dto.code },
      include: WITH_CLASS_COUNT,
    });
    return this.toDto(created);
  }

  async list(query: QuerySubjectsDto): Promise<PaginatedDto<SubjectDto>> {
    const where: Prisma.SubjectWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.subject.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: query.skip,
        take: query.limit,
        include: WITH_CLASS_COUNT,
      }),
      this.prisma.subject.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toDto(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(id: string): Promise<SubjectDto> {
    return this.toDto(await this.getOrThrow(id));
  }

  async update(id: string, dto: UpdateSubjectDto): Promise<SubjectDto> {
    const existing = await this.getOrThrow(id);
    await this.assertUnique(
      dto.name && dto.name !== existing.name ? dto.name : undefined,
      dto.code && dto.code !== existing.code ? dto.code : undefined,
    );

    const updated = await this.prisma.subject.update({
      where: { id },
      data: { name: dto.name, code: dto.code, isActive: dto.isActive },
      include: WITH_CLASS_COUNT,
    });
    return this.toDto(updated);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.getOrThrow(id);

    const [scores, results] = await Promise.all([
      this.prisma.score.count({ where: { subjectId: id } }),
      this.prisma.subjectResult.count({ where: { subjectId: id } }),
    ]);
    if (scores > 0 || results > 0) {
      throw AppException.conflict(
        `${existing.name} has scores or results recorded against it. Deactivate it instead of deleting.`,
      );
    }
    if (existing._count.classSubjects > 0) {
      throw AppException.conflict(
        `${existing.name} is offered by ${existing._count.classSubjects} class(es). Remove it from them first.`,
      );
    }

    await this.prisma.subject.delete({ where: { id } });
  }

  // ---------------------------------------------------------------------------
  // What a class offers
  // ---------------------------------------------------------------------------

  async classSubjects(classId: string): Promise<ClassSubjectDto[]> {
    await this.assertClassExists(classId);

    const [offered, arms] = await Promise.all([
      this.prisma.classSubject.findMany({
        where: { classId },
        include: { subject: true },
        orderBy: { subject: { name: 'asc' } },
      }),
      this.prisma.classArm.findMany({
        where: { classId },
        select: {
          id: true,
          name: true,
          teachingAssignments: {
            select: { subjectId: true, teacherMembershipId: true },
          },
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    const names = await this.teacherNames(
      arms.flatMap((arm) =>
        arm.teachingAssignments.map((a) => a.teacherMembershipId),
      ),
    );

    return offered.map((row) => ({
      subjectId: row.subjectId,
      name: row.subject.name,
      code: row.subject.code,
      isCompulsory: row.isCompulsory,
      teachers: arms.map((arm) => {
        const assignment = arm.teachingAssignments.find(
          (a) => a.subjectId === row.subjectId,
        );
        return {
          classArmId: arm.id,
          armName: arm.name,
          teacherMembershipId: assignment?.teacherMembershipId ?? null,
          teacherName: assignment
            ? (names.get(assignment.teacherMembershipId) ?? null)
            : null,
        };
      }),
    }));
  }

  async offer(
    classId: string,
    dto: OfferSubjectDto,
    schoolId: string,
  ): Promise<ClassSubjectDto[]> {
    await this.assertClassExists(classId);
    const subject = await this.getOrThrow(dto.subjectId);

    if (!subject.isActive) {
      throw AppException.conflict(
        `${subject.name} is retired and cannot be offered`,
      );
    }

    const existing = await this.prisma.classSubject.findUnique({
      where: { classId_subjectId: { classId, subjectId: dto.subjectId } },
    });
    if (existing) {
      throw AppException.duplicate(`This class already offers ${subject.name}`);
    }

    await this.prisma.classSubject.create({
      data: {
        schoolId,
        classId,
        subjectId: dto.subjectId,
        isCompulsory: dto.isCompulsory ?? true,
      },
    });
    return this.classSubjects(classId);
  }

  async updateOffer(
    classId: string,
    subjectId: string,
    dto: UpdateClassSubjectDto,
  ): Promise<ClassSubjectDto[]> {
    await this.getOfferOrThrow(classId, subjectId);
    await this.prisma.classSubject.update({
      where: { classId_subjectId: { classId, subjectId } },
      data: { isCompulsory: dto.isCompulsory },
    });
    return this.classSubjects(classId);
  }

  async withdraw(classId: string, subjectId: string): Promise<void> {
    await this.getOfferOrThrow(classId, subjectId);

    // Scores for this subject from the class's arms would be orphaned from any
    // sheet that could compute them. Keep the offer while they exist.
    const scores = await this.prisma.score.count({
      where: { subjectId, classArm: { classId } },
    });
    if (scores > 0) {
      throw AppException.conflict(
        'Scores have already been entered for this subject in this class, so it cannot be withdrawn',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.teachingAssignment.deleteMany({
        where: { subjectId, classArm: { classId } },
      });
      await tx.classSubject.delete({
        where: { classId_subjectId: { classId, subjectId } },
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Who teaches what
  // ---------------------------------------------------------------------------

  async assignTeacher(
    classArmId: string,
    subjectId: string,
    dto: AssignTeacherDto,
    schoolId: string,
  ): Promise<TeachingAssignmentDto> {
    const arm = await this.prisma.classArm.findUnique({
      where: { id: classArmId },
      select: { classId: true },
    });
    if (!arm) throw AppException.notFound('Class arm');
    await this.getOfferOrThrow(arm.classId, subjectId);
    await this.assertActiveStaff(dto.teacherMembershipId);

    await this.prisma.teachingAssignment.upsert({
      where: { classArmId_subjectId: { classArmId, subjectId } },
      create: {
        schoolId,
        classArmId,
        subjectId,
        teacherMembershipId: dto.teacherMembershipId,
      },
      update: { teacherMembershipId: dto.teacherMembershipId },
    });

    const [assignment] = await this.assignments({ classArmId }).then((rows) =>
      rows.filter((row) => row.subjectId === subjectId),
    );
    return assignment;
  }

  async unassignTeacher(classArmId: string, subjectId: string): Promise<void> {
    const { count } = await this.prisma.teachingAssignment.deleteMany({
      where: { classArmId, subjectId },
    });
    if (count === 0) throw AppException.notFound('Teaching assignment');
  }

  async assignments(
    query: TeachingAssignmentQueryDto,
  ): Promise<TeachingAssignmentDto[]> {
    const teacher = query.mine
      ? RequestContext.getAuth()?.membershipId
      : query.teacherMembershipId;

    const rows = await this.prisma.teachingAssignment.findMany({
      where: {
        ...(teacher ? { teacherMembershipId: teacher } : {}),
        ...(query.classArmId ? { classArmId: query.classArmId } : {}),
      },
      include: {
        subject: { select: { name: true } },
        classArm: {
          select: {
            name: true,
            class: { select: { name: true, level: true } },
          },
        },
      },
    });

    const names = await this.teacherNames(
      rows.map((row) => row.teacherMembershipId),
    );

    return rows
      .sort(
        (a, b) =>
          a.classArm.class.level - b.classArm.class.level ||
          a.classArm.name.localeCompare(b.classArm.name) ||
          a.subject.name.localeCompare(b.subject.name),
      )
      .map((row) => ({
        classArmId: row.classArmId,
        className: `${row.classArm.class.name} ${row.classArm.name}`,
        subjectId: row.subjectId,
        subjectName: row.subject.name,
        teacherMembershipId: row.teacherMembershipId,
        teacherName: names.get(row.teacherMembershipId) ?? null,
      }));
  }

  // ---------------------------------------------------------------------------

  private async getOrThrow(id: string): Promise<SubjectRow> {
    const found = await this.prisma.subject.findUnique({
      where: { id },
      include: WITH_CLASS_COUNT,
    });
    if (!found) throw AppException.notFound('Subject');
    return found;
  }

  private async getOfferOrThrow(classId: string, subjectId: string) {
    const offer = await this.prisma.classSubject.findUnique({
      where: { classId_subjectId: { classId, subjectId } },
    });
    if (!offer) {
      throw AppException.notFound('This class does not offer that subject');
    }
    return offer;
  }

  private async assertClassExists(classId: string): Promise<void> {
    const found = await this.prisma.class.findUnique({
      where: { id: classId },
      select: { id: true },
    });
    if (!found) throw AppException.notFound('Class');
  }

  private async assertUnique(name?: string, code?: string): Promise<void> {
    if (name) {
      const clash = await this.prisma.subject.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
        select: { id: true },
      });
      if (clash)
        throw AppException.duplicate(
          `A subject named "${name}" already exists`,
        );
    }
    if (code) {
      const clash = await this.prisma.subject.findFirst({
        where: { code },
        select: { name: true },
      });
      if (clash) {
        throw AppException.duplicate(
          `Code ${code} is already used by ${clash.name}`,
        );
      }
    }
  }

  /** No foreign key, so the reference is checked by hand — as for form teachers. */
  private async assertActiveStaff(membershipId: string): Promise<void> {
    const membership = await this.prisma.membership.findUnique({
      where: { id: membershipId },
      select: { status: true },
    });
    if (!membership) throw AppException.notFound('Teacher');
    if (membership.status !== MembershipStatus.ACTIVE) {
      throw AppException.badRequest(
        'The teacher must be active staff at this school',
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  private async teacherNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    const memberships = await this.prisma.membership.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        user: { select: { firstName: true, lastName: true } },
      },
    });
    return new Map(
      memberships.map((m) => [m.id, `${m.user.firstName} ${m.user.lastName}`]),
    );
  }

  private toDto(row: SubjectRow): SubjectDto {
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      isActive: row.isActive,
      classCount: row._count.classSubjects,
      createdAt: row.createdAt,
    };
  }
}
