import { Module } from '@nestjs/common';
import { LetterheadService } from './letterhead.service';
import { PermissionCatalogService } from './permission-catalog.service';
import { SchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';

@Module({
  controllers: [SchoolsController],
  providers: [SchoolsService, PermissionCatalogService, LetterheadService],
  exports: [SchoolsService, PermissionCatalogService, LetterheadService],
})
export class TenantsModule {}
