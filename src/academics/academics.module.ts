import { Module } from '@nestjs/common';
import { AcademicSessionsController } from './academic-sessions.controller';
import { AcademicSessionsService } from './academic-sessions.service';
import { TermsController } from './terms.controller';
import { TermsService } from './terms.service';

/**
 * Academic structure: sessions and terms now, classes / class arms next.
 */
@Module({
  controllers: [AcademicSessionsController, TermsController],
  providers: [AcademicSessionsService, TermsService],
  exports: [AcademicSessionsService, TermsService],
})
export class AcademicsModule {}
