import { Module } from '@nestjs/common';
import { AcademicSessionsController } from './academic-sessions.controller';
import { AcademicSessionsService } from './academic-sessions.service';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { TermsController } from './terms.controller';
import { TermsService } from './terms.service';

/**
 * Academic structure: sessions, terms and classes; class arms next.
 */
@Module({
  controllers: [AcademicSessionsController, TermsController, ClassesController],
  providers: [AcademicSessionsService, TermsService, ClassesService],
  exports: [AcademicSessionsService, TermsService, ClassesService],
})
export class AcademicsModule {}
