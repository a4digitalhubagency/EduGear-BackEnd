import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { isEmail, validate } from 'class-validator';
import { Prisma, StudentStatus } from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma, TxClient } from '../database/prisma.service';
import { lockRows } from '../database/row-lock';
import { NG_PHONE_REGEX } from '../tenants/dto/school.dto';
import { SchoolSettingsService } from '../tenants/school-settings.service';
import { formatAdmissionNumber, nextSequence } from './admission-number';
import { BulkAdmitStudentsDto, MAX_BULK_STUDENTS } from './dto/bulk.dto';
import {
  ImportMode,
  ImportOutcome,
  ImportReportDto,
  ImportRowStatus,
  ImportStudentsCsvDto,
  ImportStudentsDto,
} from './dto/import.dto';
import { AdmitStudentDto } from './dto/student.dto';
import { CsvParseError, parseCsv } from './import/csv';
import {
  IMPORT_COLUMNS,
  ImportField,
  mapHeaders,
} from './import/import-columns';
import {
  NormalisedRow,
  armKey,
  canonicalPhone,
  normaliseRow,
  phoneVariants,
} from './import/import-row';

/** What went wrong, and which HTTP status it maps to on the legacy endpoint. */
type IssueKind = 'INVALID' | 'DUPLICATE' | 'NOT_FOUND' | 'FULL' | 'FORBIDDEN';

interface Issue {
  field: string;
  message: string;
  kind: IssueKind;
}

interface ArmInfo {
  id: string;
  label: string;
  capacity: number | null;
  active: number;
}

type GuardianRef =
  { kind: 'EXISTING'; id: string } | { kind: 'NEW'; key: string };

interface PendingGuardian {
  key: string;
  row: number;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
}

interface RowState {
  row: number;
  line: number | null;
  data: NormalisedRow;
  errors: Issue[];
  warnings: string[];
  arm: ArmInfo | null;
  guardianRef: GuardianRef | null;
  guardianOutcome: 'CREATED' | 'MATCHED' | 'SHARED' | null;
  admissionNumber: string | null;
  studentDbId: string | null;
  written: boolean;
}

interface ImportRecord {
  row: number;
  line: number | null;
  raw: Partial<Record<ImportField, unknown>>;
}

export interface ImportOptions {
  mode: ImportMode;
  dryRun?: boolean;
  defaultAdmissionDate?: Date;
  defaultClassArmId?: string;
  /** What the caller may do with parent records, from their permissions. */
  canCreateGuardians: boolean;
  canLinkGuardians: boolean;
}

const LABELS = new Map<string, string>(
  IMPORT_COLUMNS.map((column) => [column.key, column.label]),
);
const label = (field: string) => LABELS.get(field) ?? field;
const KNOWN_FIELDS = new Set<string>(
  IMPORT_COLUMNS.map((column) => column.key),
);

const WRITE_ATTEMPTS = 3;

/**
 * Student import from a spreadsheet or JSON rows.
 *
 * Every row is checked before anything is written, and every problem on every
 * row is reported — a registrar fixing a 300-line file needs the whole list,
 * not one error per attempt. Then, by mode: ATOMIC writes all or nothing,
 * PARTIAL writes the good rows, and a dry run writes nothing and shows exactly
 * what would happen, down to the admission numbers.
 */
@Injectable()
export class StudentImportService {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly settings: SchoolSettingsService,
  ) {}

  async importRows(
    dto: ImportStudentsDto,
    options: ImportOptions,
    schoolId: string,
  ): Promise<ImportReportDto> {
    const unknown = new Set<string>();
    const records = dto.rows.map((raw, index) => {
      const picked: Partial<Record<ImportField, unknown>> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (KNOWN_FIELDS.has(key)) picked[key as ImportField] = value;
        else unknown.add(key);
      }
      return { row: index + 1, line: null, raw: picked };
    });

    const fileWarnings = unknown.size
      ? [`Ignored field(s) we don't recognise: ${[...unknown].join(', ')}`]
      : [];

    return (await this.execute(records, options, fileWarnings, schoolId))
      .report;
  }

  async importCsv(
    dto: ImportStudentsCsvDto,
    options: ImportOptions,
    schoolId: string,
  ): Promise<ImportReportDto> {
    let parsed: ReturnType<typeof parseCsv>;
    try {
      parsed = parseCsv(dto.csv);
    } catch (error) {
      if (error instanceof CsvParseError) {
        throw AppException.badRequest(
          error.message,
          ErrorCode.VALIDATION_ERROR,
        );
      }
      throw error;
    }

    const mapping = mapHeaders(parsed.headers);
    if (mapping.missingRequired.length > 0) {
      throw AppException.badRequest(
        `The file is missing required column(s): ${mapping.missingRequired.join(', ')}. Download the template for the expected layout.`,
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (parsed.rows.length === 0) {
      throw AppException.badRequest(
        'The file has a header row but no students',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (parsed.rows.length > MAX_BULK_STUDENTS) {
      throw AppException.badRequest(
        `At most ${MAX_BULK_STUDENTS} students can be imported at once; this file has ${parsed.rows.length}. Split it and import each part.`,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const fileWarnings: string[] = [];
    if (mapping.unknown.length) {
      fileWarnings.push(
        `Ignored column(s) we don't recognise: ${mapping.unknown.join(', ')}`,
      );
    }
    if (mapping.duplicates.length) {
      fileWarnings.push(
        `Ignored repeated column(s): ${mapping.duplicates.join(', ')}`,
      );
    }

    const records: ImportRecord[] = parsed.rows.map((row, index) => {
      const raw: Partial<Record<ImportField, unknown>> = {};
      mapping.fields.forEach((field, position) => {
        if (field) raw[field] = row.values[position] ?? '';
      });
      return { row: index + 1, line: row.line, raw };
    });

    return (await this.execute(records, options, fileWarnings, schoolId))
      .report;
  }

  /**
   * POST /students/bulk, kept for existing callers: always atomic, and a
   * failure becomes an exception naming the first offending row.
   */
  async legacyBulk(
    dto: BulkAdmitStudentsDto,
    options: Omit<ImportOptions, 'mode' | 'dryRun'>,
    schoolId: string,
  ): Promise<string[]> {
    const records: ImportRecord[] = dto.students.map((student, index) => ({
      row: index + 1,
      line: null,
      raw: { ...student },
    }));

    const { states } = await this.execute(
      records,
      { ...options, mode: ImportMode.ATOMIC, dryRun: false },
      [],
      schoolId,
    );

    const failing = states.find((state) => state.errors.length > 0);
    if (failing) {
      const issue = failing.errors[0];
      const message = `Row ${failing.row}: ${issue.message}`;
      switch (issue.kind) {
        case 'DUPLICATE':
          throw AppException.duplicate(message);
        case 'FULL':
          throw AppException.conflict(message);
        case 'NOT_FOUND':
          throw AppException.notFound(message);
        case 'FORBIDDEN':
          throw AppException.forbidden(
            message,
            ErrorCode.INSUFFICIENT_PERMISSIONS,
          );
        default:
          throw AppException.badRequest(message, ErrorCode.VALIDATION_ERROR);
      }
    }

    return states
      .map((state) => state.studentDbId)
      .filter((id): id is string => id !== null);
  }

  // ---------------------------------------------------------------------------
  // Pipeline
  // ---------------------------------------------------------------------------

  private async execute(
    records: ImportRecord[],
    options: ImportOptions,
    fileWarnings: string[],
    schoolId: string,
  ): Promise<{ report: ImportReportDto; states: RowState[] }> {
    const states = await Promise.all(
      records.map((record) => this.checkShape(record, options)),
    );

    await this.resolveArms(states);
    this.checkDates(states);
    await this.checkAdmissionNumbers(states);
    await this.warnPossibleDuplicates(states);
    const pending = await this.resolveGuardians(states, options);
    this.checkCapacity(states);

    const failed = states.filter((state) => state.errors.length > 0);
    const valid = states.filter((state) => state.errors.length === 0);

    let toWrite: RowState[] = [];
    if (!options.dryRun) {
      toWrite =
        options.mode === ImportMode.ATOMIC && failed.length > 0 ? [] : valid;
    }

    let guardiansCreated = 0;
    if (toWrite.length > 0) {
      guardiansCreated = await this.write(toWrite, pending, schoolId);
    } else if (options.dryRun && valid.length > 0) {
      // Show the numbers these rows would get. They are a preview: another
      // admission in the meantime can move them along.
      const numbers = await this.allocateNumbers(this.prisma, valid);
      valid.forEach((state, index) => (state.admissionNumber = numbers[index]));
    }

    const imported = states.filter((state) => state.written).length;
    const outcome = options.dryRun
      ? ImportOutcome.VALIDATED
      : imported === 0
        ? ImportOutcome.REJECTED
        : failed.length > 0
          ? ImportOutcome.PARTIAL
          : ImportOutcome.IMPORTED;

    const report: ImportReportDto = {
      outcome,
      mode: options.mode,
      dryRun: options.dryRun ?? false,
      total: states.length,
      imported,
      valid: valid.length - imported,
      failed: failed.length,
      guardiansCreated,
      guardiansMatched: states.filter(
        (state) =>
          state.errors.length === 0 && state.guardianOutcome === 'MATCHED',
      ).length,
      fileWarnings,
      rows: states.map((state) => ({
        row: state.row,
        line: state.line,
        status: state.written
          ? ImportRowStatus.IMPORTED
          : state.errors.length > 0
            ? ImportRowStatus.FAILED
            : ImportRowStatus.VALID,
        studentName:
          state.data.firstName && state.data.lastName
            ? `${state.data.lastName}, ${state.data.firstName}`
            : null,
        admissionNumber: state.admissionNumber,
        studentId: state.studentDbId,
        className: state.arm?.label ?? null,
        guardian: state.guardianOutcome,
        errors: state.errors.map(({ field, message }) => ({ field, message })),
        warnings: state.warnings,
      })),
    };

    return { report, states };
  }

  /** Normalise, apply file defaults, then validate against the admission rules. */
  private async checkShape(
    record: ImportRecord,
    options: ImportOptions,
  ): Promise<RowState> {
    const { row: data, issues } = normaliseRow(record.raw);
    const errors: Issue[] = issues.map((issue) => ({
      field: issue.field,
      message: `${label(issue.field)}: ${issue.message}`,
      kind: 'INVALID',
    }));

    if (!data.admissionDate && options.defaultAdmissionDate) {
      data.admissionDate = options.defaultAdmissionDate;
    }
    if (!data.classArm && !data.classArmId && options.defaultClassArmId) {
      data.classArmId = options.defaultClassArmId;
    }

    const reported = new Set(errors.map((error) => error.field));
    for (const field of ['firstName', 'lastName', 'gender'] as const) {
      if (!data[field] && !reported.has(field)) {
        errors.push({
          field,
          message: `${label(field)} is required`,
          kind: 'INVALID',
        });
      }
    }
    if (!data.admissionDate && !reported.has('admissionDate')) {
      errors.push({
        field: 'admissionDate',
        message:
          'Admission Date is required — add the column, or set a default admission date for the file',
        kind: 'INVALID',
      });
    }

    // The same validator admission uses, so an import can never accept what
    // the single-student form would refuse. Missing fields are handled above.
    const candidate = plainToInstance(AdmitStudentDto, {
      studentId: data.studentId,
      firstName: data.firstName,
      lastName: data.lastName,
      middleName: data.middleName,
      gender: data.gender,
      dateOfBirth: data.dateOfBirth,
      admissionDate: data.admissionDate,
      classArmId: data.classArmId,
      email: data.email,
      phone: data.phone,
      addressLine: data.addressLine,
      stateOfOrigin: data.stateOfOrigin,
      lga: data.lga,
      nationality: data.nationality,
      religion: data.religion,
      bloodGroup: data.bloodGroup,
      genotype: data.genotype,
      notes: data.notes,
    });
    for (const failure of await validate(candidate, {
      skipMissingProperties: true,
    })) {
      if (reported.has(failure.property)) continue;
      const first = Object.values(failure.constraints ?? {})[0];
      if (!first) continue;
      errors.push({
        field: failure.property,
        message: first.replace(/^\w+/, label(failure.property)),
        kind: 'INVALID',
      });
    }

    this.checkGuardianShape(data, errors);

    return {
      row: record.row,
      line: record.line,
      data,
      errors,
      warnings: [],
      arm: null,
      guardianRef: null,
      guardianOutcome: null,
      admissionNumber: data.studentId ?? null,
      studentDbId: null,
      written: false,
    };
  }

  private checkGuardianShape(data: NormalisedRow, errors: Issue[]): void {
    const guardian = data.guardian;
    if (!guardian) return;

    const reported = new Set(errors.map((error) => error.field));
    const add = (field: string, message: string) =>
      errors.push({ field, message, kind: 'INVALID' });

    if (
      (!guardian.firstName || !guardian.lastName) &&
      !reported.has('guardianName')
    ) {
      add('guardianName', 'Parent Name is required when a parent is given');
    }
    for (const [field, value] of [
      ['guardianFirstName', guardian.firstName],
      ['guardianLastName', guardian.lastName],
    ] as const) {
      if (value && value.length > 80) add(field, `${label(field)} is too long`);
    }

    if (!guardian.phone) {
      add(
        'guardianPhone',
        'Parent Phone is required when a parent is given — it is how the school reaches them',
      );
    } else if (!NG_PHONE_REGEX.test(guardian.phone)) {
      add(
        'guardianPhone',
        'Parent Phone must be a valid Nigerian phone number',
      );
    }

    if (guardian.email && !isEmail(guardian.email)) {
      add('guardianEmail', 'Parent Email is not a valid email address');
    }
  }

  /** Classes are matched the way a school writes them: "JSS1 A", "jss 1a". */
  private async resolveArms(states: RowState[]): Promise<void> {
    const arms = await this.prisma.classArm.findMany({
      select: {
        id: true,
        name: true,
        capacity: true,
        class: { select: { name: true } },
        _count: {
          select: { students: { where: { status: StudentStatus.ACTIVE } } },
        },
      },
    });

    const byId = new Map<string, ArmInfo>();
    const byLabel = new Map<string, ArmInfo[]>();
    for (const arm of arms) {
      const info: ArmInfo = {
        id: arm.id,
        label: `${arm.class.name} ${arm.name}`,
        capacity: arm.capacity,
        active: arm._count.students,
      };
      byId.set(arm.id, info);
      const key = armKey(info.label);
      byLabel.set(key, [...(byLabel.get(key) ?? []), info]);
    }

    for (const state of states) {
      const { classArm, classArmId } = state.data;
      let resolved: ArmInfo | null = null;

      if (classArmId) {
        resolved = byId.get(classArmId) ?? null;
        if (!resolved) {
          state.errors.push({
            field: 'classArmId',
            message: 'Class arm not found',
            kind: 'NOT_FOUND',
          });
          continue;
        }
      }

      if (classArm) {
        const matches = byLabel.get(armKey(classArm)) ?? [];
        if (matches.length === 0) {
          state.errors.push({
            field: 'classArm',
            message: `Class "${classArm}" does not exist. Create it under Academics, or check the spelling.`,
            kind: 'NOT_FOUND',
          });
          continue;
        }
        if (matches.length > 1) {
          state.errors.push({
            field: 'classArm',
            message: `Class "${classArm}" matches more than one arm (${matches.map((m) => m.label).join(', ')})`,
            kind: 'INVALID',
          });
          continue;
        }
        if (resolved && resolved.id !== matches[0].id) {
          state.errors.push({
            field: 'classArm',
            message: `Class "${classArm}" disagrees with the class arm id given on the same row`,
            kind: 'INVALID',
          });
          continue;
        }
        resolved = matches[0];
      }

      state.arm = resolved;
    }
  }

  private checkDates(states: RowState[]): void {
    for (const state of states) {
      const { dateOfBirth, admissionDate } = state.data;
      if (dateOfBirth && admissionDate && dateOfBirth >= admissionDate) {
        state.errors.push({
          field: 'dateOfBirth',
          message: 'Date of Birth must be before Admission Date',
          kind: 'INVALID',
        });
      }
    }
  }

  private async checkAdmissionNumbers(states: RowState[]): Promise<void> {
    const firstSeen = new Map<string, number>();

    for (const state of states) {
      const number = state.data.studentId;
      if (!number) continue;

      const earlier = firstSeen.get(number);
      if (earlier !== undefined) {
        state.errors.push({
          field: 'studentId',
          message: `Admission number "${number}" appears twice in this file (first on row ${earlier})`,
          kind: 'DUPLICATE',
        });
      } else {
        firstSeen.set(number, state.row);
      }
    }

    if (firstSeen.size === 0) return;

    const taken = await this.prisma.student.findMany({
      where: { studentId: { in: [...firstSeen.keys()] } },
      select: { studentId: true },
    });
    const takenSet = new Set(taken.map((row) => row.studentId));

    for (const state of states) {
      const number = state.data.studentId;
      if (number && takenSet.has(number)) {
        state.errors.push({
          field: 'studentId',
          message: `Admission number already in use: ${number}`,
          kind: 'DUPLICATE',
        });
      }
    }
  }

  /**
   * Same name and date of birth as a student already on file — or earlier in
   * this file — is very likely the same child entered twice. Worth a warning;
   * not an error, because twins and namesakes exist.
   */
  private async warnPossibleDuplicates(states: RowState[]): Promise<void> {
    const candidates = states.filter(
      (state) =>
        state.data.firstName && state.data.lastName && state.data.dateOfBirth,
    );
    if (candidates.length === 0) return;

    const surnames = [
      ...new Set(candidates.map((state) => state.data.lastName!.toLowerCase())),
    ];
    const existing = await this.prisma.student.findMany({
      where: {
        OR: surnames.map((surname) => ({
          lastName: { equals: surname, mode: 'insensitive' as const },
        })),
      },
      select: {
        studentId: true,
        firstName: true,
        lastName: true,
        dateOfBirth: true,
      },
    });

    const identity = (first: string, last: string, dob: Date) =>
      `${first.toLowerCase()}|${last.toLowerCase()}|${dob.toISOString().slice(0, 10)}`;

    const onFile = new Map<string, string>();
    for (const student of existing) {
      if (!student.dateOfBirth) continue;
      onFile.set(
        identity(student.firstName, student.lastName, student.dateOfBirth),
        student.studentId,
      );
    }

    const inFile = new Map<string, number>();
    for (const state of candidates) {
      const key = identity(
        state.data.firstName!,
        state.data.lastName!,
        state.data.dateOfBirth!,
      );

      const existingNumber = onFile.get(key);
      if (existingNumber) {
        state.warnings.push(
          `Possibly already on file as ${existingNumber} (same name and date of birth)`,
        );
      }
      const earlier = inFile.get(key);
      if (earlier !== undefined) {
        state.warnings.push(
          `Same name and date of birth as row ${earlier} — check this is not the same child twice`,
        );
      } else {
        inFile.set(key, state.row);
      }
    }
  }

  /**
   * Parents are matched by phone first — the one thing a school always has and
   * a parent rarely changes — then by email. Siblings in the same file sharing a
   * phone share one parent record rather than creating one each.
   */
  private async resolveGuardians(
    states: RowState[],
    options: ImportOptions,
  ): Promise<Map<string, PendingGuardian>> {
    const pending = new Map<string, PendingGuardian>();
    const withGuardian = states.filter(
      (state) =>
        state.data.guardian &&
        !state.errors.some((error) => error.field.startsWith('guardian')),
    );
    if (withGuardian.length === 0) return pending;

    const phones = withGuardian.flatMap((state) =>
      phoneVariants(state.data.guardian!.phone!),
    );
    const emails = withGuardian
      .map((state) => state.data.guardian!.email)
      .filter((email): email is string => Boolean(email));

    const existing = await this.prisma.guardian.findMany({
      where: {
        OR: [
          { phone: { in: phones } },
          ...(emails.length
            ? [{ email: { in: emails, mode: 'insensitive' as const } }]
            : []),
        ],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
      },
    });

    const byPhone = new Map(existing.map((g) => [canonicalPhone(g.phone), g]));
    const byEmail = new Map(
      existing.filter((g) => g.email).map((g) => [g.email!.toLowerCase(), g]),
    );
    const newEmailOwner = new Map<string, PendingGuardian>();

    for (const state of withGuardian) {
      const guardian = state.data.guardian!;
      const key = canonicalPhone(guardian.phone!);
      const fullName = `${guardian.firstName} ${guardian.lastName}`;

      const phoneMatch = byPhone.get(key);
      const emailMatch = guardian.email
        ? byEmail.get(guardian.email)
        : undefined;

      if (phoneMatch && emailMatch && phoneMatch.id !== emailMatch.id) {
        state.errors.push({
          field: 'guardianEmail',
          message: `Parent Phone belongs to ${phoneMatch.firstName} ${phoneMatch.lastName} but Parent Email belongs to ${emailMatch.firstName} ${emailMatch.lastName}`,
          kind: 'INVALID',
        });
        continue;
      }

      const match = phoneMatch ?? emailMatch;
      if (match) {
        if (!options.canLinkGuardians) {
          state.errors.push({
            field: 'guardianPhone',
            message: 'You do not have permission to link students to parents',
            kind: 'FORBIDDEN',
          });
          continue;
        }
        state.guardianRef = { kind: 'EXISTING', id: match.id };
        state.guardianOutcome = 'MATCHED';

        const onFile = `${match.firstName} ${match.lastName}`;
        if (onFile.toLowerCase() !== fullName.toLowerCase()) {
          state.warnings.push(
            `Linked to parent already on file as ${onFile} (matched by ${phoneMatch ? 'phone' : 'email'})`,
          );
        }
        if (
          guardian.email &&
          match.email &&
          match.email.toLowerCase() !== guardian.email
        ) {
          state.warnings.push(
            `Kept the parent email already on file (${match.email}); the file gives ${guardian.email}`,
          );
        }
        continue;
      }

      if (!options.canCreateGuardians) {
        state.errors.push({
          field: 'guardianPhone',
          message: 'You do not have permission to create parent records',
          kind: 'FORBIDDEN',
        });
        continue;
      }

      const shared = pending.get(key);
      if (shared) {
        state.guardianRef = { kind: 'NEW', key };
        state.guardianOutcome = 'SHARED';
        const firstName = `${shared.firstName} ${shared.lastName}`;
        if (firstName.toLowerCase() !== fullName.toLowerCase()) {
          state.warnings.push(
            `Same Parent Phone as row ${shared.row}, so linked to ${firstName}`,
          );
        }
        continue;
      }

      if (guardian.email) {
        const owner = newEmailOwner.get(guardian.email);
        if (owner) {
          state.errors.push({
            field: 'guardianEmail',
            message: `Parent Email ${guardian.email} is already given on row ${owner.row} with a different phone`,
            kind: 'INVALID',
          });
          continue;
        }
      }

      const created: PendingGuardian = {
        key,
        row: state.row,
        firstName: guardian.firstName!,
        lastName: guardian.lastName!,
        phone: guardian.phone!,
        email: guardian.email ?? null,
      };
      pending.set(key, created);
      if (created.email) newEmailOwner.set(created.email, created);
      state.guardianRef = { kind: 'NEW', key };
      state.guardianOutcome = 'CREATED';
    }

    return pending;
  }

  /** Seats go to otherwise-valid rows in file order, so bad rows take none. */
  private checkCapacity(states: RowState[]): void {
    const used = new Map<string, number>();

    for (const state of states) {
      const arm = state.arm;
      if (!arm || arm.capacity === null || state.errors.length > 0) continue;

      const taken = arm.active + (used.get(arm.id) ?? 0);
      if (taken >= arm.capacity) {
        state.errors.push({
          field: 'classArm',
          message: `${arm.label} is full (${arm.capacity}/${arm.capacity})`,
          kind: 'FULL',
        });
        continue;
      }
      used.set(arm.id, (used.get(arm.id) ?? 0) + 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  /** Returns how many parent records were created. */
  private async write(
    rows: RowState[],
    pending: Map<string, PendingGuardian>,
    schoolId: string,
  ): Promise<number> {
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.$transaction(
          (tx) => this.writeOnce(tx, rows, pending, schoolId),
          // A few hundred rows with parents outlasts the 5s default.
          { timeout: 30_000, maxWait: 10_000 },
        );
      } catch (error) {
        const unique =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002';
        if (!unique) throw error;
        if (attempt === WRITE_ATTEMPTS) {
          throw AppException.conflict(
            'Another change landed while this file was importing, and nothing was imported. Please run it again.',
          );
        }
      }
    }

    return 0;
  }

  private async writeOnce(
    tx: TxClient,
    rows: RowState[],
    pending: Map<string, PendingGuardian>,
    schoolId: string,
  ): Promise<number> {
    // Lock every arm the file fills, in a fixed order, then re-count under the
    // lock: seats may have gone since the rows were checked.
    const incoming = new Map<string, number>();
    for (const state of rows) {
      if (state.arm) {
        incoming.set(state.arm.id, (incoming.get(state.arm.id) ?? 0) + 1);
      }
    }
    await lockRows(tx, 'classArm', incoming.keys());

    for (const [armId, count] of incoming) {
      const arm = await tx.classArm.findUniqueOrThrow({
        where: { id: armId },
        select: {
          name: true,
          capacity: true,
          class: { select: { name: true } },
          _count: {
            select: { students: { where: { status: StudentStatus.ACTIVE } } },
          },
        },
      });
      if (arm.capacity !== null && arm._count.students + count > arm.capacity) {
        throw AppException.conflict(
          `${arm.class.name} ${arm.name} filled up while this file was importing. Nothing was imported; please run it again.`,
        );
      }
    }

    const numbers = await this.allocateNumbers(tx, rows);

    // Only parents that a written row actually needs are created.
    const neededKeys: string[] = [];
    for (const state of rows) {
      const ref = state.guardianRef;
      if (ref?.kind === 'NEW' && !neededKeys.includes(ref.key)) {
        neededKeys.push(ref.key);
      }
    }

    const guardianIds = new Map<string, string>();
    if (neededKeys.length > 0) {
      const created = await tx.guardian.createManyAndReturn({
        data: neededKeys.map((key) => {
          const guardian = pending.get(key)!;
          return {
            schoolId,
            firstName: guardian.firstName,
            lastName: guardian.lastName,
            phone: guardian.phone,
            email: guardian.email,
          };
        }),
        select: { id: true, phone: true },
      });
      for (const guardian of created) {
        guardianIds.set(canonicalPhone(guardian.phone), guardian.id);
      }
    }

    const students = await tx.student.createManyAndReturn({
      data: rows.map((state, index) => {
        const data = state.data;
        return {
          schoolId,
          studentId: numbers[index],
          firstName: data.firstName!,
          lastName: data.lastName!,
          middleName: data.middleName ?? null,
          gender: data.gender!,
          dateOfBirth: data.dateOfBirth ?? null,
          email: data.email ?? null,
          phone: data.phone ?? null,
          addressLine: data.addressLine ?? null,
          admissionDate: data.admissionDate!,
          classArmId: state.arm?.id ?? null,
          bloodGroup: data.bloodGroup ?? null,
          genotype: data.genotype ?? null,
          stateOfOrigin: data.stateOfOrigin ?? null,
          lga: data.lga ?? null,
          nationality: data.nationality ?? 'Nigerian',
          religion: data.religion ?? null,
          notes: data.notes ?? null,
        };
      }),
      select: { id: true, studentId: true },
    });
    // Matched by admission number rather than position: RETURNING order is
    // not something to rely on.
    const idByNumber = new Map(students.map((s) => [s.studentId, s.id]));

    const links = rows
      .map((state, index) => {
        const ref = state.guardianRef;
        if (!ref) return null;
        const guardianId =
          ref.kind === 'EXISTING' ? ref.id : guardianIds.get(ref.key);
        if (!guardianId) return null;
        return {
          schoolId,
          studentId: idByNumber.get(numbers[index])!,
          guardianId,
          relationship: state.data.guardian!.relationship,
          // The only guardian a new student has is, by definition, the first
          // one the school calls.
          isPrimary: true,
          canPickUp: true,
        };
      })
      .filter((link): link is NonNullable<typeof link> => link !== null);

    if (links.length > 0) {
      await tx.studentGuardian.createMany({ data: links });
    }

    // Only now, with the transaction about to commit, is anything "written".
    const createdKeys = new Set<string>();
    rows.forEach((state, index) => {
      state.admissionNumber = numbers[index];
      state.studentDbId = idByNumber.get(numbers[index]) ?? null;
      state.written = true;
      const ref = state.guardianRef;
      if (ref?.kind === 'NEW') {
        state.guardianOutcome = createdKeys.has(ref.key) ? 'SHARED' : 'CREATED';
        createdKeys.add(ref.key);
      }
    });

    return neededKeys.length;
  }

  /**
   * Numbers for rows that did not bring their own, one read per admission year
   * rather than one per row. The unique index remains the real guard.
   */
  private async allocateNumbers(
    client: TxClient,
    rows: RowState[],
  ): Promise<string[]> {
    const years = new Set(
      rows
        .filter((state) => !state.data.studentId)
        .map((state) => state.data.admissionDate!.getUTCFullYear()),
    );

    const { admissionNumberPrefix } = await this.settings.current();
    const next = new Map<number, number>();
    for (const year of years) {
      const existing = await client.student.findMany({
        where: { studentId: { startsWith: `${year}/` } },
        select: { studentId: true },
      });
      next.set(
        year,
        nextSequence(
          existing.map((row) => row.studentId),
          year,
        ),
      );
    }

    return rows.map((state) => {
      if (state.data.studentId) return state.data.studentId;
      const year = state.data.admissionDate!.getUTCFullYear();
      const sequence = next.get(year) ?? 1;
      next.set(year, sequence + 1);
      return formatAdmissionNumber(year, sequence, admissionNumberPrefix);
    });
  }
}
