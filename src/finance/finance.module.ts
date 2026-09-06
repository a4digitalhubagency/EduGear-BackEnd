import { Module } from '@nestjs/common';
import { FeeCategoriesController } from './fee-categories.controller';
import { FeeCategoriesService } from './fee-categories.service';
import { FeeStructuresController } from './fee-structures.controller';
import { FeeStructuresService } from './fee-structures.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StudentFeesController } from './student-fees.controller';
import { StudentFeesService } from './student-fees.service';

@Module({
  controllers: [
    FeeCategoriesController,
    FeeStructuresController,
    StudentFeesController,
    PaymentsController,
  ],
  providers: [
    FeeCategoriesService,
    FeeStructuresService,
    StudentFeesService,
    PaymentsService,
  ],
  exports: [FeeCategoriesService, FeeStructuresService, StudentFeesService],
})
export class FinanceModule {}
