import { Module } from '@nestjs/common';
import { LetterheadService } from './letterhead.service';
import { PermissionCatalogService } from './permission-catalog.service';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { SchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';

@Module({
  controllers: [SchoolsController, RolesController],
  providers: [
    SchoolsService,
    PermissionCatalogService,
    LetterheadService,
    RolesService,
  ],
  exports: [
    SchoolsService,
    PermissionCatalogService,
    LetterheadService,
    RolesService,
  ],
})
export class TenantsModule {}
