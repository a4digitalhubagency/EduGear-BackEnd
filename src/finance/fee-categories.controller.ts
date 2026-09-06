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
  CreateFeeCategoryDto,
  FeeCategoryDto,
  QueryFeeCategoriesDto,
  UpdateFeeCategoryDto,
} from './dto/fee-category.dto';
import { FeeCategoriesService } from './fee-categories.service';

@ApiTags('Finance')
@ApiBearerAuth()
@Controller('finance/fee-categories')
export class FeeCategoriesController {
  constructor(
    private readonly categories: FeeCategoriesService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.FINANCE_CREATE)
  @ApiOperation({ summary: 'Create a fee category' })
  @ApiCreatedResponse({ type: FeeCategoryDto })
  async create(
    @Body() dto: CreateFeeCategoryDto,
    @CurrentSchool() schoolId: string,
  ): Promise<FeeCategoryDto> {
    const category = await this.categories.create(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.FEE_CATEGORY_CREATED,
      entityType: 'FeeCategory',
      entityId: category.id,
      description: `Created fee category ${category.name}`,
    });
    return category;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({ summary: 'List fee categories' })
  list(
    @Query() query: QueryFeeCategoriesDto,
  ): Promise<PaginatedDto<FeeCategoryDto>> {
    return this.categories.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({ summary: 'Get one fee category' })
  @ApiOkResponse({ type: FeeCategoryDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<FeeCategoryDto> {
    return this.categories.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.FINANCE_UPDATE)
  @ApiOperation({ summary: 'Update or retire a fee category' })
  @ApiOkResponse({ type: FeeCategoryDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFeeCategoryDto,
  ): Promise<FeeCategoryDto> {
    const category = await this.categories.update(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.FEE_CATEGORY_UPDATED,
      entityType: 'FeeCategory',
      entityId: category.id,
      metadata: { fields: Object.keys(dto) },
    });
    return category;
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.FINANCE_UPDATE)
  @ApiOperation({ summary: 'Delete an unused fee category' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.categories.remove(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.FEE_CATEGORY_DELETED,
      entityType: 'FeeCategory',
      entityId: id,
    });
  }
}
