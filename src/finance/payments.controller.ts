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
  PaymentDto,
  QueryPaymentsDto,
  RecordPaymentDto,
  RejectPaymentDto,
} from './dto/payment.dto';
import { PaymentsService } from './payments.service';

@ApiTags('Finance')
@ApiBearerAuth()
@Controller('finance/payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.FINANCE_CREATE)
  @ApiOperation({
    summary: 'Record a payment',
    description:
      'Lands as PENDING and changes no balance until a bursar verifies it.',
  })
  @ApiCreatedResponse({ type: PaymentDto })
  async record(
    @Body() dto: RecordPaymentDto,
    @CurrentSchool() schoolId: string,
  ): Promise<PaymentDto> {
    const payment = await this.payments.record(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.PAYMENT_RECORDED,
      entityType: 'Payment',
      entityId: payment.id,
      description: `Recorded ₦${payment.amount} for ${payment.studentName}`,
      metadata: { method: payment.method, reference: payment.reference },
    });
    return payment;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({ summary: 'List payments' })
  list(@Query() query: QueryPaymentsDto): Promise<PaginatedDto<PaymentDto>> {
    return this.payments.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({ summary: 'Get one payment' })
  @ApiOkResponse({ type: PaymentDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentDto> {
    return this.payments.findOne(id);
  }

  @Post(':id/verify')
  @RequirePermissions(PERMISSIONS.FINANCE_VERIFY)
  @ApiOperation({
    summary: 'Verify a payment and issue its receipt',
    description: 'The only action that reduces an invoice balance.',
  })
  @ApiOkResponse({ type: PaymentDto })
  @HttpCode(HttpStatus.OK)
  async verify(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentDto> {
    const payment = await this.payments.verify(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.PAYMENT_VERIFIED,
      entityType: 'Payment',
      entityId: payment.id,
      description: `Verified ₦${payment.amount} — receipt ${payment.receiptNumber}`,
      metadata: {
        receiptNumber: payment.receiptNumber,
        invoiceBalance: payment.invoiceBalance,
      },
    });
    return payment;
  }

  @Post(':id/reject')
  @RequirePermissions(PERMISSIONS.FINANCE_VERIFY)
  @ApiOperation({
    summary: 'Reject a payment',
    description: 'Reverses it if it had already been verified.',
  })
  @ApiOkResponse({ type: PaymentDto })
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectPaymentDto,
  ): Promise<PaymentDto> {
    const payment = await this.payments.reject(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.PAYMENT_REJECTED,
      entityType: 'Payment',
      entityId: payment.id,
      description: `Rejected ₦${payment.amount} for ${payment.studentName}`,
      metadata: { reason: dto.reason },
    });
    return payment;
  }
}
