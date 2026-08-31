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
import { ClassArmsService } from './class-arms.service';
import {
  ClassArmDto,
  CreateClassArmDto,
  QueryClassArmsDto,
  UpdateClassArmDto,
} from './dto/class-arm.dto';

/** Flat, like terms: the parent class is set on create and never moves. */
@ApiTags('Academics')
@ApiBearerAuth()
@Controller('academics/class-arms')
export class ClassArmsController {
  constructor(
    private readonly arms: ClassArmsService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.ACADEMICS_CREATE)
  @ApiOperation({ summary: 'Create an arm within a class' })
  @ApiCreatedResponse({ type: ClassArmDto })
  async create(
    @Body() dto: CreateClassArmDto,
    @CurrentSchool() schoolId: string,
  ): Promise<ClassArmDto> {
    const arm = await this.arms.create(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.CLASS_ARM_CREATED,
      entityType: 'ClassArm',
      entityId: arm.id,
      description: `Created arm ${arm.fullName}`,
      metadata: { classId: arm.classId },
    });
    return arm;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({ summary: 'List class arms' })
  list(@Query() query: QueryClassArmsDto): Promise<PaginatedDto<ClassArmDto>> {
    return this.arms.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({ summary: 'Get one class arm' })
  @ApiOkResponse({ type: ClassArmDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ClassArmDto> {
    return this.arms.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_UPDATE)
  @ApiOperation({ summary: 'Update a class arm' })
  @ApiOkResponse({ type: ClassArmDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClassArmDto,
  ): Promise<ClassArmDto> {
    const arm = await this.arms.update(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.CLASS_ARM_UPDATED,
      entityType: 'ClassArm',
      entityId: arm.id,
      metadata: { fields: Object.keys(dto) },
    });
    return arm;
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_DELETE)
  @ApiOperation({ summary: 'Delete a class arm' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.arms.remove(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.CLASS_ARM_DELETED,
      entityType: 'ClassArm',
      entityId: id,
    });
  }
}
