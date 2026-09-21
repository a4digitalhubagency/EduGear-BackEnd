import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';

export interface InitializedTransaction {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface VerifiedTransaction {
  status: string;
  amountKobo: number;
  currency: string;
  paidAt: Date | null;
  channel: string | null;
}

const BASE_URL = 'https://api.paystack.co';
const TIMEOUT_MS = 15_000;

/**
 * The thin edge against Paystack. Kept separate from the rules so the service
 * can be tested without the network, and so every call has one timeout, one
 * error shape and one place that knows the secret key.
 */
@Injectable()
export class PaystackClient {
  private readonly logger = new Logger(PaystackClient.name);
  readonly configured: boolean;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    this.configured = Boolean(
      config.get('paystack', { infer: true }).secretKey,
    );
  }

  get secretKey(): string | undefined {
    return this.config.get('paystack', { infer: true }).secretKey;
  }

  async initialize(params: {
    email: string;
    amountKobo: number;
    reference: string;
    metadata: Record<string, string>;
  }): Promise<InitializedTransaction> {
    const callbackUrl = this.config.get('paystack', {
      infer: true,
    }).callbackUrl;

    const body = await this.call<{
      data: {
        authorization_url: string;
        access_code: string;
        reference: string;
      };
    }>('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: params.email,
        amount: params.amountKobo,
        reference: params.reference,
        currency: 'NGN',
        metadata: params.metadata,
        ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      }),
    });

    return {
      authorizationUrl: body.data.authorization_url,
      accessCode: body.data.access_code,
      reference: body.data.reference,
    };
  }

  /** The fallback when a webhook never arrives, and the check before trusting one. */
  async verify(reference: string): Promise<VerifiedTransaction> {
    const body = await this.call<{
      data: {
        status: string;
        amount: number;
        currency: string;
        paid_at?: string;
        channel?: string;
      };
    }>(`/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
    });

    const paidAt = body.data.paid_at ? new Date(body.data.paid_at) : null;
    return {
      status: body.data.status,
      amountKobo: body.data.amount,
      currency: body.data.currency,
      paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
      channel: body.data.channel ?? null,
    };
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    if (!this.secretKey) {
      throw new Error('Paystack is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
      });

      const text = await response.text();
      if (!response.ok) {
        // The body may carry a reason; the key never appears in it.
        this.logger.error(
          `Paystack ${path} failed with ${response.status}: ${text.slice(0, 300)}`,
        );
        throw new Error(`Paystack refused the request (${response.status})`);
      }
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
