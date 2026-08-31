import { Injectable } from '@nestjs/common';
import { Prisma, StudentStatus } from '@prisma/client';
import { ClassArmsService } from '../academics/class-arms.service';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { formatAdmissionNumber, nextSequence } from './admission-number';
import {
  AdmitStudentDto,
  ChangeStudentStatusDto,
  QueryStudentsDto,
  StudentDto,
  StudentProfileDto,
  UpdateStudentDto,
} from './dto/student.dto';

const WITH_ARM = {
  classArm: { select: { name: true, class: { select: { name: true } } } },
} satisfies Prisma.StudentInclude;

const WITH_GUARDIANS = {
  ...WITH_ARM,
  guardians: {
    include: {
      guardian: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
        },
      },
    },
    orderBy: { isPrimary: 'desc' },
  },
} satisfies Prisma.StudentInclude;

type StudentRow = Prisma.StudentGetPayload<{ include: typeof WITH_ARM }>;
type ProfileRow = Prisma.StudentGetPayload<{ include: typeof WITH_GUARDIANS }>;

/** Retries cover the window between reading the last number and writing it. */
const ADMISSION_NUMBER_ATTEMPTS = 5;

@Injectable()
export class StudentsService {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly arms: ClassArmsService,
  ) {}

  async admit(dto: AdmitStudentDto, schoolId: string): Promise<StudentDto> {
    this.assertBornBeforeAdmission(dto.dateOfBirth ?? null, dto.admissionDate);

    if (dto.classArmId) {
      await this.arms.assertHasRoom(dto.classArmId);
    }
    if (dto.studentId) {
      await this.assertAdmissionNumberFree(dto.studentId);
    }

    const data = {
      // Prisma's types require the tenant column on create. Supplying it is
      // safe: the guard rejects any value other than the active tenant.
      schoolId,
      firstName: dto.firstName,
      lastName: dto.lastName,
      middleName: dto.middleName ?? null,
      gender: dto.gender,
      dateOfBirth: dto.dateOfBirth ?? null,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
      addressLine: dto.addressLine ?? null,
      photoUrl: dto.photoUrl ?? null,
      admissionDate: dto.admissionDate,
      classArmId: dto.classArmId ?? null,
      bloodGroup: dto.bloodGroup ?? null,
      genotype: dto.genotype ?? null,
      stateOfOrigin: dto.stateOfOrigin ?? null,
      lga: dto.lga ?? null,
      nationality: dto.nationality ?? 'Nigerian',
      religion: dto.religion ?? null,
      notes: dto.notes ?? null,
    };

    if (dto.studentId) {
      const created = await this.prisma.student.create({
        data: { ...data, studentId: dto.studentId },
        include: WITH_ARM,
      });
      return this.toDto(created);
    }

    return this.toDto(await this.createWithGeneratedNumber(data));
  }

  async list(query: QueryStudentsDto): Promise<PaginatedDto<StudentDto>> {
    const where = this.buildWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.student.findMany({
        where,
        orderBy:
          query.sortBy === 'lastName'
            ? // Registers read as a surname list, so break ties by first name.
              [{ lastName: query.sortOrder }, { firstName: query.sortOrder }]
            : [{ [query.sortBy]: query.sortOrder }],
        skip: query.skip,
        take: query.limit,
        include: WITH_ARM,
      }),
      this.prisma.student.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toDto(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(id: string): Promise<StudentProfileDto> {
    const found = await this.prisma.student.findUnique({
      where: { id },
      include: WITH_GUARDIANS,
    });

    if (!found) {
      throw AppException.notFound('Student');
    }

    return {
      ...this.toDto(found),
      guardians: found.guardians.map((link) => ({
        guardianId: link.guardian.id,
        fullName: `${link.guardian.firstName} ${link.guardian.lastName}`,
        phone: link.guardian.phone,
        email: link.guardian.email,
        relationship: link.relationship,
        isPrimary: link.isPrimary,
        canPickUp: link.canPickUp,
      })),
    };
  }

  async update(id: string, dto: UpdateStudentDto): Promise<StudentDto> {
    const existing = await this.getOrThrow(id);

    this.assertBornBeforeAdmission(
      dto.dateOfBirth !== undefined ? dto.dateOfBirth : existing.dateOfBirth,
      dto.admissionDate ?? existing.admissionDate,
    );

    // Only check room when the student is actually moving into a new arm.
    if (dto.classArmId && dto.classArmId !== existing.classArmId) {
      await this.arms.assertHasRoom(dto.classArmId);
    }

    const updated = await this.prisma.student.update({
      where: { id },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        middleName: dto.middleName,
        gender: dto.gender,
        dateOfBirth: dto.dateOfBirth,
        email: dto.email,
        phone: dto.phone,
        addressLine: dto.addressLine,
        photoUrl: dto.photoUrl,
        admissionDate: dto.admissionDate,
        classArmId: dto.classArmId,
        bloodGroup: dto.bloodGroup,
        genotype: dto.genotype,
        stateOfOrigin: dto.stateOfOrigin,
        lga: dto.lga,
        nationality: dto.nationality,
        religion: dto.religion,
        notes: dto.notes,
      },
      include: WITH_ARM,
    });

    return this.toDto(updated);
  }

  /**
   * Status is its own endpoint rather than a field on update, so leaving the
   * school is recorded as an event with a reason instead of a silent edit.
   */
  async changeStatus(
    id: string,
    dto: ChangeStudentStatusDto,
  ): Promise<StudentDto> {
    const existing = await this.getOrThrow(id);

    if (existing.status === dto.status) {
      throw AppException.conflict(`Student is already ${dto.status}`);
    }

    // Returning to ACTIVE has to fit in the arm the student still points at.
    if (dto.status === StudentStatus.ACTIVE && existing.classArmId) {
      await this.arms.assertHasRoom(existing.classArmId);
    }

    const updated = await this.prisma.student.update({
      where: { id },
      data: { status: dto.status },
      include: WITH_ARM,
    });

    return this.toDto(updated);
  }

  async remove(id: string): Promise<void> {
    await this.getOrThrow(id);
    // Guardian links cascade; finance and results do not exist yet. Schools
    // that want to keep the record should set a status instead.
    await this.prisma.student.delete({ where: { id } });
  }

  private buildWhere(query: QueryStudentsDto): Prisma.StudentWhereInput {
    const search = query.search?.trim();

    return {
      // A register means the students currently in the school, so ACTIVE is the
      // default; 'ALL' is the explicit opt-out.
      ...(query.status === 'ALL'
        ? {}
        : { status: query.status ?? StudentStatus.ACTIVE }),
      ...(query.classArmId ? { classArmId: query.classArmId } : {}),
      ...(query.classId ? { classArm: { classId: query.classId } } : {}),
      ...(query.gender ? { gender: query.gender } : {}),
      ...(query.unassigned === true ? { classArmId: null } : {}),
      ...(query.unassigned === false ? { classArmId: { not: null } } : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
              { middleName: { contains: search, mode: 'insensitive' } },
              { studentId: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  /**
   * Generating a number means reading the last one and writing the next, which
   * two concurrent admissions can do at the same instant. The unique index is
   * the real guard; this retries when it fires rather than failing the caller.
   */
  private async createWithGeneratedNumber(
    data: Omit<Prisma.StudentUncheckedCreateInput, 'studentId'>,
  ): Promise<StudentRow> {
    const year = data.admissionDate
      ? new Date(data.admissionDate).getUTCFullYear()
      : new Date().getUTCFullYear();

    for (let attempt = 0; attempt < ADMISSION_NUMBER_ATTEMPTS; attempt++) {
      const existing = await this.prisma.student.findMany({
        where: { studentId: { startsWith: `${year}/` } },
        select: { studentId: true },
      });

      const studentId = formatAdmissionNumber(
        year,
        nextSequence(
          existing.map((row) => row.studentId),
          year,
        ),
      );

      try {
        return await this.prisma.student.create({
          data: { ...data, studentId },
          include: WITH_ARM,
        });
      } catch (error) {
        if (!this.isUniqueViolation(error)) throw error;
      }
    }

    throw AppException.conflict(
      'Could not allocate an admission number. Please retry.',
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private async getOrThrow(id: string): Promise<StudentRow> {
    const found = await this.prisma.student.findUnique({
      where: { id },
      include: WITH_ARM,
    });

    if (!found) {
      throw AppException.notFound('Student');
    }

    return found;
  }

  private async assertAdmissionNumberFree(studentId: string): Promise<void> {
    const clash = await this.prisma.student.findFirst({
      where: { studentId },
      select: { id: true },
    });

    if (clash) {
      throw AppException.duplicate(
        `Admission number "${studentId}" is already in use`,
      );
    }
  }

  private assertBornBeforeAdmission(
    dateOfBirth: Date | null,
    admissionDate: Date,
  ): void {
    if (!dateOfBirth) return;

    if (dateOfBirth.getTime() >= admissionDate.getTime()) {
      throw AppException.badRequest(
        'dateOfBirth must be before admissionDate',
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  private toDto(row: StudentRow | ProfileRow): StudentDto {
    const middle = row.middleName ? ` ${row.middleName}` : '';

    return {
      id: row.id,
      studentId: row.studentId,
      firstName: row.firstName,
      lastName: row.lastName,
      middleName: row.middleName,
      fullName: `${row.lastName}, ${row.firstName}${middle}`,
      gender: row.gender,
      dateOfBirth: row.dateOfBirth,
      email: row.email,
      phone: row.phone,
      addressLine: row.addressLine,
      photoUrl: row.photoUrl,
      admissionDate: row.admissionDate,
      status: row.status,
      classArmId: row.classArmId,
      className: row.classArm
        ? `${row.classArm.class.name} ${row.classArm.name}`
        : null,
      bloodGroup: row.bloodGroup,
      genotype: row.genotype,
      stateOfOrigin: row.stateOfOrigin,
      lga: row.lga,
      nationality: row.nationality,
      religion: row.religion,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
