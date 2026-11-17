import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Paystack signs each webhook with HMAC-SHA512 of the **raw** request body,
 * keyed by the secret key. The raw bytes matter: re-serialising the parsed JSON
 * reorders or reformats it and the digest no longer matches.
 *
 * The comparison is constant-time. A byte-by-byte one leaks, through timing,
 * how much of a forged signature was right — which is enough to find the rest.
 */
export function signPayload(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

export function isValidSignature(
  rawBody: Buffer | string | undefined,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!rawBody || !signature || !secret) return false;

  const expected = Buffer.from(signPayload(rawBody, secret), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself a difference.
  if (expected.length !== received.length) return false;

  return timingSafeEqual(expected, received);
}

export interface PaystackChargeEvent {
  event: string;
  reference: string;
  /** Paystack's own transaction id — the idempotency key with the event name. */
  transactionId: string;
  /** Kobo, as Paystack counts it. */
  amountKobo: number;
  currency: string;
  status: string;
  paidAt: Date | null;
  channel: string | null;
  /**
   * Which subaccount the money split to, when the payload says. Null means
   * the payload did not name one — not that none was used — so a caller
   * comparing it must guard on that before treating a difference as wrong.
   */
  subaccountCode: string | null;
}

/** Reads the fields we act on, and nothing else. Unknown shapes return null. */
export function parseChargeEvent(body: unknown): PaystackChargeEvent | null {
  if (typeof body !== 'object' || body === null) return null;

  const envelope = body as { event?: unknown; data?: unknown };
  if (typeof envelope.event !== 'string') return null;
  if (typeof envelope.data !== 'object' || envelope.data === null) return null;

  const data = envelope.data as Record<string, unknown>;
  if (typeof data.reference !== 'string' || data.reference === '') return null;
  if (typeof data.amount !== 'number' || !Number.isFinite(data.amount))
    return null;

  const paidAt =
    typeof data.paid_at === 'string' || typeof data.paidAt === 'string'
      ? new Date((data.paid_at ?? data.paidAt) as string)
      : null;

  // The reference stands in when the id is missing or not a scalar: a dedupe
  // key that cannot be read is worse than one that is merely coarser.
  const id = data.id;
  const transactionId =
    typeof id === 'number' || (typeof id === 'string' && id !== '')
      ? String(id)
      : data.reference;

  return {
    event: envelope.event,
    reference: data.reference,
    transactionId,
    amountKobo: data.amount,
    currency: typeof data.currency === 'string' ? data.currency : 'NGN',
    status: typeof data.status === 'string' ? data.status : 'unknown',
    paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
    channel: typeof data.channel === 'string' ? data.channel : null,
    subaccountCode: readSubaccountCode(data.subaccount),
  };
}

/**
 * Paystack has sent `subaccount` as an object and, on some events, as the bare
 * code. Anything else — absent, null, a number — reads as "not stated", which
 * the caller treats as no claim rather than as a mismatch.
 */
function readSubaccountCode(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value !== 'object' || value === null) return null;

  const code = (value as { subaccount_code?: unknown }).subaccount_code;
  return typeof code === 'string' && code !== '' ? code : null;
}

/** Naira to the kobo Paystack works in, without floating-point drift. */
export function toKobo(amount: number): number {
  return Math.round(amount * 100);
}
