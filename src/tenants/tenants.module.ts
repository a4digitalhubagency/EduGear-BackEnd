import { Module } from '@nestjs/common';
import { LetterheadService } from './letterhead.service';
import { PermissionCatalogService } from './permission-catalog.service';
import { RolesController } from './roles.controller';
import { SchoolSettingsController } from './school-settings.controller';
import { SchoolSettingsService } from './school-settings.service';
import { RolesService } from './roles.service';
import { SchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';

@Module({
  controllers: [SchoolsController, RolesController, SchoolSettingsController],
  providers: [
    SchoolsService,
    PermissionCatalogService,
    LetterheadService,
    RolesService,
    SchoolSettingsService,
  ],
  exports: [
    SchoolsService,
    PermissionCatalogService,
    LetterheadService,
    RolesService,
    SchoolSettingsService,
  ],
})
export class TenantsModule {}
