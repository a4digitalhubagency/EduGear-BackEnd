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
  /**
   * The subaccount the money was split to, when the payload names one. Null
   * means Paystack did not say — not that no subaccount was used — so a check
   * against it belongs behind a null guard rather than in front of one.
   */
  subaccountCode: string | null;
}

export interface PaystackBank {
  name: string;
  code: string;
  currency: string;
}

export interface ResolvedAccount {
  accountNumber: string;
  /** As the bank holds it. Never what the caller typed. */
  accountName: string;
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
    /** The school's subaccount. Fees settle there, never here. */
    subaccount: string;
    /** Who pays Paystack's charge. Defaults to the main account, so it is
     * always sent: omitting it makes EduGear pay every school's fees. */
    bearer: 'account' | 'subaccount';
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
        subaccount: params.subaccount,
        bearer: params.bearer,
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
        subaccount?: { subaccount_code?: string } | null;
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
      subaccountCode: body.data.subaccount?.subaccount_code ?? null,
    };
  }

  /** Populates the bank picker. The list changes rarely; the caller caches it. */
  async listBanks(): Promise<PaystackBank[]> {
    const body = await this.call<{
      data: Array<{ name: string; code: string; currency: string }>;
    }>('/bank?currency=NGN', { method: 'GET' });

    return body.data.map((bank) => ({
      name: bank.name,
      code: bank.code,
      currency: bank.currency,
    }));
  }

  /**
   * Asks the bank who owns an account, so a school confirms a name rather than
   * trusting ten digits it typed. A transposed digit that happens to be a real
   * account is otherwise only discovered by somebody else receiving the fees.
   */
  async resolveAccount(
    accountNumber: string,
    bankCode: string,
  ): Promise<ResolvedAccount> {
    const query = new URLSearchParams({
      account_number: accountNumber,
      bank_code: bankCode,
    });
    const body = await this.call<{
      data: { account_number: string; account_name: string };
    }>(`/bank/resolve?${query.toString()}`, { method: 'GET' });

    return {
      accountNumber: body.data.account_number,
      accountName: body.data.account_name,
    };
  }

  async createSubaccount(params: {
    businessName: string;
    bankCode: string;
    accountNumber: string;
    percentageCharge: number;
  }): Promise<string> {
    const body = await this.call<{ data: { subaccount_code: string } }>(
      '/subaccount',
      {
        method: 'POST',
        body: JSON.stringify({
          business_name: params.businessName,
          settlement_bank: params.bankCode,
          account_number: params.accountNumber,
          // Paystack reads this as the MAIN account's cut, not the
          // subaccount's share. Zero is what leaves the whole fee with the
          // school.
          percentage_charge: params.percentageCharge,
        }),
      },
    );
    return body.data.subaccount_code;
  }

  /** Moving a school's settlement to a different bank account. */
  async updateSubaccount(
    subaccountCode: string,
    params: {
      businessName: string;
      bankCode: string;
      accountNumber: string;
      percentageCharge: number;
    },
  ): Promise<void> {
    await this.call(`/subaccount/${encodeURIComponent(subaccountCode)}`, {
      method: 'PUT',
      body: JSON.stringify({
        business_name: params.businessName,
        settlement_bank: params.bankCode,
        account_number: params.accountNumber,
        percentage_charge: params.percentageCharge,
      }),
    });
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
