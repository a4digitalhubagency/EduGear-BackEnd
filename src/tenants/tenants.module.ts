import { Module } from '@nestjs/common';
import { PermissionCatalogService } from './permission-catalog.service';
import { SchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';

@Module({
  controllers: [SchoolsController],
  providers: [SchoolsService, PermissionCatalogService],
  exports: [SchoolsService, PermissionCatalogService],
})
export class TenantsModule {}
