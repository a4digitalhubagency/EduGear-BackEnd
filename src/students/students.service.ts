import { Injectable } from '@nestjs/common';
import {
  ConsentMethod,
  FilePurpose,
  Prisma,
  StudentStatus,
} from '@prisma/client';
import { ClassArmsService } from '../academics/class-arms.service';
import { FilesService } from '../files/files.service';
import { SchoolSettingsService } from '../tenants/school-settings.service';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { formatAdmissionNumber, nextSequence } from './admission-number';
import {
  blankSensitiveToNull,
  clearSensitiveFields,
  consentColumns,
  hasSensitiveConsent,
  populatedSensitiveFields,
  SENSITIVE_STUDENT_FIELDS,
  sensitiveFieldsNeedingConsent,
  withdrawSensitiveConsent,
} from './sensitive-fields';
import {
  BulkAdmitResultDto,
  BulkAdmitStudentsDto,
  PromoteStudentsDto,
  PromotionResultDto,
} from './dto/bulk.dto';
import { ImportOptions, StudentImportService } from './student-import.service';
import {
  AdmitStudentDto,
  ChangeStudentStatusDto,
  QueryStudentsDto,
  SensitiveDataConsentDto,
  SensitiveDataErasureDto,
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

/**
 * The consent columns, as a shape assignable to both a create and an update.
 *
 * Prisma's own update input is not: it allows `{ set: … }` operation objects
 * for every field, which makes the result unusable on the create path. Naming
 * the four columns here keeps one helper serving both writes.
 */
type ConsentColumns = {
  sensitiveConsentAt?: Date | null;
  sensitiveConsentBy?: string | null;
  sensitiveConsentMethod?: ConsentMethod | null;
  sensitiveConsentWithdrawnAt?: Date | null;
};

/** Retries cover the window between reading the last number and writing it. */
const ADMISSION_NUMBER_ATTEMPTS = 5;

@Injectable()
export class StudentsService {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly arms: ClassArmsService,
    private readonly importer: StudentImportService,
    private readonly settings: SchoolSettingsService,
    private readonly files: FilesService,
  ) {}

  async admit(dto: AdmitStudentDto, schoolId: string): Promise<StudentDto> {
    this.assertBornBeforeAdmission(dto.dateOfBirth ?? null, dto.admissionDate);

    if (dto.studentId) {
      await this.assertAdmissionNumberFree(dto.studentId);
    }

    // On admission there is nothing on record yet, so the consent has to be in
    // this payload or the sensitive fields are refused.
    const sensitive = blankSensitiveToNull(dto);
    const consent = this.resolveConsent(
      sensitive,
      dto.sensitiveDataConsent,
      null,
    );

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
      bloodGroup: sensitive.bloodGroup ?? null,
      genotype: sensitive.genotype ?? null,
      stateOfOrigin: sensitive.stateOfOrigin ?? null,
      lga: sensitive.lga ?? null,
      nationality: dto.nationality ?? 'Nigerian',
      religion: sensitive.religion ?? null,
      notes: dto.notes ?? null,
      ...consent,
    };

    if (dto.studentId) {
      const supplied = dto.studentId;
      const created = await this.prisma.$transaction(async (tx) => {
        if (dto.classArmId)
          await this.arms.assertHasRoom(dto.classArmId, 1, tx);
        return tx.student.create({
          data: { ...data, studentId: supplied },
          include: WITH_ARM,
        });
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

    // Consent already on the row counts, so a school that collected it at
    // admission is not asked again every time a genotype is corrected.
    const sensitive = blankSensitiveToNull(dto);
    const consent = this.resolveConsent(
      sensitive,
      dto.sensitiveDataConsent,
      existing,
    );

    // Only check room when the student is actually moving into a new arm —
    // and do it under the arm's lock so the move cannot overfill it.
    const moving =
      dto.classArmId && dto.classArmId !== existing.classArmId
        ? dto.classArmId
        : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (moving) await this.arms.assertHasRoom(moving, 1, tx);

      return tx.student.update({
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
          bloodGroup: sensitive.bloodGroup,
          genotype: sensitive.genotype,
          stateOfOrigin: sensitive.stateOfOrigin,
          lga: sensitive.lga,
          nationality: dto.nationality,
          religion: sensitive.religion,
          notes: dto.notes,
          ...consent,
        },
        include: WITH_ARM,
      });
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

    const returningTo =
      dto.status === StudentStatus.ACTIVE ? existing.classArmId : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Returning to ACTIVE has to fit in the arm the student still points at.
      if (returningTo) await this.arms.assertHasRoom(returningTo, 1, tx);

      return tx.student.update({
        where: { id },
        data: {
          status: dto.status,
          // Stamped here rather than inferred from `updatedAt`, which any
          // later edit would reset — and a reset clock means the surplus
          // data is never destroyed.
          departedAt: dto.status === StudentStatus.ACTIVE ? null : new Date(),
        },
        include: WITH_ARM,
      });
    });

    return this.toDto(updated);
  }

  /** Stores the photo, points the student at it, and drops the old one. */
  async setPhoto(
    id: string,
    file: Express.Multer.File | undefined,
    schoolId: string,
  ): Promise<StudentDto> {
    await this.getOrThrow(id);
    if (!file) {
      throw AppException.badRequest(
        'No photo was attached — send it as the "file" part',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const uploaded = await this.files.replaceLinked(
      FilePurpose.STUDENT_PHOTO,
      { type: 'Student', id },
      {
        buffer: file.buffer,
        originalName: file.originalname,
        declaredType: file.mimetype,
      },
      schoolId,
    );

    const updated = await this.prisma.student.update({
      where: { id },
      data: { photoUrl: uploaded.url },
      include: WITH_ARM,
    });
    return this.toDto(updated);
  }

  async removePhoto(id: string): Promise<StudentDto> {
    await this.getOrThrow(id);
    await this.files.removeLinked(FilePurpose.STUDENT_PHOTO, {
      type: 'Student',
      id,
    });

    const updated = await this.prisma.student.update({
      where: { id },
      data: { photoUrl: null },
      include: WITH_ARM,
    });
    return this.toDto(updated);
  }

  /**
   * Erases the student's sensitive personal data — genotype, blood group,
   * religion, state of origin and LGA — and nothing else.
   *
   * **Unconditional, by design.** Every other field on the record is held under
   * a basis the school cannot simply be asked to abandon: performance of the
   * contract, or a legal obligation to keep the record. These five are held
   * under *consent* (s.30(1)(a), given by a parent under s.31(1)), and s.35(2)
   * requires withdrawal to be as easy as consent was to give. So there is no
   * balancing test here and no competing basis to weigh — the request is
   * honoured, immediately.
   *
   * Erasing all five together rather than one at a time is deliberate: they
   * share a single lawful basis, so withdrawing consent withdraws it for the
   * set. It also means a parent does not have to know the field names to
   * exercise the right.
   *
   * Succeeds when there is nothing to erase. A request that reports "already
   * clear" and one that reports "erased" are both the right answer to "stop
   * holding this", and failing the second attempt would make the right
   * awkward to exercise for no benefit.
   */
  async eraseSensitiveData(id: string): Promise<SensitiveDataErasureDto> {
    const existing = await this.getOrThrow(id);
    const erasedFields = populatedSensitiveFields(existing);
    const consentWithdrawn = hasSensitiveConsent(existing);

    // Nothing held and no consent on file: already in the state being asked
    // for. Note the second half of that condition — a school can tick the box
    // before entering any values, and withdrawing then has to drop the record
    // even though there is no data to erase, or the school is left claiming a
    // basis a parent has revoked.
    if (erasedFields.length === 0 && !consentWithdrawn) {
      return {
        student: this.toDto(existing),
        erasedFields: [],
        consentWithdrawn: false,
      };
    }

    const updated = await this.prisma.student.update({
      where: { id },
      // The values and the record of why they were lawful go together, in one
      // write. Either alone leaves the row misdescribing itself.
      data: {
        ...clearSensitiveFields(),
        ...withdrawSensitiveConsent(new Date()),
      },
      include: WITH_ARM,
    });

    return { student: this.toDto(updated), erasedFields, consentWithdrawn };
  }

  async remove(id: string): Promise<void> {
    await this.getOrThrow(id);

    // Invoices and payments cascade from the student at the database level,
    // so deleting an invoiced student would erase money history. A status
    // change keeps the record and takes the student off every roll.
    const [invoices, payments, scores, results, attendance] = await Promise.all(
      [
        this.prisma.studentFee.count({ where: { studentId: id } }),
        this.prisma.payment.count({ where: { studentId: id } }),
        this.prisma.score.count({ where: { studentId: id } }),
        this.prisma.studentResult.count({ where: { studentId: id } }),
        this.prisma.attendanceRecord.count({ where: { studentId: id } }),
      ],
    );
    if (invoices > 0 || payments > 0) {
      throw AppException.conflict(
        'This student has financial records and cannot be deleted. Change their status to WITHDRAWN or TRANSFERRED instead.',
      );
    }
    // Scores and results cascade from the student too — an academic record.
    if (scores > 0 || results > 0 || attendance > 0) {
      throw AppException.conflict(
        'This student has scores, results or attendance and cannot be deleted. Change their status to WITHDRAWN or TRANSFERRED instead.',
      );
    }

    // The photo has no meaning without the student.
    await this.files.removeLinked(FilePurpose.STUDENT_PHOTO, {
      type: 'Student',
      id,
    });
    await this.prisma.student.delete({ where: { id } });
  }

  /**
   * The original all-or-nothing bulk endpoint. It now runs through the import
   * pipeline — one implementation of the rules, not two — and returns the
   * admitted students in the order they were sent.
   */
  async bulkAdmit(
    dto: BulkAdmitStudentsDto,
    options: Omit<ImportOptions, 'mode' | 'dryRun'>,
    schoolId: string,
  ): Promise<BulkAdmitResultDto> {
    const ids = await this.importer.legacyBulk(dto, options, schoolId);

    const rows = await this.prisma.student.findMany({
      where: { id: { in: ids } },
      include: WITH_ARM,
    });
    const order = new Map(ids.map((id, index) => [id, index]));
    rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

    return {
      imported: rows.length,
      students: rows.map((row) => this.toDto(row)),
    };
  }

  /**
   * End-of-session movement: the whole arm steps up together, or leaves.
   * Only ACTIVE students move — a withdrawn student should not reappear in
   * next year's register.
   */
  async promote(dto: PromoteStudentsDto): Promise<PromotionResultDto> {
    const graduating = dto.graduate === true;

    if (graduating === Boolean(dto.toClassArmId)) {
      throw AppException.badRequest(
        'Provide either toClassArmId or graduate: true, not both',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (dto.toClassArmId === dto.fromClassArmId) {
      throw AppException.badRequest(
        'toClassArmId must differ from fromClassArmId',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const from = await this.arms.describe(dto.fromClassArmId);
    const to = dto.toClassArmId
      ? await this.arms.describe(dto.toClassArmId)
      : null;

    const movers = await this.prisma.student.findMany({
      where: {
        classArmId: dto.fromClassArmId,
        status: StudentStatus.ACTIVE,
        ...(dto.studentIds ? { id: { in: dto.studentIds } } : {}),
      },
      select: { id: true },
    });

    // Checked before the empty case: when the caller named students, telling
    // them the names are wrong beats telling them the arm is empty.
    if (dto.studentIds && movers.length !== dto.studentIds.length) {
      throw AppException.badRequest(
        `Some students are not active in ${from}`,
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (movers.length === 0) {
      throw AppException.conflict(`No active students to move out of ${from}`);
    }

    const ids = movers.map((row) => row.id);
    const target = dto.toClassArmId;

    await this.prisma.$transaction(async (tx) => {
      if (target) await this.arms.assertHasRoom(target, ids.length, tx);

      await tx.student.updateMany({
        // Re-asserting the source and status inside the transaction means a
        // student withdrawn a moment ago is not swept along with the arm.
        where: {
          id: { in: ids },
          classArmId: dto.fromClassArmId,
          status: StudentStatus.ACTIVE,
        },
        data: graduating
          ? // Graduates keep their record but leave the roll entirely. The
            // departure is stamped here too — graduating through promotion is
            // the *common* way to leave, so missing it here would mean whole
            // year groups never became due for minimisation.
            {
              status: StudentStatus.GRADUATED,
              classArmId: null,
              departedAt: new Date(),
            }
          : { classArmId: target },
      });
    });

    return {
      promoted: graduating ? 0 : ids.length,
      graduated: graduating ? ids.length : 0,
      from,
      to,
    };
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
      // "Holds something sensitive, has no consent for it" — the gap a school
      // migrating off paper has to close. Built from the field list so a new
      // sensitive column joins the query without being remembered here.
      //
      // `{ not: null }` is exact because blanks are normalised to null on
      // write (see blankSensitiveToNull): without that, a row holding `''`
      // would appear on this list with nothing on it to fix.
      ...(query.sensitiveConsentMissing === true
        ? {
            sensitiveConsentAt: null,
            OR: SENSITIVE_STUDENT_FIELDS.map((field) => ({
              [field]: { not: null },
            })),
          }
        : {}),
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
        (await this.settings.current()).admissionNumberPrefix,
      );

      try {
        // Each attempt is its own transaction: a unique violation aborts it,
        // and the arm lock is released so the retry can take it again.
        return await this.prisma.$transaction(async (tx) => {
          if (data.classArmId) {
            await this.arms.assertHasRoom(data.classArmId, 1, tx);
          }
          return tx.student.create({
            data: { ...data, studentId },
            include: WITH_ARM,
          });
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

  /**
   * Turns the consent block (or its absence) into the columns to write, and
   * refuses the write when a sensitive field would be set without one.
   *
   * This is the single gate. Both the admission path and the update path go
   * through it, because the alternative — checking in one and trusting the
   * other — is how a field ends up writable by whichever route was forgotten.
   *
   * Three cases:
   *
   * 1. **Consent supplied.** Recorded, replacing anything there and clearing
   *    any earlier withdrawal. A school re-sending it is correcting a name or
   *    logging a re-signed form, and both should land.
   * 2. **Not supplied, nothing sensitive being set.** No consent columns are
   *    touched at all. An ordinary edit to a phone number must not disturb the
   *    consent record, and must not be blocked by its absence.
   * 3. **Not supplied, something sensitive being set, nothing on record.**
   *    Refused, naming the fields — the frontend turns that into the tick-box.
   */
  private resolveConsent(
    payload: Parameters<typeof sensitiveFieldsNeedingConsent>[0],
    supplied: SensitiveDataConsentDto | undefined,
    existing: { sensitiveConsentAt: Date | null } | null,
  ): ConsentColumns {
    if (supplied) {
      const givenAt = supplied.givenAt ?? new Date();

      // A consent dated in the future is either a typo or an attempt to make
      // a record look collected before it was. Neither should be stored.
      if (givenAt.getTime() > Date.now()) {
        throw AppException.badRequest(
          'sensitiveDataConsent.givenAt cannot be in the future',
          ErrorCode.VALIDATION_ERROR,
        );
      }

      return consentColumns(
        { method: supplied.method, givenBy: supplied.givenBy, givenAt },
        givenAt,
      );
    }

    const needed = sensitiveFieldsNeedingConsent(payload, existing);
    if (needed.length > 0) {
      throw AppException.badRequest(
        `Recording ${needed.join(', ')} needs the parent’s consent. Send ` +
          'sensitiveDataConsent with this request, or leave these fields ' +
          'blank — the rest of the record does not need it.',
        ErrorCode.CONSENT_REQUIRED,
      );
    }

    return {};
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
      sensitiveDataConsent: row.sensitiveConsentAt
        ? {
            givenAt: row.sensitiveConsentAt,
            givenBy: row.sensitiveConsentBy,
            method: row.sensitiveConsentMethod,
          }
        : null,
      sensitiveDataConsentWithdrawnAt: row.sensitiveConsentWithdrawnAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
