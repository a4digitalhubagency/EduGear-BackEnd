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
import { AcademicSessionsService } from './academic-sessions.service';
import {
  AcademicSessionDto,
  CreateAcademicSessionDto,
  QueryAcademicSessionsDto,
  UpdateAcademicSessionDto,
} from './dto/academic-session.dto';

@ApiTags('Academics')
@ApiBearerAuth()
@Controller('academics/sessions')
export class AcademicSessionsController {
  constructor(
    private readonly sessions: AcademicSessionsService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.ACADEMICS_CREATE)
  @ApiOperation({ summary: 'Create an academic session' })
  @ApiCreatedResponse({ type: AcademicSessionDto })
  async create(
    @Body() dto: CreateAcademicSessionDto,
    @CurrentSchool() schoolId: string,
  ): Promise<AcademicSessionDto> {
    const session = await this.sessions.create(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.ACADEMIC_SESSION_CREATED,
      entityType: 'AcademicSession',
      entityId: session.id,
      description: `Created session ${session.name}`,
      metadata: { name: session.name, isCurrent: session.isCurrent },
    });
    return session;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({ summary: 'List academic sessions' })
  list(
    @Query() query: QueryAcademicSessionsDto,
  ): Promise<PaginatedDto<AcademicSessionDto>> {
    return this.sessions.list(query);
  }

  // Declared before ':id' so "current" is not parsed as a UUID.
  @Get('current')
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({ summary: 'Get the current academic session' })
  @ApiOkResponse({ type: AcademicSessionDto })
  findCurrent(): Promise<AcademicSessionDto> {
    return this.sessions.findCurrent();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({ summary: 'Get one academic session' })
  @ApiOkResponse({ type: AcademicSessionDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<AcademicSessionDto> {
    return this.sessions.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_UPDATE)
  @ApiOperation({ summary: 'Update an academic session' })
  @ApiOkResponse({ type: AcademicSessionDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAcademicSessionDto,
  ): Promise<AcademicSessionDto> {
    const session = await this.sessions.update(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.ACADEMIC_SESSION_UPDATED,
      entityType: 'AcademicSession',
      entityId: session.id,
      metadata: { fields: Object.keys(dto) },
    });
    return session;
  }

  @Post(':id/set-current')
  @RequirePermissions(PERMISSIONS.ACADEMICS_UPDATE)
  @ApiOperation({ summary: 'Make this the current academic session' })
  @ApiOkResponse({ type: AcademicSessionDto })
  @HttpCode(HttpStatus.OK)
  async setCurrent(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AcademicSessionDto> {
    const session = await this.sessions.setCurrent(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.ACADEMIC_SESSION_SET_CURRENT,
      entityType: 'AcademicSession',
      entityId: session.id,
      description: `${session.name} is now the current session`,
    });
    return session;
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_DELETE)
  @ApiOperation({ summary: 'Delete an academic session' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.sessions.remove(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.ACADEMIC_SESSION_DELETED,
      entityType: 'AcademicSession',
      entityId: id,
    });
  }
}
