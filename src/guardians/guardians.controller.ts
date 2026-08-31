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
  Query,
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
import { PaginatedDto } from '../common/dto/pagination.dto';
import {
  CreateGuardianDto,
  GuardianDto,
  GuardianProfileDto,
  QueryGuardiansDto,
  UpdateGuardianDto,
} from './dto/guardian.dto';
import { GuardiansService } from './guardians.service';

@ApiTags('Guardians')
@ApiBearerAuth()
@Controller('guardians')
export class GuardiansController {
  constructor(
    private readonly guardians: GuardiansService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.GUARDIANS_CREATE)
  @ApiOperation({ summary: 'Create a guardian' })
  @ApiCreatedResponse({ type: GuardianDto })
  async create(
    @Body() dto: CreateGuardianDto,
    @CurrentSchool() schoolId: string,
  ): Promise<GuardianDto> {
    const guardian = await this.guardians.create(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.GUARDIAN_CREATED,
      entityType: 'Guardian',
      entityId: guardian.id,
      description: `Created guardian ${guardian.fullName}`,
    });
    return guardian;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.GUARDIANS_READ)
  @ApiOperation({ summary: 'List guardians' })
  list(@Query() query: QueryGuardiansDto): Promise<PaginatedDto<GuardianDto>> {
    return this.guardians.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.GUARDIANS_READ)
  @ApiOperation({ summary: 'Get a guardian and their wards' })
  @ApiOkResponse({ type: GuardianProfileDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<GuardianProfileDto> {
    return this.guardians.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.GUARDIANS_UPDATE)
  @ApiOperation({ summary: 'Update a guardian' })
  @ApiOkResponse({ type: GuardianDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGuardianDto,
  ): Promise<GuardianDto> {
    const guardian = await this.guardians.update(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.GUARDIAN_UPDATED,
      entityType: 'Guardian',
      entityId: guardian.id,
      metadata: { fields: Object.keys(dto) },
    });
    return guardian;
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.GUARDIANS_DELETE)
  @ApiOperation({ summary: 'Delete a guardian' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.guardians.remove(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.GUARDIAN_DELETED,
      entityType: 'Guardian',
      entityId: id,
    });
  }
}
