import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PERMISSIONS } from '../common/constants/permissions';
import { RequirePermissions } from '../common/decorators';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { RoleDto, SchoolDto, UpdateSchoolDto } from './dto/school.dto';
import { SchoolsService } from './schools.service';

@ApiTags('School')
@ApiBearerAuth()
@Controller('schools')
export class SchoolsController {
  constructor(
    private readonly schools: SchoolsService,
    private readonly audit: AuditService,
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
  ) {}

  @Get('me')
  @RequirePermissions(PERMISSIONS.SCHOOL_READ)
  @ApiOperation({ summary: 'Get the authenticated school profile' })
  @ApiOkResponse({ type: SchoolDto })
  getCurrent(): Promise<SchoolDto> {
    return this.schools.getCurrentSchool();
  }

  @Patch('me')
  @RequirePermissions(PERMISSIONS.SCHOOL_UPDATE)
  @ApiOperation({ summary: 'Update the authenticated school profile' })
  @ApiOkResponse({ type: SchoolDto })
  async update(@Body() dto: UpdateSchoolDto): Promise<SchoolDto> {
    const school = await this.schools.updateCurrentSchool(dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.SCHOOL_UPDATED,
      entityType: 'School',
      entityId: school.id,
      metadata: { fields: Object.keys(dto) },
    });
    return school;
  }

  @Get('me/roles')
  @RequirePermissions(PERMISSIONS.ROLES_READ)
  @ApiOperation({ summary: 'List roles and their permissions for this school' })
  @ApiOkResponse({ type: [RoleDto] })
  listRoles(): Promise<RoleDto[]> {
    return this.schools.listRoles();
  }

  @Get('me/permissions')
  @RequirePermissions(PERMISSIONS.ROLES_READ)
  @ApiOperation({ summary: 'List the permission catalogue' })
  async listPermissions() {
    const permissions = await this.prisma.permission.findMany({
      orderBy: [{ group: 'asc' }, { key: 'asc' }],
    });
    return permissions.map((p) => ({
      key: p.key,
      group: p.group,
      description: p.description,
    }));
  }
}
