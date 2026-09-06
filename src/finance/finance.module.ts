import { Module } from '@nestjs/common';
import { FeeCategoriesController } from './fee-categories.controller';
import { FeeCategoriesService } from './fee-categories.service';
import { FeeStructuresController } from './fee-structures.controller';
import { FeeStructuresService } from './fee-structures.service';

@Module({
  controllers: [FeeCategoriesController, FeeStructuresController],
  providers: [FeeCategoriesService, FeeStructuresService],
  exports: [FeeCategoriesService, FeeStructuresService],
})
export class FinanceModule {}
