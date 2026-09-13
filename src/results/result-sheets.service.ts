import { Injectable } from '@nestjs/common';
import { Prisma, ResultSheetStatus, StudentStatus } from '@prisma/client';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma, TxClient } from '../database/prisma.service';
import { lockRow } from '../database/row-lock';
import { ComputeResult, computeResults } from './compute-results';
import {
  ComputeSheetDto,
  MissingScoreDto,
  QueryResultSheetsDto,
  ResultSheetDto,
  ResultSheetSummaryDto,
  ReturnSheetDto,
  SheetCommentDto,
} from './dto/result-sheet.dto';
import { mark } from './numbers';
import { ordinal } from './ranking';
import { ResultsAccessService } from './results-access.service';

const WITH_CONTEXT = {
  classArm: {
    select: { name: true, classId: true, class: { select: { name: true } } },
  },
  term: { select: { name: true, session: { select: { name: true } } } },
  _count: { select: { studentResults: true } },
} satisfies Prisma.ResultSheetInclude;

type SheetRow = Prisma.ResultSheetGetPayload<{ include: typeof WITH_CONTEXT }>;

/** How far a missing-scores refusal lists before summarising. */
const MISSING_LISTED = 20;

/**
 * A class arm's results for a term, and their path to parents:
 *
 *   DRAFT ──submit──▶ SUBMITTED ──approve──▶ APPROVED ──publish──▶ PUBLISHED
 *     ▲                   │                     │                     │
 *     └──────────── return (with a reason) ─────┴─────────────────────┘
 *
 * Only a draft can be computed or have its scores changed. Submitting
 * recomputes one last time and refuses if any score is missing, so the snapshot
 * a principal approves is complete and is exactly what parents are later shown.
 */
@Injectable()
export class ResultSheetsService {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly access: ResultsAccessService,
  ) {}

  async compute(
    dto: ComputeSheetDto,
    schoolId: string,
  ): Promise<ResultSheetDto> {
    const label = await this.armLabel(dto.classArmId);
    await this.assertTermExists(dto.termId);
    await this.access.assertFormTeacherOrHead(dto.classArmId, label);

    const sheetId = await this.prisma.$transaction(
      async (tx) => {
        const sheet = await tx.resultSheet.upsert({
          where: {
            classArmId_termId: {
              classArmId: dto.classArmId,
              termId: dto.termId,
            },
          },
          create: { schoolId, classArmId: dto.classArmId, termId: dto.termId },
          update: {},
          select: { id: true },
        });
        const locked = await this.lockDraft(tx, sheet.id, 'recomputed');
        await this.recompute(tx, locked, schoolId);
        return sheet.id;
      },
      { timeout: 30_000 },
    );

    return this.detail(sheetId);
  }

  async submit(id: string): Promise<ResultSheetDto> {
    const sheet = await this.getOrThrow(id);
    const actor = await this.access.assertFormTeacherOrHead(
      sheet.classArmId,
      this.label(sheet),
    );

    await this.prisma.$transaction(
      async (tx) => {
        const locked = await this.lockDraft(tx, id, 'submitted');
        const result = await this.recompute(tx, locked, sheet.schoolId);

        if (result.students.length === 0) {
          throw AppException.conflict(
            `${this.label(sheet)} has no active students to submit`,
          );
        }
        if (result.missing.length > 0) {
          const names = await this.describeMissing(result, locked.classArmId);
          const listed = names
            .slice(0, MISSING_LISTED)
            .map(
              (m) =>
                `${m.studentName} — ${m.subjectName} (${m.components.join(', ')})`,
            );
          const more =
            names.length > MISSING_LISTED
              ? `; and ${names.length - MISSING_LISTED} more`
              : '';
          throw AppException.conflict(
            `${names.length} subject result(s) are missing scores: ${listed.join('; ')}${more}`,
          );
        }

        await tx.resultSheet.update({
          where: { id },
          data: {
            status: ResultSheetStatus.SUBMITTED,
            submittedAt: new Date(),
            submittedByMembershipId: actor.membershipId,
            returnedReason: null,
          },
        });
      },
      { timeout: 30_000 },
    );

    return this.detail(id);
  }

  async approve(id: string): Promise<ResultSheetDto> {
    const actor = await this.access.assertHead('approve results');
    await this.transition(id, ResultSheetStatus.SUBMITTED, 'approved', {
      status: ResultSheetStatus.APPROVED,
      approvedAt: new Date(),
      approvedByMembershipId: actor.membershipId,
    });
    return this.detail(id);
  }

  /** Makes the results visible to parents. */
  async publish(id: string): Promise<ResultSheetDto> {
    const actor = await this.access.assertHead('publish results');
    await this.transition(id, ResultSheetStatus.APPROVED, 'published', {
      status: ResultSheetStatus.PUBLISHED,
      publishedAt: new Date(),
      publishedByMembershipId: actor.membershipId,
    });
    return this.detail(id);
  }

  /**
   * Sends a sheet back to draft — including a published one, because a result
   * that reached parents with an error must be correctable. The reason is kept
   * on the sheet and in the audit trail.
   */
  async returnToDraft(
    id: string,
    dto: ReturnSheetDto,
  ): Promise<ResultSheetDto> {
    await this.access.assertHead('return results');

    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'resultSheet', id);
      const current = await tx.resultSheet.findUniqueOrThrow({ where: { id } });
      if (current.status === ResultSheetStatus.DRAFT) {
        throw AppException.conflict('These results are already a draft');
      }

      await tx.resultSheet.update({
        where: { id },
        data: {
          status: ResultSheetStatus.DRAFT,
          returnedReason: dto.reason,
          submittedAt: null,
          submittedByMembershipId: null,
          approvedAt: null,
          approvedByMembershipId: null,
          publishedAt: null,
          publishedByMembershipId: null,
        },
      });
    });

    return this.detail(id);
  }

  async comment(
    id: string,
    studentId: string,
    dto: SheetCommentDto,
  ): Promise<ResultSheetDto> {
    const sheet = await this.getOrThrow(id);
    const editable: ResultSheetStatus[] = [];

    if (dto.formTeacherComment !== undefined) {
      await this.access.assertFormTeacherOrHead(
        sheet.classArmId,
        this.label(sheet),
      );
      editable.push(ResultSheetStatus.DRAFT, ResultSheetStatus.SUBMITTED);
    }
    if (dto.principalComment !== undefined) {
      await this.access.assertHead("write the principal's comment");
    }

    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'resultSheet', id);
      const current = await tx.resultSheet.findUniqueOrThrow({ where: { id } });

      if (
        dto.formTeacherComment !== undefined &&
        !editable.includes(current.status)
      ) {
        throw AppException.conflict(
          "The form teacher's comment is fixed once results are approved",
        );
      }
      if (
        dto.principalComment !== undefined &&
        current.status === ResultSheetStatus.PUBLISHED
      ) {
        throw AppException.conflict(
          'These results are published. Return them to draft to change a comment.',
        );
      }

      const { count } = await tx.studentResult.updateMany({
        where: { resultSheetId: id, studentId },
        data: {
          ...(dto.formTeacherComment !== undefined
            ? { formTeacherComment: dto.formTeacherComment }
            : {}),
          ...(dto.principalComment !== undefined
            ? { principalComment: dto.principalComment }
            : {}),
        },
      });
      if (count === 0) {
        throw AppException.notFound(
          'No computed result for that student on this sheet. Compute the sheet first.',
        );
      }
    });

    return this.detail(id);
  }

  async list(
    query: QueryResultSheetsDto,
  ): Promise<PaginatedDto<ResultSheetSummaryDto>> {
    const where: Prisma.ResultSheetWhereInput = {
      ...(query.termId ? { termId: query.termId } : {}),
      ...(query.classArmId ? { classArmId: query.classArmId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.resultSheet.findMany({
        where,
        include: WITH_CONTEXT,
        orderBy: { updatedAt: query.sortOrder },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.resultSheet.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.summary(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async detail(id: string): Promise<ResultSheetDto> {
    const sheet = await this.getOrThrow(id);

    const results = await this.prisma.studentResult.findMany({
      where: { resultSheetId: id },
      include: {
        student: {
          select: { studentId: true, firstName: true, lastName: true },
        },
      },
    });
    const subjectRows = await this.prisma.subjectResult.findMany({
      where: { resultSheetId: id },
      select: {
        studentId: true,
        subjectId: true,
        subjectName: true,
        isPass: true,
        classHighest: true,
        classLowest: true,
        classAverage: true,
      },
    });

    const passes = new Map<string, number>();
    const failures = new Map<string, number>();
    const stats = new Map<
      string,
      (typeof subjectRows)[number] & { count: number }
    >();
    for (const row of subjectRows) {
      const tally = row.isPass ? passes : failures;
      tally.set(row.studentId, (tally.get(row.studentId) ?? 0) + 1);
      const existing = stats.get(row.subjectId);
      stats.set(row.subjectId, { ...row, count: (existing?.count ?? 0) + 1 });
    }

    // A draft's completeness is read live, so the list is always current.
    let missing: MissingScoreDto[] = [];
    if (sheet.status === ResultSheetStatus.DRAFT) {
      const result = computeResults(
        await this.inputs(this.prisma, sheet.classArmId, sheet.termId),
      );
      missing = await this.describeMissing(result, sheet.classArmId);
    }

    const students = results
      .sort(
        (a, b) =>
          (a.position ?? Number.MAX_SAFE_INTEGER) -
            (b.position ?? Number.MAX_SAFE_INTEGER) ||
          a.student.lastName.localeCompare(b.student.lastName),
      )
      .map((row) => ({
        studentId: row.studentId,
        admissionNumber: row.student.studentId,
        studentName: `${row.student.lastName}, ${row.student.firstName}`,
        totalScore: mark(row.totalScore),
        averageScore: mark(row.averageScore),
        position: row.position,
        positionLabel: row.position ? ordinal(row.position) : null,
        subjectCount: row.subjectCount,
        passes: passes.get(row.studentId) ?? 0,
        failures: failures.get(row.studentId) ?? 0,
        formTeacherComment: row.formTeacherComment,
        principalComment: row.principalComment,
      }));

    const summary = this.summary(sheet);
    return {
      ...summary,
      students,
      subjects: [...stats.values()]
        .sort((a, b) => a.subjectName.localeCompare(b.subjectName))
        .map((row) => ({
          subjectId: row.subjectId,
          subjectName: row.subjectName,
          highest: mark(row.classHighest),
          lowest: mark(row.classLowest),
          average: mark(row.classAverage),
          studentCount: row.count,
        })),
      missing,
      ready:
        sheet.status === ResultSheetStatus.DRAFT &&
        !summary.stale &&
        sheet.computedAt !== null &&
        missing.length === 0 &&
        students.length > 0,
    };
  }

  // ---------------------------------------------------------------------------

  /**
   * Rebuilds the snapshot from current scores. Comments survive: they are
   * written by people and must not vanish because a score was corrected.
   */
  private async recompute(
    tx: TxClient,
    sheet: { id: string; classArmId: string; termId: string },
    schoolId: string,
  ): Promise<ComputeResult> {
    const inputs = await this.inputs(tx, sheet.classArmId, sheet.termId);
    if (inputs.components.length === 0 || inputs.bands.length === 0) {
      throw AppException.conflict(
        'Set up the assessment scheme and grading scale (or apply the defaults) before computing results.',
      );
    }

    const result = computeResults(inputs);
    const studentIds = result.students.map((student) => student.studentId);

    await tx.subjectResult.deleteMany({ where: { resultSheetId: sheet.id } });
    await tx.studentResult.deleteMany({
      where: { resultSheetId: sheet.id, studentId: { notIn: studentIds } },
    });

    for (const student of result.students) {
      const data = {
        totalScore: student.total,
        averageScore: student.average,
        position: student.position,
        subjectCount: student.subjectCount,
      };
      await tx.studentResult.upsert({
        where: {
          resultSheetId_studentId: {
            resultSheetId: sheet.id,
            studentId: student.studentId,
          },
        },
        create: {
          schoolId,
          resultSheetId: sheet.id,
          studentId: student.studentId,
          ...data,
        },
        update: data,
      });
    }

    const stats = new Map(result.subjectStats.map((s) => [s.subjectId, s]));
    const rows = result.students.flatMap((student) =>
      student.subjects.map((subject) => {
        const stat = stats.get(subject.subjectId)!;
        return {
          schoolId,
          resultSheetId: sheet.id,
          studentId: student.studentId,
          subjectId: subject.subjectId,
          subjectName: subject.subjectName,
          totalScore: subject.total,
          grade: subject.grade,
          remark: subject.remark,
          isPass: subject.isPass,
          position: subject.position,
          componentScores: subject.components.map((c) => ({
            name: c.name,
            maxScore: c.maxScore,
            score: c.score === null ? null : mark(c.score),
          })),
          classHighest: stat.highest,
          classLowest: stat.lowest,
          classAverage: stat.average,
        };
      }),
    );
    if (rows.length > 0) await tx.subjectResult.createMany({ data: rows });

    const now = new Date();
    await tx.resultSheet.update({
      where: { id: sheet.id },
      data: { computedAt: now, scoresChangedAt: null },
    });

    return result;
  }

  private async inputs(client: TxClient, classArmId: string, termId: string) {
    const arm = await client.classArm.findUniqueOrThrow({
      where: { id: classArmId },
      select: { classId: true },
    });

    const [students, offered, components, bands] = await Promise.all([
      client.student.findMany({
        where: { classArmId, status: StudentStatus.ACTIVE },
        select: { id: true },
      }),
      client.classSubject.findMany({
        where: { classId: arm.classId },
        select: {
          isCompulsory: true,
          subject: { select: { id: true, name: true } },
        },
        orderBy: { subject: { name: 'asc' } },
      }),
      client.assessmentComponent.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, maxScore: true },
      }),
      client.gradeBand.findMany(),
    ]);

    // Scores follow the student: one moved between arms mid-term keeps them.
    const scores = await client.score.findMany({
      where: {
        termId,
        studentId: { in: students.map((s) => s.id) },
        subjectId: { in: offered.map((o) => o.subject.id) },
      },
      select: {
        studentId: true,
        subjectId: true,
        componentId: true,
        score: true,
      },
    });

    return {
      students,
      subjects: offered.map((o) => ({
        id: o.subject.id,
        name: o.subject.name,
        compulsory: o.isCompulsory,
      })),
      components,
      scores,
      bands,
    };
  }

  private async describeMissing(
    result: ComputeResult,
    classArmId: string,
  ): Promise<MissingScoreDto[]> {
    if (result.missing.length === 0) return [];

    const [students, subjects, components] = await Promise.all([
      this.prisma.student.findMany({
        where: { classArmId },
        select: { id: true, firstName: true, lastName: true },
      }),
      this.prisma.subject.findMany({ select: { id: true, name: true } }),
      this.prisma.assessmentComponent.findMany({
        select: { id: true, name: true },
      }),
    ]);
    const studentName = new Map(
      students.map((s) => [s.id, `${s.lastName}, ${s.firstName}`]),
    );
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
    const componentName = new Map(components.map((c) => [c.id, c.name]));

    return result.missing.map((m) => ({
      studentId: m.studentId,
      studentName: studentName.get(m.studentId) ?? m.studentId,
      subjectId: m.subjectId,
      subjectName: subjectName.get(m.subjectId) ?? m.subjectId,
      components: m.componentIds.map((id) => componentName.get(id) ?? id),
    }));
  }

  private async lockDraft(tx: TxClient, id: string, action: string) {
    await lockRow(tx, 'resultSheet', id);
    const current = await tx.resultSheet.findUniqueOrThrow({ where: { id } });
    if (current.status !== ResultSheetStatus.DRAFT) {
      throw AppException.conflict(
        `Only a draft can be ${action}; these results are ${current.status}. Ask the principal to return them first.`,
      );
    }
    return current;
  }

  private async transition(
    id: string,
    from: ResultSheetStatus,
    action: string,
    data: Prisma.ResultSheetUpdateInput,
  ): Promise<void> {
    await this.getOrThrow(id);
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'resultSheet', id);
      const current = await tx.resultSheet.findUniqueOrThrow({ where: { id } });
      if (current.status !== from) {
        throw AppException.conflict(
          `Only ${from} results can be ${action}; these are ${current.status}`,
        );
      }
      await tx.resultSheet.update({ where: { id }, data });
    });
  }

  private async getOrThrow(id: string): Promise<SheetRow> {
    const found = await this.prisma.resultSheet.findUnique({
      where: { id },
      include: WITH_CONTEXT,
    });
    if (!found) throw AppException.notFound('Result sheet');
    return found;
  }

  private async armLabel(classArmId: string): Promise<string> {
    const arm = await this.prisma.classArm.findUnique({
      where: { id: classArmId },
      select: { name: true, class: { select: { name: true } } },
    });
    if (!arm) throw AppException.notFound('Class arm');
    return `${arm.class.name} ${arm.name}`;
  }

  private async assertTermExists(termId: string): Promise<void> {
    const term = await this.prisma.term.findUnique({
      where: { id: termId },
      select: { id: true },
    });
    if (!term) throw AppException.notFound('Term');
  }

  private label(sheet: SheetRow): string {
    return `${sheet.classArm.class.name} ${sheet.classArm.name}`;
  }

  private summary(sheet: SheetRow): ResultSheetSummaryDto {
    return {
      id: sheet.id,
      classArmId: sheet.classArmId,
      className: this.label(sheet),
      termId: sheet.termId,
      termName: sheet.term.name,
      sessionName: sheet.term.session.name,
      status: sheet.status,
      studentCount: sheet._count.studentResults,
      computedAt: sheet.computedAt,
      stale:
        sheet.status === ResultSheetStatus.DRAFT &&
        (sheet.computedAt === null ||
          (sheet.scoresChangedAt !== null &&
            sheet.scoresChangedAt > sheet.computedAt)),
      submittedAt: sheet.submittedAt,
      approvedAt: sheet.approvedAt,
      publishedAt: sheet.publishedAt,
      returnedReason: sheet.returnedReason,
    };
  }
}
