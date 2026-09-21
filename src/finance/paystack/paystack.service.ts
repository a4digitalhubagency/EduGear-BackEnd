import { Injectable, Logger } from '@nestjs/common';
import { PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { AUDIT_ACTIONS } from '../../audit/audit-actions';
import { AuditService } from '../../audit/audit.service';
import { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { InjectPrisma } from '../../database/prisma.tokens';
import { TenantAwarePrisma } from '../../database/prisma.service';
import { toAmount } from '../fee-math';
import { PaymentsService } from '../payments.service';
import { StartOnlinePaymentDto } from '../dto/payment.dto';
import { PaystackClient } from './paystack.client';
import {
  isValidSignature,
  parseChargeEvent,
  toKobo,
} from './paystack-signature';

export interface StartedPaymentDto {
  paymentId: string;
  reference: string;
  authorizationUrl: string;
  amount: number;
}

/** What a delivery did. The provider is told 200 for every one of these. */
export type WebhookOutcome =
  'verified' | 'duplicate' | 'ignored' | 'unknown-reference' | 'mismatch';

const PROVIDER = 'paystack';

/**
 * A pending online payment that has had this long to be completed is treated as
 * abandoned — but only after Paystack confirms it was never paid.
 */
const ABANDONED_AFTER_MINUTES = 30;
const MAX_ABANDONED_SWEPT = 5;

/**
 * Online payments through Paystack.
 *
 * A payment is created PENDING before the payer leaves, and only the provider
 * can move it: the webhook is the authority, because it is the only party that
 * knows whether money actually arrived. Verification itself is
 * `PaymentsService.verify` — the same path a bursar takes — so a card payment
 * and a bank transfer get the same receipt numbering, the same recomputed
 * invoice and the same notification.
 *
 * The webhook is public and it moves money, so three things guard it: the
 * signature over the raw body, which proves who sent it; a record of every
 * event already acted on, because providers retry and a retry must not collect
 * twice; and a check that the amount and currency are the ones we asked for
 * before anything is marked paid.
 */
@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly client: PaystackClient,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
  ) {}

  get available(): boolean {
    return this.client.configured;
  }

  /**
   * Creates the pending payment and hands back the page to send the payer to.
   * `PaymentsService.record` does the invoice checks, so an online payment can
   * no more exceed the outstanding amount than a cash one can.
   */
  async start(
    dto: StartOnlinePaymentDto,
    email: string,
    schoolId: string,
  ): Promise<StartedPaymentDto> {
    this.assertAvailable();
    await this.sweepAbandoned(dto.studentFeeId);

    const payment = await this.payments.record(
      {
        studentFeeId: dto.studentFeeId,
        amount: dto.amount,
        method: PaymentMethod.ONLINE,
        paidAt: new Date(),
        note: 'Started online',
      },
      schoolId,
    );

    // Derived from the id, so it is unique without a second round trip and a
    // webhook can be traced back to one payment by eye.
    const reference = `EDU-${payment.id}`;
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { providerReference: reference, reference },
    });

    try {
      const initialized = await this.client.initialize({
        email,
        amountKobo: toKobo(payment.amount),
        reference,
        metadata: {
          paymentId: payment.id,
          schoolId,
          studentId: payment.studentId,
        },
      });

      return {
        paymentId: payment.id,
        reference: initialized.reference,
        authorizationUrl: initialized.authorizationUrl,
        amount: payment.amount,
      };
    } catch (error) {
      // Nothing was collected and the payer never saw a page, so the pending
      // row would only eat into what they can pay next time.
      await this.prisma.payment.deleteMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
      });
      this.logger.error(
        `Could not start an online payment: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw AppException.conflict(
        'Could not reach the payment provider. Please try again.',
      );
    }
  }

  /**
   * Handles one webhook delivery. The caller answers 200 for every outcome:
   * none of them is something the provider can fix by retrying. Anything that
   * *is* worth retrying throws, so the delivery is left unacknowledged.
   */
  async handleWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    body: unknown,
  ): Promise<WebhookOutcome> {
    if (!isValidSignature(rawBody, signature, this.client.secretKey)) {
      // Not from Paystack, or not the bytes they signed. No detail goes back:
      // a forger learns nothing about which half was wrong.
      throw AppException.unauthorized(
        'Invalid webhook signature',
        ErrorCode.TOKEN_INVALID,
      );
    }

    const event = parseChargeEvent(body);
    if (!event) {
      this.logger.warn('Paystack sent an event in a shape we do not read');
      return 'ignored';
    }
    if (event.event !== 'charge.success' || event.status !== 'success') {
      return 'ignored';
    }

    // Claimed before any work, so a retry of the same event stops here whatever
    // happened the first time. Released again only if the work throws.
    // Keyed on the event name too: two different events can share a
    // transaction id, and only one of them is this one.
    const eventKey = `${event.event}:${event.transactionId}`;
    if (!(await this.claimEvent(eventKey, event.reference))) {
      return 'duplicate';
    }

    try {
      const payment = await RequestContext.runAsSystem(() =>
        this.prisma.payment.findUnique({
          where: { providerReference: event.reference },
          select: { id: true, schoolId: true, amount: true },
        }),
      );

      if (!payment) {
        // A reference we never issued, or one whose payment was swept. Nothing
        // to apply, and retrying will not change that — but it should not
        // happen, so it is logged loudly for someone to reconcile by hand.
        this.logger.error(
          `Paystack reported a successful charge on an unknown reference: ${event.reference}`,
        );
        await this.audit.record({
          action: AUDIT_ACTIONS.PAYMENT_ONLINE_MISMATCH,
          entityType: 'Payment',
          description: `Paystack confirmed ${event.reference}, which matches no payment`,
          metadata: {
            reference: event.reference,
            amountKobo: event.amountKobo,
          },
          schoolId: null,
          actorUserId: null,
          membershipId: null,
        });
        return 'unknown-reference';
      }

      const expected = toKobo(toAmount(payment.amount));
      if (event.amountKobo !== expected || event.currency !== 'NGN') {
        // Paid, but not what was asked for. Left PENDING deliberately: a person
        // decides whether to verify it, refund it or write it off.
        this.logger.error(
          `Paystack reported ${event.amountKobo} ${event.currency} for payment ${payment.id}, expected ${expected} NGN — left pending for review`,
        );
        await this.audit.record({
          action: AUDIT_ACTIONS.PAYMENT_ONLINE_MISMATCH,
          entityType: 'Payment',
          entityId: payment.id,
          description: `Paystack reported ${event.amountKobo} ${event.currency}; ${expected} NGN kobo was expected`,
          metadata: {
            reference: event.reference,
            reportedKobo: event.amountKobo,
            expectedKobo: expected,
            currency: event.currency,
          },
          schoolId: payment.schoolId,
          actorUserId: null,
          membershipId: null,
        });
        return 'mismatch';
      }

      // From here the work belongs to that school, with no user behind it.
      return await RequestContext.runForSchool(payment.schoolId, async () => {
        try {
          await this.payments.verify(payment.id);
          await this.audit.record({
            action: AUDIT_ACTIONS.PAYMENT_ONLINE_SETTLED,
            entityType: 'Payment',
            entityId: payment.id,
            description: `Paystack confirmed ${event.reference}`,
            metadata: { reference: event.reference, channel: event.channel },
            actorUserId: null,
            membershipId: null,
          });
          return 'verified' as const;
        } catch (error) {
          // Already verified by the refresh path, or already rejected: either
          // way the event has been dealt with.
          if (AppException.isConflict(error)) return 'duplicate' as const;
          throw error;
        }
      });
    } catch (error) {
      // The claim must not outlive a failure, or the retry that would have
      // fixed it is discarded as a duplicate.
      await this.releaseEvent(eventKey);
      throw error;
    }
  }

  /**
   * The safety net for a webhook that never arrived: asks Paystack what
   * happened and applies the same checks.
   */
  async refresh(paymentId: string): Promise<{ status: PaymentStatus }> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        status: true,
        amount: true,
        providerReference: true,
      },
    });
    if (!payment) throw AppException.notFound('Payment');
    if (!payment.providerReference) {
      throw AppException.conflict('This payment was not started online');
    }
    if (payment.status !== PaymentStatus.PENDING) {
      return { status: payment.status };
    }
    this.assertAvailable();

    const result = await this.client.verify(payment.providerReference);
    if (result.status !== 'success') {
      return { status: PaymentStatus.PENDING };
    }
    if (
      result.amountKobo !== toKobo(toAmount(payment.amount)) ||
      result.currency !== 'NGN'
    ) {
      this.logger.error(
        `Paystack reports a different amount for payment ${payment.id}; leaving it pending`,
      );
      return { status: PaymentStatus.PENDING };
    }

    try {
      await this.payments.verify(payment.id);
    } catch (error) {
      // The webhook won the race between the two calls.
      if (!AppException.isConflict(error)) throw error;
    }
    return { status: PaymentStatus.VERIFIED };
  }

  // ---------------------------------------------------------------------------

  private assertAvailable(): void {
    if (!this.available) {
      throw AppException.conflict(
        'Online payment is not switched on for this school yet',
      );
    }
  }

  /**
   * A payer who closes the browser leaves a pending payment behind, and pending
   * payments count toward the invoice ceiling — so without this, one abandoned
   * attempt blocks the next one for the full amount. Each candidate is checked
   * with Paystack first: only a charge they never collected is removed.
   */
  private async sweepAbandoned(studentFeeId: string): Promise<void> {
    const cutoff = new Date(Date.now() - ABANDONED_AFTER_MINUTES * 60_000);
    const stale = await this.prisma.payment.findMany({
      where: {
        studentFeeId,
        status: PaymentStatus.PENDING,
        method: PaymentMethod.ONLINE,
        providerReference: { not: null },
        createdAt: { lt: cutoff },
      },
      select: { id: true, providerReference: true },
      take: MAX_ABANDONED_SWEPT,
    });

    for (const payment of stale) {
      try {
        const result = await this.client.verify(payment.providerReference!);
        if (result.status === 'success') {
          // It was paid after all and the webhook never landed.
          await this.refresh(payment.id);
          continue;
        }
      } catch (error) {
        // Provider unreachable: leave it alone rather than delete a payment we
        // cannot vouch for.
        this.logger.warn(
          `Could not check abandoned payment ${payment.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      await this.prisma.payment.deleteMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
      });
    }
  }

  /** False when this event has already been recorded. */
  private async claimEvent(
    externalId: string,
    reference: string,
  ): Promise<boolean> {
    try {
      await RequestContext.runAsSystem(() =>
        this.prisma.webhookEvent.create({
          data: { provider: PROVIDER, externalId, reference },
        }),
      );
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
  }

  private async releaseEvent(externalId: string): Promise<void> {
    try {
      await RequestContext.runAsSystem(() =>
        this.prisma.webhookEvent.deleteMany({
          where: { provider: PROVIDER, externalId },
        }),
      );
    } catch (error) {
      this.logger.error(
        `Could not release webhook claim ${externalId}; a retry of it will be ignored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
