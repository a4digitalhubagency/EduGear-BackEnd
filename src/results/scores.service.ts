import { Injectable } from '@nestjs/common';
import { Prisma, ResultSheetStatus, StudentStatus } from '@prisma/client';
import { AppException, ValidationDetail } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma, TxClient } from '../database/prisma.service';
import { lockRow } from '../database/row-lock';
import { mark } from './numbers';
import {
  SaveScoresDto,
  ScoreSheetDto,
  ScoreSheetQueryDto,
} from './dto/score.dto';
import { gradeFor } from './grading';
import { ResultsAccessService } from './results-access.service';

interface SheetContext {
  className: string;
  classId: string;
  subjectName: string;
  isCompulsory: boolean;
  termName: string;
  sessionName: string;
  components: { id: string; name: string; maxScore: number }[];
}

@Injectable()
export class ScoresService {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly access: ResultsAccessService,
  ) {}

  async sheet(query: ScoreSheetQueryDto): Promise<ScoreSheetDto> {
    const context = await this.context(query);

    const [students, scores, sheet, bands, actor] = await Promise.all([
      this.prisma.student.findMany({
        where: { classArmId: query.classArmId, status: StudentStatus.ACTIVE },
        select: { id: true, studentId: true, firstName: true, lastName: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      }),
      this.prisma.score.findMany({
        where: {
          subjectId: query.subjectId,
          termId: query.termId,
          student: { classArmId: query.classArmId },
        },
        select: { studentId: true, componentId: true, score: true },
      }),
      this.prisma.resultSheet.findUnique({
        where: {
          classArmId_termId: {
            classArmId: query.classArmId,
            termId: query.termId,
          },
        },
        select: { status: true },
      }),
      this.prisma.gradeBand.findMany(),
      this.access.actor(),
    ]);

    const status = sheet?.status ?? ResultSheetStatus.DRAFT;
    const locked = status !== ResultSheetStatus.DRAFT;
    const mayEdit =
      actor.isHead || (await this.isAssignedTeacher(query, actor.membershipId));

    const byCell = new Map(
      scores.map((row) => [`${row.studentId}|${row.componentId}`, row.score]),
    );

    let entered = 0;
    let expected = 0;
    const rows = students.map((student) => {
      const cells = context.components.map((component) => {
        const score = byCell.get(`${student.id}|${component.id}`) ?? null;
        if (score !== null) entered++;
        return { componentId: component.id, score };
      });

      const taking =
        context.isCompulsory || cells.some((cell) => cell.score !== null);
      if (taking) expected += context.components.length;

      const total = cells.reduce<Prisma.Decimal>(
        (sum, cell) => sum.add(cell.score ?? 0),
        new Prisma.Decimal(0),
      );
      const complete = cells.every((cell) => cell.score !== null);

      return {
        studentId: student.id,
        admissionNumber: student.studentId,
        studentName: `${student.lastName}, ${student.firstName}`,
        scores: cells.map((cell) => ({
          componentId: cell.componentId,
          score: cell.score === null ? null : mark(cell.score),
        })),
        total: mark(total),
        grade: complete ? (gradeFor(total, bands)?.grade ?? null) : null,
        complete,
      };
    });

    return {
      classArmId: query.classArmId,
      className: context.className,
      subjectId: query.subjectId,
      subjectName: context.subjectName,
      isCompulsory: context.isCompulsory,
      termId: query.termId,
      termName: context.termName,
      sessionName: context.sessionName,
      status,
      locked,
      canEdit: mayEdit && !locked,
      components: context.components,
      students: rows,
      entered,
      expected,
    };
  }

  /**
   * Saves a batch of cells, all or nothing. Every bad cell is reported at once,
   * and the whole save runs under the class's result-sheet lock, so a score can
   * never land in a sheet that is being submitted at the same moment.
   */
  async save(dto: SaveScoresDto, schoolId: string): Promise<ScoreSheetDto> {
    const context = await this.context(dto);
    const label = `${context.className} ${context.subjectName}`;
    const actor = await this.access.assertCanEnterScores(
      dto.classArmId,
      dto.subjectId,
      label,
    );

    await this.validateEntries(dto, context);

    await this.prisma.$transaction(
      async (tx) => {
        const sheetId = await this.ensureDraftSheet(tx, dto, schoolId, context);

        for (const entry of dto.entries) {
          const key = {
            studentId: entry.studentId,
            subjectId: dto.subjectId,
            termId: dto.termId,
            componentId: entry.componentId,
          };

          if (entry.score === null) {
            await tx.score.deleteMany({ where: key });
            continue;
          }

          const score = new Prisma.Decimal(entry.score);
          await tx.score.upsert({
            where: { studentId_subjectId_termId_componentId: key },
            create: {
              ...key,
              schoolId,
              classArmId: dto.classArmId,
              score,
              enteredByMembershipId: actor.membershipId,
            },
            update: {
              score,
              classArmId: dto.classArmId,
              enteredByMembershipId: actor.membershipId,
            },
          });
        }

        // Marks the computed snapshot stale until the sheet is recomputed.
        await tx.resultSheet.update({
          where: { id: sheetId },
          data: { scoresChangedAt: new Date() },
        });
      },
      { timeout: 20_000 },
    );

    return this.sheet(dto);
  }

  /** The sheet is created on first use, then locked for the rest of the save. */
  private async ensureDraftSheet(
    tx: TxClient,
    dto: ScoreSheetQueryDto,
    schoolId: string,
    context: SheetContext,
  ): Promise<string> {
    const sheet = await tx.resultSheet.upsert({
      where: {
        classArmId_termId: { classArmId: dto.classArmId, termId: dto.termId },
      },
      create: { schoolId, classArmId: dto.classArmId, termId: dto.termId },
      update: {},
      select: { id: true },
    });
    await lockRow(tx, 'resultSheet', sheet.id);

    const current = await tx.resultSheet.findUniqueOrThrow({
      where: { id: sheet.id },
      select: { status: true },
    });
    if (current.status !== ResultSheetStatus.DRAFT) {
      throw AppException.conflict(
        `${context.className} results for the ${context.termName.toLowerCase()} term are ${current.status} and locked. Ask the principal to return them before changing scores.`,
      );
    }
    return sheet.id;
  }

  private async validateEntries(
    dto: SaveScoresDto,
    context: SheetContext,
  ): Promise<void> {
    const details: ValidationDetail[] = [];
    const components = new Map(context.components.map((c) => [c.id, c]));

    const students = await this.prisma.student.findMany({
      where: {
        id: { in: [...new Set(dto.entries.map((e) => e.studentId))] },
        classArmId: dto.classArmId,
        status: StudentStatus.ACTIVE,
      },
      select: { id: true },
    });
    const inArm = new Set(students.map((s) => s.id));
    const seen = new Set<string>();

    dto.entries.forEach((entry, index) => {
      const field = `entries[${index}]`;
      const problems: string[] = [];
      const component = components.get(entry.componentId);

      if (!inArm.has(entry.studentId)) {
        problems.push(
          `student is not an active member of ${context.className}`,
        );
      }
      if (!component) {
        problems.push('not a component of the assessment scheme');
      } else if (
        entry.score !== null &&
        (entry.score < 0 || entry.score > component.maxScore)
      ) {
        problems.push(
          `${component.name} is out of ${component.maxScore}; got ${entry.score}`,
        );
      }
      const cell = `${entry.studentId}|${entry.componentId}`;
      if (seen.has(cell))
        problems.push('the same cell appears twice in this save');
      seen.add(cell);

      if (problems.length) details.push({ field, constraints: problems });
    });

    if (details.length) {
      throw new AppException(
        400,
        ErrorCode.VALIDATION_ERROR,
        `${details.length} score(s) could not be saved; nothing was changed`,
        details,
      );
    }
  }

  private async context(query: ScoreSheetQueryDto): Promise<SheetContext> {
    const [arm, term, components] = await Promise.all([
      this.prisma.classArm.findUnique({
        where: { id: query.classArmId },
        select: {
          name: true,
          classId: true,
          class: { select: { name: true } },
        },
      }),
      this.prisma.term.findUnique({
        where: { id: query.termId },
        select: { name: true, session: { select: { name: true } } },
      }),
      this.prisma.assessmentComponent.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, maxScore: true },
      }),
    ]);

    if (!arm) throw AppException.notFound('Class arm');
    if (!term) throw AppException.notFound('Term');
    if (components.length === 0) {
      throw AppException.conflict(
        'No assessment scheme is set up yet. Configure one (or apply the defaults) before entering scores.',
      );
    }

    const offer = await this.prisma.classSubject.findUnique({
      where: {
        classId_subjectId: { classId: arm.classId, subjectId: query.subjectId },
      },
      select: { isCompulsory: true, subject: { select: { name: true } } },
    });
    if (!offer) {
      throw AppException.notFound(
        `${arm.class.name} does not offer that subject`,
      );
    }

    return {
      className: `${arm.class.name} ${arm.name}`,
      classId: arm.classId,
      subjectName: offer.subject.name,
      isCompulsory: offer.isCompulsory,
      termName: term.name,
      sessionName: term.session.name,
      components,
    };
  }

  private async isAssignedTeacher(
    query: ScoreSheetQueryDto,
    membershipId: string,
  ): Promise<boolean> {
    const assignment = await this.prisma.teachingAssignment.findUnique({
      where: {
        classArmId_subjectId: {
          classArmId: query.classArmId,
          subjectId: query.subjectId,
        },
      },
      select: { teacherMembershipId: true },
    });
    return assignment?.teacherMembershipId === membershipId;
  }
}
