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
  CreateFeeStructureDto,
  FeeStructureDto,
  QueryFeeStructuresDto,
  UpdateFeeStructureDto,
} from './dto/fee-structure.dto';
import { FeeStructuresService } from './fee-structures.service';

@ApiTags('Finance')
@ApiBearerAuth()
@Controller('finance/fee-structures')
export class FeeStructuresController {
  constructor(
    private readonly structures: FeeStructuresService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.FINANCE_CREATE)
  @ApiOperation({
    summary: 'Create a fee structure',
    description: 'Starts as DRAFT; publish it before assigning students.',
  })
  @ApiCreatedResponse({ type: FeeStructureDto })
  async create(
    @Body() dto: CreateFeeStructureDto,
    @CurrentSchool() schoolId: string,
  ): Promise<FeeStructureDto> {
    const structure = await this.structures.create(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.FEE_STRUCTURE_CREATED,
      entityType: 'FeeStructure',
      entityId: structure.id,
      description: `Created fee structure ${structure.name}`,
      metadata: { totalAmount: structure.totalAmount },
    });
    return structure;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({ summary: 'List fee structures' })
  list(
    @Query() query: QueryFeeStructuresDto,
  ): Promise<PaginatedDto<FeeStructureDto>> {
    return this.structures.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({ summary: 'Get one fee structure' })
  @ApiOkResponse({ type: FeeStructureDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<FeeStructureDto> {
    return this.structures.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.FINANCE_UPDATE)
  @ApiOperation({ summary: 'Update a fee structure' })
  @ApiOkResponse({ type: FeeStructureDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFeeStructureDto,
  ): Promise<FeeStructureDto> {
    const structure = await this.structures.update(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.FEE_STRUCTURE_UPDATED,
      entityType: 'FeeStructure',
      entityId: structure.id,
      metadata: { fields: Object.keys(dto) },
    });
    return structure;
  }

  @Post(':id/publish')
  @RequirePermissions(PERMISSIONS.FINANCE_UPDATE)
  @ApiOperation({ summary: 'Publish a fee structure so it can be assigned' })
  @ApiOkResponse({ type: FeeStructureDto })
  @HttpCode(HttpStatus.OK)
  async publish(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FeeStructureDto> {
    const structure = await this.structures.publish(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.FEE_STRUCTURE_PUBLISHED,
      entityType: 'FeeStructure',
      entityId: structure.id,
      description: `Published ${structure.name} (₦${structure.totalAmount})`,
    });
    return structure;
  }

  @Post(':id/archive')
  @RequirePermissions(PERMISSIONS.FINANCE_UPDATE)
  @ApiOperation({ summary: 'Archive a fee structure' })
  @ApiOkResponse({ type: FeeStructureDto })
  @HttpCode(HttpStatus.OK)
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FeeStructureDto> {
    const structure = await this.structures.archive(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.FEE_STRUCTURE_ARCHIVED,
      entityType: 'FeeStructure',
      entityId: structure.id,
    });
    return structure;
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.FINANCE_UPDATE)
  @ApiOperation({ summary: 'Delete a fee structure with no invoices' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.structures.remove(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.FEE_STRUCTURE_DELETED,
      entityType: 'FeeStructure',
      entityId: id,
    });
  }
}
