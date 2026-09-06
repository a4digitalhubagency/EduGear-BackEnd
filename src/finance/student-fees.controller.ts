import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
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
  AssignFeeDto,
  AssignFeeResultDto,
  DiscountFeeDto,
  QueryStudentFeesDto,
  StudentFeeDto,
  WaiveFeeDto,
} from './dto/student-fee.dto';
import { StudentFeesService } from './student-fees.service';

@ApiTags('Finance')
@ApiBearerAuth()
@Controller('finance/invoices')
export class StudentFeesController {
  constructor(
    private readonly invoices: StudentFeesService,
    private readonly audit: AuditService,
  ) {}

  @Post('assign')
  @RequirePermissions(PERMISSIONS.FINANCE_CREATE)
  @ApiOperation({
    summary: 'Issue invoices from a published fee structure',
    description:
      'Bills a whole class arm or a named list. Students already invoiced for the structure are skipped.',
  })
  @ApiCreatedResponse({ type: AssignFeeResultDto })
  async assign(
    @Body() dto: AssignFeeDto,
    @CurrentSchool() schoolId: string,
  ): Promise<AssignFeeResultDto> {
    const result = await this.invoices.assign(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.FEE_ASSIGNED,
      entityType: 'FeeStructure',
      entityId: dto.structureId,
      description: `Issued ${result.assigned} invoice(s) totalling ₦${result.totalBilled}`,
      metadata: { assigned: result.assigned, skipped: result.skipped },
    });
    return result;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({ summary: 'List invoices' })
  list(
    @Query() query: QueryStudentFeesDto,
  ): Promise<PaginatedDto<StudentFeeDto>> {
    return this.invoices.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({ summary: 'Get one invoice with its line items' })
  @ApiOkResponse({ type: StudentFeeDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<StudentFeeDto> {
    return this.invoices.findOne(id);
  }

  @Post(':id/discount')
  @RequirePermissions(PERMISSIONS.FINANCE_UPDATE)
  @ApiOperation({ summary: 'Apply a discount to an invoice' })
  @ApiOkResponse({ type: StudentFeeDto })
  @HttpCode(HttpStatus.OK)
  async discount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DiscountFeeDto,
  ): Promise<StudentFeeDto> {
    const invoice = await this.invoices.discount(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.FEE_DISCOUNTED,
      entityType: 'StudentFee',
      entityId: invoice.id,
      description: `Discounted ₦${dto.amount} for ${invoice.studentName}`,
      metadata: { amount: dto.amount, reason: dto.reason },
    });
    return invoice;
  }

  @Post(':id/waive')
  @RequirePermissions(PERMISSIONS.FINANCE_UPDATE)
  @ApiOperation({ summary: 'Write an invoice off entirely' })
  @ApiOkResponse({ type: StudentFeeDto })
  @HttpCode(HttpStatus.OK)
  async waive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WaiveFeeDto,
  ): Promise<StudentFeeDto> {
    const invoice = await this.invoices.waive(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.FEE_WAIVED,
      entityType: 'StudentFee',
      entityId: invoice.id,
      description: `Waived ${invoice.structureName} for ${invoice.studentName}`,
      metadata: { reason: dto.reason },
    });
    return invoice;
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.FINANCE_UPDATE)
  @ApiOperation({ summary: 'Cancel an invoice raised in error' })
  @ApiOkResponse({ type: StudentFeeDto })
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WaiveFeeDto,
  ): Promise<StudentFeeDto> {
    const invoice = await this.invoices.cancel(id, dto.reason);
    await this.audit.record({
      action: AUDIT_ACTIONS.FEE_CANCELLED,
      entityType: 'StudentFee',
      entityId: invoice.id,
      metadata: { reason: dto.reason },
    });
    return invoice;
  }
}
