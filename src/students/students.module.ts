import { Module } from '@nestjs/common';
import { AcademicsModule } from '../academics/academics.module';
import { TenantsModule } from '../tenants/tenants.module';
import { RetentionModule } from '../retention/retention.module';
import { StudentsController } from './students.controller';
import { StudentImportService } from './student-import.service';
import { StudentsService } from './students.service';

/** Depends on AcademicsModule for the class-arm capacity check. */
@Module({
  imports: [AcademicsModule, TenantsModule, RetentionModule],
  controllers: [StudentsController],
  providers: [StudentsService, StudentImportService],
  exports: [StudentsService],
})
export class StudentsModule {}
