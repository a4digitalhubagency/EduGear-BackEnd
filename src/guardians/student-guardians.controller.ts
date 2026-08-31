import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { CurrentSchool, RequirePermissions } from '../common/decorators';
import {
  GuardianProfileDto,
  LinkGuardianDto,
  UpdateGuardianLinkDto,
} from './dto/guardian.dto';
import { GuardiansService } from './guardians.service';

/**
 * Nested, unlike terms and arms: a link has no id of its own — the pair of ids
 * in the path *is* its identity, so there is nothing for the URL to disagree with.
 */
@ApiTags('Guardians')
@ApiBearerAuth()
@Controller('students/:studentId/guardians')
export class StudentGuardiansController {
  constructor(
    private readonly guardians: GuardiansService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.GUARDIANS_UPDATE)
  @ApiOperation({ summary: 'Link a guardian to a student' })
  @ApiCreatedResponse({ type: GuardianProfileDto })
  async link(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() dto: LinkGuardianDto,
    @CurrentSchool() schoolId: string,
  ): Promise<GuardianProfileDto> {
    const guardian = await this.guardians.link(studentId, dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.GUARDIAN_LINKED,
      entityType: 'Student',
      entityId: studentId,
      description: `Linked ${guardian.fullName} as ${dto.relationship}`,
      metadata: {
        guardianId: dto.guardianId,
        relationship: dto.relationship,
        isPrimary: dto.isPrimary ?? false,
      },
    });
    return guardian;
  }

  @Patch(':guardianId')
  @RequirePermissions(PERMISSIONS.GUARDIANS_UPDATE)
  @ApiOperation({ summary: 'Update a student–guardian link' })
  @ApiOkResponse({ type: GuardianProfileDto })
  async updateLink(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
    @Body() dto: UpdateGuardianLinkDto,
  ): Promise<GuardianProfileDto> {
    const guardian = await this.guardians.updateLink(
      studentId,
      guardianId,
      dto,
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.GUARDIAN_LINK_UPDATED,
      entityType: 'Student',
      entityId: studentId,
      metadata: { guardianId, fields: Object.keys(dto) },
    });
    return guardian;
  }

  @Delete(':guardianId')
  @RequirePermissions(PERMISSIONS.GUARDIANS_UPDATE)
  @ApiOperation({ summary: 'Unlink a guardian from a student' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlink(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
  ): Promise<void> {
    await this.guardians.unlink(studentId, guardianId);
    await this.audit.record({
      action: AUDIT_ACTIONS.GUARDIAN_UNLINKED,
      entityType: 'Student',
      entityId: studentId,
      metadata: { guardianId },
    });
  }
}
