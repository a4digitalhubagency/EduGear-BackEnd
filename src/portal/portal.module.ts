import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { FinanceModule } from '../finance/finance.module';
import { ResultsModule } from '../results/results.module';
import { UsersModule } from '../users/users.module';
import { GuardianPortalController } from './guardian-portal.controller';
import { PortalAccessService } from './portal-access.service';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

/**
 * The parent portal reads across finance, results and attendance, but only
 * through their services — never their tables — so each keeps its own rules.
 */
@Module({
  imports: [FinanceModule, ResultsModule, AttendanceModule, UsersModule],
  controllers: [PortalController, GuardianPortalController],
  providers: [PortalService, PortalAccessService],
})
export class PortalModule {}
