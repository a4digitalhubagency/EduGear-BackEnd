import { Module } from '@nestjs/common';
import { AcademicsModule } from '../academics/academics.module';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

/** Depends on AcademicsModule for the class-arm capacity check. */
@Module({
  imports: [AcademicsModule],
  controllers: [StudentsController],
  providers: [StudentsService],
  exports: [StudentsService],
})
export class StudentsModule {}
