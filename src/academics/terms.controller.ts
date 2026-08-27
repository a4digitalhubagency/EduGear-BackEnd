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
  CreateTermDto,
  QueryTermsDto,
  TermDto,
  UpdateTermDto,
} from './dto/term.dto';
import { TermsService } from './terms.service';

/**
 * Terms are addressed flatly rather than nested under their session. A nested
 * path (/sessions/:a/terms/:b) invites `:a` and the term's real parent to
 * disagree; the session is supplied once, on create, and never moves.
 */
@ApiTags('Academics')
@ApiBearerAuth()
@Controller('academics/terms')
export class TermsController {
  constructor(
    private readonly terms: TermsService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.ACADEMICS_CREATE)
  @ApiOperation({ summary: 'Create a term within a session' })
  @ApiCreatedResponse({ type: TermDto })
  async create(
    @Body() dto: CreateTermDto,
    @CurrentSchool() schoolId: string,
  ): Promise<TermDto> {
    const term = await this.terms.create(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.TERM_CREATED,
      entityType: 'Term',
      entityId: term.id,
      description: `Created ${term.name} term of ${term.sessionName}`,
      metadata: { sessionId: term.sessionId, name: term.name },
    });
    return term;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({ summary: 'List terms' })
  list(@Query() query: QueryTermsDto): Promise<PaginatedDto<TermDto>> {
    return this.terms.list(query);
  }

  // Declared before ':id' so "current" is not parsed as a UUID.
  @Get('current')
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({ summary: 'Get the current term' })
  @ApiOkResponse({ type: TermDto })
  findCurrent(): Promise<TermDto> {
    return this.terms.findCurrent();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({ summary: 'Get one term' })
  @ApiOkResponse({ type: TermDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<TermDto> {
    return this.terms.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_UPDATE)
  @ApiOperation({ summary: 'Update a term' })
  @ApiOkResponse({ type: TermDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTermDto,
  ): Promise<TermDto> {
    const term = await this.terms.update(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.TERM_UPDATED,
      entityType: 'Term',
      entityId: term.id,
      metadata: { fields: Object.keys(dto) },
    });
    return term;
  }

  @Post(':id/set-current')
  @RequirePermissions(PERMISSIONS.ACADEMICS_UPDATE)
  @ApiOperation({ summary: 'Make this the current term' })
  @ApiOkResponse({ type: TermDto })
  @HttpCode(HttpStatus.OK)
  async setCurrent(@Param('id', ParseUUIDPipe) id: string): Promise<TermDto> {
    const term = await this.terms.setCurrent(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.TERM_SET_CURRENT,
      entityType: 'Term',
      entityId: term.id,
      description: `${term.name} term of ${term.sessionName} is now current`,
    });
    return term;
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_DELETE)
  @ApiOperation({ summary: 'Delete a term' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.terms.remove(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.TERM_DELETED,
      entityType: 'Term',
      entityId: id,
    });
  }
}
