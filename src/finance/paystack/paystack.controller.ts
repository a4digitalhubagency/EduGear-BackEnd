import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AUDIT_ACTIONS } from '../../audit/audit-actions';
import { AuditService } from '../../audit/audit.service';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentSchool,
  CurrentUser,
  RequirePermissions,
} from '../../common/decorators';
import type { AuthContext } from '../../common/context/request-context';
import {
  OnlinePaymentStatusDto,
  StartOnlinePaymentDto,
  StartedPaymentResponseDto,
} from '../dto/payment.dto';
import { PaystackService } from './paystack.service';

/**
 * Staff-initiated online payments — a bursar generating a payment link for a
 * parent standing at the counter, and the manual re-check for when a webhook
 * never arrived.
 */
@ApiTags('Finance')
@ApiBearerAuth()
@Controller('finance/payments/online')
export class PaystackController {
  constructor(
    private readonly paystack: PaystackService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.FINANCE_CREATE)
  @ApiOperation({
    summary: 'Start an online payment and get its checkout link',
    description:
      'Creates a PENDING payment. Only the provider can move it to VERIFIED.',
  })
  @ApiCreatedResponse({ type: StartedPaymentResponseDto })
  async start(
    @Body() dto: StartOnlinePaymentDto,
    @CurrentUser() user: AuthContext,
    @CurrentSchool() schoolId: string,
  ): Promise<StartedPaymentResponseDto> {
    const started = await this.paystack.start(dto, user.email, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.PAYMENT_ONLINE_STARTED,
      entityType: 'Payment',
      entityId: started.paymentId,
      description: `Started an online payment of ₦${started.amount}`,
      metadata: { reference: started.reference },
    });
    return started;
  }

  @Post(':id/refresh')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({
    summary: 'Ask the provider what happened to a pending online payment',
    description:
      'The fallback for a webhook that never arrived. It applies only what ' +
      'the provider confirms, so it is not a substitute for verification.',
  })
  @ApiOkResponse({ type: OnlinePaymentStatusDto })
  @HttpCode(HttpStatus.OK)
  refresh(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OnlinePaymentStatusDto> {
    return this.paystack.refresh(id);
  }
}
