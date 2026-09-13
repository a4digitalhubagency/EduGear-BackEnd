import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import {
  AssessmentSchemeDto,
  GradingScaleDto,
  ResultsSetupDto,
  SetAssessmentSchemeDto,
  SetGradingScaleDto,
} from './dto/assessment.dto';
import {
  DEFAULT_ASSESSMENT_COMPONENTS,
  WAEC_GRADE_BANDS,
  validateAssessmentScheme,
  validateGradeBands,
} from './grading';

/**
 * How a subject is marked and how marks become grades. Both are replaced as a
 * whole and validated as a whole, because their rules — "adds up to 100",
 * "covers 0–100 with no gaps" — are properties of the set, not of one row.
 */
@Injectable()
export class AssessmentService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async scheme(): Promise<AssessmentSchemeDto> {
    const [components, scores] = await Promise.all([
      this.prisma.assessmentComponent.findMany({
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.score.count(),
    ]);

    return {
      configured: components.length > 0,
      locked: scores > 0,
      components: components.map((component) => ({
        id: component.id,
        name: component.name,
        maxScore: component.maxScore,
        sortOrder: component.sortOrder,
      })),
    };
  }

  /**
   * Replaces the scheme. Once any score exists, the marks are what those scores
   * were entered against, so only names may change — renaming "CA1" to
   * "1st CA" is harmless; turning a 10-mark test into a 20-mark one is not.
   */
  async setScheme(
    dto: SetAssessmentSchemeDto,
    schoolId: string,
  ): Promise<AssessmentSchemeDto> {
    const problems = validateAssessmentScheme(dto.components);
    if (problems.length) {
      throw AppException.badRequest(
        problems.join('. '),
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const existing = await this.prisma.assessmentComponent.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    const scored = (await this.prisma.score.count()) > 0;

    if (scored) {
      const sameShape =
        existing.length === dto.components.length &&
        existing.every(
          (component, i) => component.maxScore === dto.components[i].maxScore,
        );
      if (!sameShape) {
        throw AppException.conflict(
          'Scores have been entered against the current scheme, so its marks are fixed. You can still rename components.',
        );
      }

      // Two passes, so swapping two names does not trip the unique index
      // halfway through: park every row on a unique placeholder, then rename.
      await this.prisma.$transaction(async (tx) => {
        for (const component of existing) {
          await tx.assessmentComponent.update({
            where: { id: component.id },
            data: { name: `__renaming_${component.id}` },
          });
        }
        for (const [i, component] of existing.entries()) {
          await tx.assessmentComponent.update({
            where: { id: component.id },
            data: { name: dto.components[i].name },
          });
        }
      });
      return this.scheme();
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.assessmentComponent.deleteMany({});
      await tx.assessmentComponent.createMany({
        data: dto.components.map((component, i) => ({
          schoolId,
          name: component.name,
          maxScore: component.maxScore,
          sortOrder: i + 1,
        })),
      });
    });
    return this.scheme();
  }

  async grading(): Promise<GradingScaleDto> {
    const bands = await this.prisma.gradeBand.findMany({
      orderBy: { minScore: 'desc' },
    });
    return {
      configured: bands.length > 0,
      bands: bands.map(({ grade, minScore, maxScore, remark, isPass }) => ({
        grade,
        minScore,
        maxScore,
        remark,
        isPass,
      })),
    };
  }

  /**
   * Replaces the scale. Published sheets keep the grades they were computed
   * with — they are snapshots — so this only affects sheets computed from now.
   */
  async setGrading(
    dto: SetGradingScaleDto,
    schoolId: string,
  ): Promise<GradingScaleDto> {
    const problems = validateGradeBands(dto.bands);
    if (problems.length) {
      throw AppException.badRequest(
        problems.join('. '),
        ErrorCode.VALIDATION_ERROR,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.gradeBand.deleteMany({});
      await tx.gradeBand.createMany({
        data: dto.bands.map((band) => ({ schoolId, ...band })),
      });
    });
    return this.grading();
  }

  /** Fills in whatever is missing with the common Nigerian defaults. Idempotent. */
  async setupDefaults(schoolId: string): Promise<ResultsSetupDto> {
    const created: string[] = [];

    if ((await this.prisma.assessmentComponent.count()) === 0) {
      await this.prisma.assessmentComponent.createMany({
        data: DEFAULT_ASSESSMENT_COMPONENTS.map((component, i) => ({
          schoolId,
          name: component.name,
          maxScore: component.maxScore,
          sortOrder: i + 1,
        })),
      });
      created.push('Assessment scheme: 3 CAs of 10 marks and a 70-mark exam');
    }

    if ((await this.prisma.gradeBand.count()) === 0) {
      await this.prisma.gradeBand.createMany({
        data: WAEC_GRADE_BANDS.map((band) => ({ schoolId, ...band })),
      });
      created.push('Grading scale: WAEC A1–F9');
    }

    return {
      scheme: await this.scheme(),
      grading: await this.grading(),
      created,
    };
  }
}
