import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import { AuthContext } from '../common/context/request-context';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import {
  CreateRoleDto,
  ReassignMembersDto,
  SetRolePermissionsDto,
  UpdateRoleDto,
} from './dto/role.dto';
import { RoleDto } from './dto/school.dto';
import { RolesService } from './roles.service';

/**
 * Role administration. Reads need roles.read; every change needs roles.update
 * *and* passes the no-escalation rule in RolesService.
 */
@ApiTags('School')
@ApiBearerAuth()
@Controller('schools/me/roles')
export class RolesController {
  constructor(
    private readonly roles: RolesService,
    private readonly audit: AuditService,
  ) {}

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ROLES_READ)
  @ApiOperation({ summary: 'One role and its permissions' })
  @ApiOkResponse({ type: RoleDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<RoleDto> {
    return this.roles.findOne(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ROLES_UPDATE)
  @ApiOperation({
    summary: 'Create a role',
    description: 'You can only grant permissions you hold yourself.',
  })
  @ApiCreatedResponse({ type: RoleDto })
  async create(
    @Body() dto: CreateRoleDto,
    @CurrentUser() user: AuthContext,
  ): Promise<RoleDto> {
    const role = await this.roles.create(dto, user);
    await this.audit.record({
      action: AUDIT_ACTIONS.ROLE_CREATED,
      entityType: 'Role',
      entityId: role.id,
      description: `Created role ${role.name}`,
      metadata: { permissions: role.permissions },
    });
    return role;
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ROLES_UPDATE)
  @ApiOperation({ summary: 'Rename a role or change its description' })
  @ApiOkResponse({ type: RoleDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<RoleDto> {
    const role = await this.roles.update(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.ROLE_UPDATED,
      entityType: 'Role',
      entityId: id,
      metadata: { fields: Object.keys(dto) },
    });
    return role;
  }

  @Put(':id/permissions')
  @RequirePermissions(PERMISSIONS.ROLES_UPDATE)
  @ApiOperation({
    summary: 'Replace a role’s permissions',
    description:
      'Send the complete set. Everyone holding the role is affected at once.',
  })
  @ApiOkResponse({ type: RoleDto })
  async setPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRolePermissionsDto,
    @CurrentUser() user: AuthContext,
  ): Promise<RoleDto> {
    const { role, added, removed } = await this.roles.setPermissions(
      id,
      dto,
      user,
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.ROLE_PERMISSIONS_UPDATED,
      entityType: 'Role',
      entityId: id,
      description: `${role.name}: +${added.length} / -${removed.length} permission(s)`,
      metadata: { added, removed, memberCount: role.memberCount },
    });
    return role;
  }

  @Post(':id/reassign-members')
  @RequirePermissions(PERMISSIONS.ROLES_UPDATE)
  @ApiOperation({
    summary: 'Move everyone in this role to another',
    description: 'How a role in use is emptied before deleting it.',
  })
  @HttpCode(HttpStatus.OK)
  async reassign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReassignMembersDto,
    @CurrentUser() user: AuthContext,
  ): Promise<{ moved: number }> {
    const result = await this.roles.reassignMembers(id, dto, user);
    await this.audit.record({
      action: AUDIT_ACTIONS.ROLE_MEMBERS_REASSIGNED,
      entityType: 'Role',
      entityId: id,
      description: `Moved ${result.moved} member(s) to another role`,
      metadata: { toRoleId: dto.toRoleId, moved: result.moved },
    });
    return result;
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ROLES_UPDATE)
  @ApiOperation({ summary: 'Delete a custom role that nobody holds' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.roles.remove(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.ROLE_DELETED,
      entityType: 'Role',
      entityId: id,
    });
  }
}
