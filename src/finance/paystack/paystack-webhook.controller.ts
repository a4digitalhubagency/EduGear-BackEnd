import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AllowNoTenant, Public } from '../../common/decorators';
import { PaystackService } from './paystack.service';

/** Express gives us the bytes because `applyHttpSettings` asked it to keep them. */
type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * Paystack's callback. Public by necessity — there is no user behind it — so
 * the signature over the raw body is the whole of its authentication, and the
 * tenant is resolved from the payment the reference names, never from the
 * payload's own claim about which school it belongs to.
 *
 * Deliberately outside `/finance`: a webhook is not a staff route, and putting
 * it there would make it easy to assume it is guarded like one.
 */
@ApiExcludeController()
@Controller('webhooks/paystack')
export class PaystackWebhookController {
  constructor(private readonly paystack: PaystackService) {}

  @Post()
  @Public()
  @AllowNoTenant()
  // Well above Paystack's delivery and retry rate, but still a ceiling: an
  // unsigned flood costs one HMAC each and never reaches the database.
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: RawBodyRequest,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    // Anything Paystack cannot fix by retrying comes back as 200 with the
    // outcome named, so the delivery is not retried for hours; a genuine
    // failure throws instead and is left unacknowledged.
    const outcome = await this.paystack.handleWebhook(
      request.rawBody,
      request.header('x-paystack-signature'),
      body,
    );
    return { status: outcome };
  }
}
