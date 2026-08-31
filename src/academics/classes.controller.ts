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
import { ClassesService } from './classes.service';
import {
  ClassDto,
  CreateClassDto,
  QueryClassesDto,
  UpdateClassDto,
} from './dto/class.dto';

@ApiTags('Academics')
@ApiBearerAuth()
@Controller('academics/classes')
export class ClassesController {
  constructor(
    private readonly classes: ClassesService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.ACADEMICS_CREATE)
  @ApiOperation({ summary: 'Create a class' })
  @ApiCreatedResponse({ type: ClassDto })
  async create(
    @Body() dto: CreateClassDto,
    @CurrentSchool() schoolId: string,
  ): Promise<ClassDto> {
    const created = await this.classes.create(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.CLASS_CREATED,
      entityType: 'Class',
      entityId: created.id,
      description: `Created class ${created.name} (level ${created.level})`,
    });
    return created;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({ summary: 'List classes' })
  list(@Query() query: QueryClassesDto): Promise<PaginatedDto<ClassDto>> {
    return this.classes.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({ summary: 'Get one class' })
  @ApiOkResponse({ type: ClassDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ClassDto> {
    return this.classes.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_UPDATE)
  @ApiOperation({ summary: 'Update a class' })
  @ApiOkResponse({ type: ClassDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClassDto,
  ): Promise<ClassDto> {
    const updated = await this.classes.update(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.CLASS_UPDATED,
      entityType: 'Class',
      entityId: updated.id,
      metadata: { fields: Object.keys(dto) },
    });
    return updated;
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_DELETE)
  @ApiOperation({ summary: 'Delete a class' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.classes.remove(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.CLASS_DELETED,
      entityType: 'Class',
      entityId: id,
    });
  }
}
