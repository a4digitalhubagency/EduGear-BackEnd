import { Module } from '@nestjs/common';
import { AcademicSessionsController } from './academic-sessions.controller';
import { AcademicSessionsService } from './academic-sessions.service';
import { ClassArmsController } from './class-arms.controller';
import { ClassArmsService } from './class-arms.service';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { TermsController } from './terms.controller';
import { TermsService } from './terms.service';

/**
 * Academic structure: sessions, terms, classes and class arms.
 */
@Module({
  controllers: [
    AcademicSessionsController,
    TermsController,
    ClassesController,
    ClassArmsController,
  ],
  providers: [
    AcademicSessionsService,
    TermsService,
    ClassesService,
    ClassArmsService,
  ],
  exports: [
    AcademicSessionsService,
    TermsService,
    ClassesService,
    ClassArmsService,
  ],
})
export class AcademicsModule {}
