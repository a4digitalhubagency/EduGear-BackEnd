import { Module } from '@nestjs/common';
import { ResultsModule } from '../results/results.module';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';

/** Imports Results so report cards can print attendance. */
@Module({
  imports: [ResultsModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
