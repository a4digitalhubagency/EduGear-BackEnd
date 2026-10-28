import { Module } from '@nestjs/common';
import { ResultsModule } from '../results/results.module';
import { TenantsModule } from '../tenants/tenants.module';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';

/**
 * Imports Results so report cards can print attendance, and Tenants for the
 * school's own week — which days a register may be taken for at all.
 */
@Module({
  imports: [ResultsModule, TenantsModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
