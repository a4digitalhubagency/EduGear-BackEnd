import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { AssessmentService } from './assessment.service';
import { ReportCardsService } from './report-cards.service';
import { ResultSheetsService } from './result-sheets.service';
import { ResultsAccessService } from './results-access.service';
import { ResultsController } from './results.controller';
import { ScoresService } from './scores.service';
import { SubjectsController } from './subjects.controller';
import { SubjectsService } from './subjects.service';

@Module({
  imports: [TenantsModule],
  controllers: [SubjectsController, ResultsController],
  providers: [
    SubjectsService,
    AssessmentService,
    ScoresService,
    ResultSheetsService,
    ReportCardsService,
    ResultsAccessService,
  ],
  exports: [ReportCardsService, ResultSheetsService],
})
export class ResultsModule {}
