import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { AuthContext } from '../common/context/request-context';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { PortalAccessDto } from './dto/portal.dto';
import { PortalAccessService } from './portal-access.service';

/** The staff side of parent logins. */
@ApiTags('Guardians')
@ApiBearerAuth()
@Controller('guardians/:guardianId/portal-access')
export class GuardianPortalController {
  constructor(
    private readonly access: PortalAccessService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.GUARDIANS_READ)
  @ApiOperation({ summary: 'Whether a parent has a portal login' })
  @ApiOkResponse({ type: PortalAccessDto })
  status(
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
  ): Promise<PortalAccessDto> {
    return this.access.status(guardianId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.GUARDIANS_UPDATE)
  @ApiOperation({
    summary: 'Invite a parent to the portal, or re-send the invitation',
    description: 'Needs an email on file. A re-send retires the earlier link.',
  })
  @ApiOkResponse({ type: PortalAccessDto })
  async invite(
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<PortalAccessDto> {
    const result = await this.access.invite(guardianId, user);
    await this.audit.record({
      action: AUDIT_ACTIONS.PORTAL_INVITED,
      entityType: 'Guardian',
      entityId: guardianId,
      metadata: { email: result.email },
    });
    return result;
  }

  @Delete()
  @RequirePermissions(PERMISSIONS.GUARDIANS_UPDATE)
  @ApiOperation({ summary: 'Revoke a parent’s portal login' })
  @ApiOkResponse({ type: PortalAccessDto })
  async revoke(
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
  ): Promise<PortalAccessDto> {
    const result = await this.access.revoke(guardianId);
    await this.audit.record({
      action: AUDIT_ACTIONS.PORTAL_REVOKED,
      entityType: 'Guardian',
      entityId: guardianId,
    });
    return result;
  }
}
