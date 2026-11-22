import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { RetentionService } from './retention.service';
import { StudentExportService } from './student-export.service';

/**
 * Enforcement of `docs/legal/retention-schedule.md`, plus the per-student
 * export that sections 34(1)(b) and 38 entitle a data subject to.
 *
 * They live together because they are two halves of the same promise: we will
 * give you your data, and we will stop holding what we no longer need.
 */
@Module({
  imports: [FilesModule],
  providers: [RetentionService, StudentExportService],
  exports: [RetentionService, StudentExportService],
})
export class RetentionModule {}
