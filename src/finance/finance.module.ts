import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { FeeCategoriesController } from './fee-categories.controller';
import { FeeCategoriesService } from './fee-categories.service';
import { FeeStructuresController } from './fee-structures.controller';
import { FeeStructuresService } from './fee-structures.service';
import { FinanceReportsController } from './finance-reports.controller';
import { FinanceReportsService } from './finance-reports.service';
import { PaymentRemindersService } from './payment-reminders.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StudentFeesController } from './student-fees.controller';
import { StudentFeesService } from './student-fees.service';

@Module({
  imports: [NotificationsModule],
  controllers: [
    FeeCategoriesController,
    FeeStructuresController,
    StudentFeesController,
    PaymentsController,
    FinanceReportsController,
  ],
  providers: [
    FeeCategoriesService,
    FeeStructuresService,
    StudentFeesService,
    PaymentsService,
    FinanceReportsService,
    PaymentRemindersService,
  ],
  exports: [FeeCategoriesService, FeeStructuresService, StudentFeesService],
})
export class FinanceModule {}
