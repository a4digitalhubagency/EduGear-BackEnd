import { Injectable } from '@nestjs/common';
import { Prisma, ResultSheetStatus } from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { LetterheadService } from '../tenants/letterhead.service';
import { SchoolSettingsService } from '../tenants/school-settings.service';
import { ReportCardAttendanceDto, ReportCardDto } from './dto/report-card.dto';
import { mark } from './numbers';
import { ordinal } from './ranking';

interface StoredComponent {
  name: string;
  maxScore: number;
  score: number | null;
}

const RESULT_WITH_SHEET = {
  student: {
    select: {
      id: true,
      studentId: true,
      firstName: true,
      lastName: true,
      middleName: true,
      gender: true,
      dateOfBirth: true,
      photoUrl: true,
    },
  },
  resultSheet: {
    include: {
      classArm: {
        select: {
          name: true,
          formTeacherId: true,
          class: { select: { name: true } },
        },
      },
      term: {
        select: {
          id: true,
          name: true,
          startDate: true,
          endDate: true,
          session: { select: { name: true } },
        },
      },
    },
  },
} satisfies Prisma.StudentResultInclude;

type ResultRow = Prisma.StudentResultGetPayload<{
  include: typeof RESULT_WITH_SHEET;
}>;

/** Supplies attendance for a report card; the attendance module registers one. */
export interface AttendanceSummarySource {
  termSummary(
    studentId: string,
    termId: string,
  ): Promise<ReportCardAttendanceDto | null>;
}

/**
 * Report cards, built only from a sheet's stored snapshot — never recomputed on
 * read — so a card printed today and reprinted next month say the same thing.
 */
@Injectable()
export class ReportCardsService {
  private attendance: AttendanceSummarySource | null = null;

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly letterheads: LetterheadService,
    private readonly settings: SchoolSettingsService,
  ) {}

  /** Lets the attendance module add its figures without a circular import. */
  useAttendance(source: AttendanceSummarySource): void {
    this.attendance = source;
  }

  /**
   * One student's card. `publishedOnly` is how the parent portal asks: anything
   * short of PUBLISHED is reported as simply absent, so a draft never leaks.
   */
  async forStudent(
    studentId: string,
    termId: string,
    options: { publishedOnly?: boolean } = {},
  ): Promise<ReportCardDto> {
    const row = await this.prisma.studentResult.findFirst({
      where: {
        studentId,
        resultSheet: {
          termId,
          ...(options.publishedOnly
            ? { status: ResultSheetStatus.PUBLISHED }
            : {}),
        },
      },
      include: RESULT_WITH_SHEET,
    });

    if (!row) {
      throw AppException.notFound('No results for this student in that term');
    }

    return (await this.build([row]))[0];
  }

  /** Every card on a sheet, in class-position order — for printing a class. */
  async forSheet(sheetId: string): Promise<ReportCardDto[]> {
    const sheet = await this.prisma.resultSheet.findUnique({
      where: { id: sheetId },
      select: { id: true },
    });
    if (!sheet) throw AppException.notFound('Result sheet');

    const rows = await this.prisma.studentResult.findMany({
      where: { resultSheetId: sheetId },
      include: RESULT_WITH_SHEET,
    });
    rows.sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) -
          (b.position ?? Number.MAX_SAFE_INTEGER) ||
        a.student.lastName.localeCompare(b.student.lastName),
    );
    return this.build(rows);
  }

  private async build(rows: ResultRow[]): Promise<ReportCardDto[]> {
    if (rows.length === 0) return [];

    const sheet = rows[0].resultSheet;
    const [school, subjects, outOf, bands, nextTerm, formTeacher, settings] =
      await Promise.all([
        this.letterheads.current(),
        this.prisma.subjectResult.findMany({
          where: {
            resultSheetId: sheet.id,
            studentId: { in: rows.map((row) => row.studentId) },
          },
          orderBy: { subjectName: 'asc' },
        }),
        this.prisma.studentResult.count({
          where: { resultSheetId: sheet.id, position: { not: null } },
        }),
        this.prisma.gradeBand.findMany({ orderBy: { minScore: 'desc' } }),
        this.prisma.term.findFirst({
          where: { startDate: { gt: sheet.term.endDate } },
          orderBy: { startDate: 'asc' },
          select: { startDate: true },
        }),
        this.formTeacherName(sheet.classArm.formTeacherId),
        this.settings.current(),
      ]);

    return Promise.all(
      rows.map(async (row) => {
        const mine = subjects.filter(
          (subject) => subject.studentId === row.studentId,
        );
        const student = row.student;
        const middle = student.middleName ? ` ${student.middleName}` : '';

        return {
          school,
          student: {
            id: student.id,
            admissionNumber: student.studentId,
            fullName: `${student.lastName}, ${student.firstName}${middle}`,
            gender: student.gender,
            dateOfBirth: student.dateOfBirth,
            photoUrl: student.photoUrl,
          },
          className: `${sheet.classArm.class.name} ${sheet.classArm.name}`,
          termName: sheet.term.name,
          sessionName: sheet.term.session.name,
          nextTermBegins: nextTerm?.startDate ?? null,
          status: sheet.status,
          publishedAt: sheet.publishedAt,
          // A school that does not rank its children gets a card with no
          // positions at all — including the per-subject ones.
          subjects: mine.map((subject) => ({
            subjectName: subject.subjectName,
            components: subject.componentScores as unknown as StoredComponent[],
            total: mark(subject.totalScore),
            grade: subject.grade,
            remark: subject.remark,
            position: settings.reportShowPosition ? subject.position : null,
            positionLabel: settings.reportShowPosition
              ? ordinal(subject.position)
              : null,
            classHighest: settings.reportShowClassStats
              ? mark(subject.classHighest)
              : null,
            classLowest: settings.reportShowClassStats
              ? mark(subject.classLowest)
              : null,
            classAverage: settings.reportShowClassStats
              ? mark(subject.classAverage)
              : null,
          })),
          totalScore: mark(row.totalScore),
          averageScore: mark(row.averageScore),
          position: settings.reportShowPosition ? row.position : null,
          positionLabel:
            settings.reportShowPosition && row.position
              ? ordinal(row.position)
              : null,
          outOf,
          subjectCount: row.subjectCount,
          passes: mine.filter((subject) => subject.isPass).length,
          failures: mine.filter((subject) => !subject.isPass).length,
          formTeacherName: formTeacher,
          formTeacherComment: row.formTeacherComment,
          principalComment: row.principalComment,
          attendance: this.attendance
            ? await this.attendance.termSummary(row.studentId, sheet.term.id)
            : null,
          gradeScale: bands.map(
            ({ grade, minScore, maxScore, remark, isPass }) => ({
              grade,
              minScore,
              maxScore,
              remark,
              isPass,
            }),
          ),
        };
      }),
    );
  }

  private async formTeacherName(
    membershipId: string | null,
  ): Promise<string | null> {
    if (!membershipId) return null;
    const membership = await this.prisma.membership.findUnique({
      where: { id: membershipId },
      select: { user: { select: { firstName: true, lastName: true } } },
    });
    return membership
      ? `${membership.user.firstName} ${membership.user.lastName}`
      : null;
  }
}
