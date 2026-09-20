import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { CurrentSchool, RequirePermissions } from '../common/decorators';
import { SchoolSettingsDto, UpdateSchoolSettingsDto } from './dto/settings.dto';
import { SchoolSettingsService } from './school-settings.service';

@ApiTags('School')
@ApiBearerAuth()
@Controller('schools/me/settings')
export class SchoolSettingsController {
  constructor(
    private readonly settings: SchoolSettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SCHOOL_READ)
  @ApiOperation({ summary: 'How this school has configured EduGear' })
  @ApiOkResponse({ type: SchoolSettingsDto })
  current(): Promise<SchoolSettingsDto> {
    return this.settings.view();
  }

  @Patch()
  @RequirePermissions(PERMISSIONS.SCHOOL_UPDATE)
  @ApiOperation({
    summary: 'Change settings',
    description:
      'Takes effect from now on: numbers already issued keep their prefix, and their sequence continues.',
  })
  @ApiOkResponse({ type: SchoolSettingsDto })
  async update(
    @Body() dto: UpdateSchoolSettingsDto,
    @CurrentSchool() schoolId: string,
  ): Promise<SchoolSettingsDto> {
    const { settings, changed } = await this.settings.update(dto, schoolId);
    if (changed.length > 0) {
      await this.audit.record({
        action: AUDIT_ACTIONS.SCHOOL_SETTINGS_UPDATED,
        entityType: 'School',
        entityId: schoolId,
        description: `Changed ${changed.join(', ')}`,
        metadata: { changed, settings: { ...settings } },
      });
    }
    return settings;
  }
}
