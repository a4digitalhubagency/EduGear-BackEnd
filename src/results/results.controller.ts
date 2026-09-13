import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { CurrentSchool, RequirePermissions } from '../common/decorators';
import { PaginatedDto } from '../common/dto/pagination.dto';
import { AssessmentService } from './assessment.service';
import {
  AssessmentSchemeDto,
  GradingScaleDto,
  ResultsSetupDto,
  SetAssessmentSchemeDto,
  SetGradingScaleDto,
} from './dto/assessment.dto';
import { ReportCardDto, ReportCardQueryDto } from './dto/report-card.dto';
import {
  ComputeSheetDto,
  QueryResultSheetsDto,
  ResultSheetDto,
  ResultSheetSummaryDto,
  ReturnSheetDto,
  SheetCommentDto,
} from './dto/result-sheet.dto';
import {
  SaveScoresDto,
  ScoreSheetDto,
  ScoreSheetQueryDto,
} from './dto/score.dto';
import { ReportCardsService } from './report-cards.service';
import { ResultSheetsService } from './result-sheets.service';
import { ScoresService } from './scores.service';

@ApiTags('Results')
@ApiBearerAuth()
@Controller('results')
export class ResultsController {
  constructor(
    private readonly assessment: AssessmentService,
    private readonly scores: ScoresService,
    private readonly sheets: ResultSheetsService,
    private readonly reportCards: ReportCardsService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  @Get('assessment-scheme')
  @RequirePermissions(PERMISSIONS.RESULTS_READ)
  @ApiOperation({ summary: 'How a subject is marked' })
  @ApiOkResponse({ type: AssessmentSchemeDto })
  scheme(): Promise<AssessmentSchemeDto> {
    return this.assessment.scheme();
  }

  @Put('assessment-scheme')
  @RequirePermissions(PERMISSIONS.RESULTS_PUBLISH)
  @ApiOperation({
    summary: 'Replace the assessment scheme',
    description:
      'Must add up to 100. Once scores exist, only names can change.',
  })
  @ApiOkResponse({ type: AssessmentSchemeDto })
  async setScheme(
    @Body() dto: SetAssessmentSchemeDto,
    @CurrentSchool() schoolId: string,
  ): Promise<AssessmentSchemeDto> {
    const scheme = await this.assessment.setScheme(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.ASSESSMENT_SCHEME_UPDATED,
      entityType: 'School',
      metadata: { components: dto.components },
    });
    return scheme;
  }

  @Get('grading-scale')
  @RequirePermissions(PERMISSIONS.RESULTS_READ)
  @ApiOperation({ summary: 'How marks become grades' })
  @ApiOkResponse({ type: GradingScaleDto })
  grading(): Promise<GradingScaleDto> {
    return this.assessment.grading();
  }

  @Put('grading-scale')
  @RequirePermissions(PERMISSIONS.RESULTS_PUBLISH)
  @ApiOperation({
    summary: 'Replace the grading scale',
    description:
      'Must cover 0–100 in whole marks. Published results keep their grades.',
  })
  @ApiOkResponse({ type: GradingScaleDto })
  async setGrading(
    @Body() dto: SetGradingScaleDto,
    @CurrentSchool() schoolId: string,
  ): Promise<GradingScaleDto> {
    const scale = await this.assessment.setGrading(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.GRADING_SCALE_UPDATED,
      entityType: 'School',
      metadata: { bands: dto.bands.map((band) => band.grade) },
    });
    return scale;
  }

  @Post('setup-defaults')
  @RequirePermissions(PERMISSIONS.RESULTS_PUBLISH)
  @ApiOperation({
    summary: 'Apply the common defaults where nothing is set',
    description:
      '3 × 10-mark CAs and a 70-mark exam; the WAEC A1–F9 scale. Idempotent.',
  })
  @ApiOkResponse({ type: ResultsSetupDto })
  @HttpCode(HttpStatus.OK)
  setupDefaults(@CurrentSchool() schoolId: string): Promise<ResultsSetupDto> {
    return this.assessment.setupDefaults(schoolId);
  }

  // ---------------------------------------------------------------------------
  // Scores
  // ---------------------------------------------------------------------------

  @Get('scores')
  @RequirePermissions(PERMISSIONS.RESULTS_READ)
  @ApiOperation({
    summary: 'The score grid for one subject in one arm and term',
  })
  @ApiOkResponse({ type: ScoreSheetDto })
  scoreSheet(@Query() query: ScoreSheetQueryDto): Promise<ScoreSheetDto> {
    return this.scores.sheet(query);
  }

  @Put('scores')
  @RequirePermissions(PERMISSIONS.RESULTS_CREATE)
  @ApiOperation({
    summary: 'Save scores',
    description:
      'All or nothing, every bad cell reported. Only the assigned subject teacher (or the principal) may save, and only while the results are a draft.',
  })
  @ApiOkResponse({ type: ScoreSheetDto })
  async saveScores(
    @Body() dto: SaveScoresDto,
    @CurrentSchool() schoolId: string,
  ): Promise<ScoreSheetDto> {
    const sheet = await this.scores.save(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.SCORES_SAVED,
      entityType: 'ClassArm',
      entityId: dto.classArmId,
      description: `Saved ${dto.entries.length} ${sheet.subjectName} score(s) for ${sheet.className}`,
      metadata: {
        subjectId: dto.subjectId,
        termId: dto.termId,
        count: dto.entries.length,
      },
    });
    return sheet;
  }

  // ---------------------------------------------------------------------------
  // Result sheets
  // ---------------------------------------------------------------------------

  @Post('sheets/compute')
  @RequirePermissions(PERMISSIONS.RESULTS_UPDATE)
  @ApiOperation({
    summary: 'Compute (or recompute) a class’s results',
    description:
      'Form teacher or principal. A draft only; shows what is still missing.',
  })
  @ApiOkResponse({ type: ResultSheetDto })
  @HttpCode(HttpStatus.OK)
  compute(
    @Body() dto: ComputeSheetDto,
    @CurrentSchool() schoolId: string,
  ): Promise<ResultSheetDto> {
    return this.sheets.compute(dto, schoolId);
  }

  @Get('sheets')
  @RequirePermissions(PERMISSIONS.RESULTS_READ)
  @ApiOperation({ summary: 'List result sheets' })
  list(
    @Query() query: QueryResultSheetsDto,
  ): Promise<PaginatedDto<ResultSheetSummaryDto>> {
    return this.sheets.list(query);
  }

  @Get('sheets/:id')
  @RequirePermissions(PERMISSIONS.RESULTS_READ)
  @ApiOperation({
    summary: 'A class’s results in position order, with class figures',
  })
  @ApiOkResponse({ type: ResultSheetDto })
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<ResultSheetDto> {
    return this.sheets.detail(id);
  }

  @Post('sheets/:id/submit')
  @RequirePermissions(PERMISSIONS.RESULTS_UPDATE)
  @ApiOperation({
    summary: 'Submit for approval',
    description:
      'Recomputes, refuses if any score is missing, then freezes the scores.',
  })
  @ApiOkResponse({ type: ResultSheetDto })
  @HttpCode(HttpStatus.OK)
  async submit(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResultSheetDto> {
    const sheet = await this.sheets.submit(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.RESULT_SUBMITTED,
      entityType: 'ResultSheet',
      entityId: id,
      description: `Submitted ${sheet.className} ${sheet.termName} term results`,
    });
    return sheet;
  }

  @Post('sheets/:id/approve')
  @RequirePermissions(PERMISSIONS.RESULTS_PUBLISH)
  @ApiOperation({ summary: 'Approve submitted results' })
  @ApiOkResponse({ type: ResultSheetDto })
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResultSheetDto> {
    const sheet = await this.sheets.approve(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.RESULT_APPROVED,
      entityType: 'ResultSheet',
      entityId: id,
      description: `Approved ${sheet.className} ${sheet.termName} term results`,
    });
    return sheet;
  }

  @Post('sheets/:id/publish')
  @RequirePermissions(PERMISSIONS.RESULTS_PUBLISH)
  @ApiOperation({ summary: 'Publish approved results to parents' })
  @ApiOkResponse({ type: ResultSheetDto })
  @HttpCode(HttpStatus.OK)
  async publish(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResultSheetDto> {
    const sheet = await this.sheets.publish(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.RESULT_PUBLISHED,
      entityType: 'ResultSheet',
      entityId: id,
      description: `Published ${sheet.className} ${sheet.termName} term results`,
    });
    return sheet;
  }

  @Post('sheets/:id/return')
  @RequirePermissions(PERMISSIONS.RESULTS_PUBLISH)
  @ApiOperation({
    summary: 'Send results back to draft',
    description: 'From submitted, approved or published — with a reason.',
  })
  @ApiOkResponse({ type: ResultSheetDto })
  @HttpCode(HttpStatus.OK)
  async returnToDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnSheetDto,
  ): Promise<ResultSheetDto> {
    const sheet = await this.sheets.returnToDraft(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.RESULT_RETURNED,
      entityType: 'ResultSheet',
      entityId: id,
      description: `Returned ${sheet.className} ${sheet.termName} term results to draft`,
      metadata: { reason: dto.reason },
    });
    return sheet;
  }

  @Patch('sheets/:id/students/:studentId/comment')
  @RequirePermissions(PERMISSIONS.RESULTS_UPDATE)
  @ApiOperation({ summary: 'Write the form teacher’s or principal’s comment' })
  @ApiOkResponse({ type: ResultSheetDto })
  comment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() dto: SheetCommentDto,
  ): Promise<ResultSheetDto> {
    return this.sheets.comment(id, studentId, dto);
  }

  @Get('sheets/:id/report-cards')
  @RequirePermissions(PERMISSIONS.RESULTS_READ)
  @ApiOperation({ summary: 'Every report card for a class, in position order' })
  @ApiOkResponse({ type: [ReportCardDto] })
  sheetReportCards(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReportCardDto[]> {
    return this.reportCards.forSheet(id);
  }

  @Get('report-cards/:studentId')
  @RequirePermissions(PERMISSIONS.RESULTS_READ)
  @ApiOperation({
    summary: 'A student’s report card for a term',
    description: 'Staff see any status; anything but PUBLISHED is provisional.',
  })
  @ApiOkResponse({ type: ReportCardDto })
  reportCard(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query() query: ReportCardQueryDto,
  ): Promise<ReportCardDto> {
    return this.reportCards.forStudent(studentId, query.termId);
  }
}
