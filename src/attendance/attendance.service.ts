import { Injectable, OnModuleInit } from '@nestjs/common';
import { AttendanceStatus, StudentStatus } from '@prisma/client';
import { AccessControlService } from '../auth/access-control.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { RequestContext } from '../common/context/request-context';
import { AppException, ValidationDetail } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { toDateOnly } from '../academics/date-range';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { ReportCardsService } from '../results/report-cards.service';
import { tally } from './attendance-summary';
import {
  AttendanceRecordDto,
  AttendanceSummaryDto,
  RegisterDto,
  RegisterQueryDto,
  SaveRegisterDto,
  StudentAttendanceSummaryDto,
} from './dto/attendance.dto';

/**
 * The daily register.
 *
 * Taken by the arm's form teacher, or by staff who manage the academic
 * structure (administrators, the principal) — every teacher holds
 * attendance.create, so the permission alone would let anyone mark any class.
 * A register is for a school day inside a term, never a future one.
 */
@Injectable()
export class AttendanceService implements OnModuleInit {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly accessControl: AccessControlService,
    private readonly reportCards: ReportCardsService,
  ) {}

  /** Report cards print attendance; they get it from here. */
  onModuleInit(): void {
    this.reportCards.useAttendance({
      termSummary: async (studentId, termId) => {
        const summary = await this.studentTermSummary(studentId, termId);
        return summary.daysOpen === 0
          ? null
          : {
              daysOpen: summary.daysOpen,
              present: summary.present,
              absent: summary.absent,
              late: summary.late,
            };
      },
    });
  }

  async register(query: RegisterQueryDto): Promise<RegisterDto> {
    const date = toDateOnly(query.date);
    const [label, term, students] = await Promise.all([
      this.armLabel(query.classArmId),
      this.termOn(date),
      this.prisma.student.findMany({
        where: { classArmId: query.classArmId, status: StudentStatus.ACTIVE },
        select: { id: true, studentId: true, firstName: true, lastName: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      }),
    ]);

    const records = await this.prisma.attendanceRecord.findMany({
      where: { date, studentId: { in: students.map((s) => s.id) } },
      select: { studentId: true, status: true, note: true },
    });
    const byStudent = new Map(records.map((r) => [r.studentId, r]));

    const rows = students.map((student) => ({
      studentId: student.id,
      admissionNumber: student.studentId,
      studentName: `${student.lastName}, ${student.firstName}`,
      status: byStudent.get(student.id)?.status ?? null,
      note: byStudent.get(student.id)?.note ?? null,
    }));
    const statuses = rows
      .map((row) => row.status)
      .filter((s): s is AttendanceStatus => s !== null);
    const counts = tally(statuses);

    return {
      classArmId: query.classArmId,
      className: label,
      date,
      termName: term?.name ?? null,
      taken: records.length > 0,
      canEdit:
        term !== null &&
        !this.isFuture(date) &&
        (await this.mayTake(query.classArmId)),
      students: rows,
      present: counts.present - counts.late,
      absent: counts.absent - counts.excused,
      late: counts.late,
      excused: counts.excused,
    };
  }

  async save(dto: SaveRegisterDto, schoolId: string): Promise<RegisterDto> {
    const date = toDateOnly(dto.date);
    const label = await this.armLabel(dto.classArmId);

    if (!(await this.mayTake(dto.classArmId))) {
      throw AppException.forbidden(
        `Only the form teacher of ${label} can take its register`,
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }
    if (this.isFuture(date)) {
      throw AppException.badRequest(
        'A register cannot be taken for a future date',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (!(await this.termOn(date))) {
      throw AppException.badRequest(
        'That date is not inside any term, so it is not a school day',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const members = await this.prisma.student.findMany({
      where: {
        id: { in: dto.entries.map((e) => e.studentId) },
        classArmId: dto.classArmId,
        status: StudentStatus.ACTIVE,
      },
      select: { id: true },
    });
    const inArm = new Set(members.map((m) => m.id));
    const seen = new Set<string>();
    const details: ValidationDetail[] = [];
    dto.entries.forEach((entry, index) => {
      const problems: string[] = [];
      if (!inArm.has(entry.studentId))
        problems.push(`student is not an active member of ${label}`);
      if (seen.has(entry.studentId))
        problems.push('the same student appears twice');
      seen.add(entry.studentId);
      if (problems.length)
        details.push({ field: `entries[${index}]`, constraints: problems });
    });
    if (details.length) {
      throw new AppException(
        400,
        ErrorCode.VALIDATION_ERROR,
        `${details.length} register entr(ies) could not be saved; nothing was changed`,
        details,
      );
    }

    const recordedBy = RequestContext.getAuth()?.membershipId ?? null;
    await this.prisma.$transaction(
      dto.entries.map((entry) =>
        this.prisma.attendanceRecord.upsert({
          where: { studentId_date: { studentId: entry.studentId, date } },
          create: {
            schoolId,
            studentId: entry.studentId,
            classArmId: dto.classArmId,
            date,
            status: entry.status,
            note: entry.note ?? null,
            recordedByMembershipId: recordedBy,
          },
          update: {
            status: entry.status,
            note: entry.note ?? null,
            classArmId: dto.classArmId,
            recordedByMembershipId: recordedBy,
          },
        }),
      ),
    );

    return this.register(dto);
  }

  async studentTermSummary(
    studentId: string,
    termId: string,
  ): Promise<AttendanceSummaryDto> {
    const term = await this.getTerm(termId);
    const records = await this.prisma.attendanceRecord.findMany({
      where: { studentId, date: { gte: term.startDate, lte: term.endDate } },
      select: { status: true },
    });
    return tally(records.map((record) => record.status));
  }

  async studentRecords(
    studentId: string,
    termId: string,
  ): Promise<AttendanceRecordDto[]> {
    const term = await this.getTerm(termId);
    return this.prisma.attendanceRecord.findMany({
      where: { studentId, date: { gte: term.startDate, lte: term.endDate } },
      select: { date: true, status: true, note: true },
      orderBy: { date: 'asc' },
    });
  }

  async armTermSummary(
    classArmId: string,
    termId: string,
  ): Promise<StudentAttendanceSummaryDto[]> {
    await this.armLabel(classArmId);
    const term = await this.getTerm(termId);

    const students = await this.prisma.student.findMany({
      where: { classArmId, status: StudentStatus.ACTIVE },
      select: { id: true, studentId: true, firstName: true, lastName: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        studentId: { in: students.map((s) => s.id) },
        date: { gte: term.startDate, lte: term.endDate },
      },
      select: { studentId: true, status: true },
    });

    return students.map((student) => ({
      studentId: student.id,
      studentName: `${student.lastName}, ${student.firstName}`,
      admissionNumber: student.studentId,
      ...tally(
        records.filter((r) => r.studentId === student.id).map((r) => r.status),
      ),
    }));
  }

  // ---------------------------------------------------------------------------

  private async mayTake(classArmId: string): Promise<boolean> {
    const auth = RequestContext.getAuth();
    if (!auth) return false;

    const snapshot = await this.accessControl.getMembershipSnapshot(
      auth.membershipId,
    );
    if (snapshot?.permissions.has(PERMISSIONS.ACADEMICS_UPDATE)) return true;

    const arm = await this.prisma.classArm.findUnique({
      where: { id: classArmId },
      select: { formTeacherId: true },
    });
    return arm?.formTeacherId === auth.membershipId;
  }

  private isFuture(date: Date): boolean {
    return date.getTime() > toDateOnly(new Date()).getTime();
  }

  private termOn(date: Date) {
    return this.prisma.term.findFirst({
      where: { startDate: { lte: date }, endDate: { gte: date } },
      select: { id: true, name: true },
    });
  }

  private async getTerm(termId: string) {
    const term = await this.prisma.term.findUnique({
      where: { id: termId },
      select: { startDate: true, endDate: true },
    });
    if (!term) throw AppException.notFound('Term');
    return term;
  }

  private async armLabel(classArmId: string): Promise<string> {
    const arm = await this.prisma.classArm.findUnique({
      where: { id: classArmId },
      select: { name: true, class: { select: { name: true } } },
    });
    if (!arm) throw AppException.notFound('Class arm');
    return `${arm.class.name} ${arm.name}`;
  }
}
