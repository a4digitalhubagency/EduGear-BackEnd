import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { TenantsModule } from '../tenants/tenants.module';
import { FeeCategoriesController } from './fee-categories.controller';
import { FeeCategoriesService } from './fee-categories.service';
import { FeeStructuresController } from './fee-structures.controller';
import { FeeStructuresService } from './fee-structures.service';
import { FinanceDocumentsController } from './finance-documents.controller';
import { FinanceDocumentsService } from './finance-documents.service';
import { FinanceReportsController } from './finance-reports.controller';
import { FinanceReportsService } from './finance-reports.service';
import { PaymentRemindersService } from './payment-reminders.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaystackClient } from './paystack/paystack.client';
import { PaystackController } from './paystack/paystack.controller';
import { PaystackService } from './paystack/paystack.service';
import { PaystackWebhookController } from './paystack/paystack-webhook.controller';
import { StudentFeesController } from './student-fees.controller';
import { StudentFeesService } from './student-fees.service';

@Module({
  imports: [NotificationsModule, TenantsModule],
  controllers: [
    FeeCategoriesController,
    FeeStructuresController,
    StudentFeesController,
    PaymentsController,
    FinanceReportsController,
    FinanceDocumentsController,
    PaystackController,
    PaystackWebhookController,
  ],
  providers: [
    FeeCategoriesService,
    FeeStructuresService,
    StudentFeesService,
    PaymentsService,
    FinanceReportsService,
    PaymentRemindersService,
    FinanceDocumentsService,
    PaystackClient,
    PaystackService,
  ],
  exports: [
    FeeCategoriesService,
    FeeStructuresService,
    StudentFeesService,
    PaymentsService,
    FinanceDocumentsService,
    PaystackService,
  ],
})
export class FinanceModule {}
