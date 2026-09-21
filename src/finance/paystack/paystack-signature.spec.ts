import { createHmac } from 'node:crypto';
import {
  isValidSignature,
  parseChargeEvent,
  signPayload,
  toKobo,
} from './paystack-signature';

const SECRET = 'sk_test_secret';
const body = JSON.stringify({
  event: 'charge.success',
  data: { reference: 'EDU-1' },
});
const signature = createHmac('sha512', SECRET).update(body).digest('hex');

describe('isValidSignature', () => {
  it('accepts a signature made with the same secret over the same bytes', () => {
    expect(isValidSignature(body, signature, SECRET)).toBe(true);
    expect(isValidSignature(Buffer.from(body), signature, SECRET)).toBe(true);
  });

  it('rejects another secret', () => {
    expect(isValidSignature(body, signature, 'sk_test_other')).toBe(false);
  });

  it('rejects a body altered by even one character', () => {
    const tampered = body.replace('EDU-1', 'EDU-2');
    expect(isValidSignature(tampered, signature, SECRET)).toBe(false);
  });

  it('rejects re-serialised JSON, which is why the raw body is kept', () => {
    // Same data, different byte order: a real signature will not match it.
    const reordered = JSON.stringify({
      data: { reference: 'EDU-1' },
      event: 'charge.success',
    });
    expect(isValidSignature(reordered, signature, SECRET)).toBe(false);
  });

  it('rejects a missing signature, body or secret rather than passing', () => {
    expect(isValidSignature(body, undefined, SECRET)).toBe(false);
    expect(isValidSignature(undefined, signature, SECRET)).toBe(false);
    expect(isValidSignature(body, signature, undefined)).toBe(false);
    expect(isValidSignature(body, '', SECRET)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(isValidSignature(body, signature.slice(0, 40), SECRET)).toBe(false);
    expect(isValidSignature(body, `${signature}00`, SECRET)).toBe(false);
  });

  it('produces the hex digest Paystack documents', () => {
    expect(signPayload(body, SECRET)).toMatch(/^[0-9a-f]{128}$/);
  });
});

describe('parseChargeEvent', () => {
  const event = {
    event: 'charge.success',
    data: {
      id: 302961,
      reference: 'EDU-abc',
      amount: 5000000,
      currency: 'NGN',
      status: 'success',
      paid_at: '2026-10-01T10:00:00.000Z',
      channel: 'card',
    },
  };

  it('reads the fields we act on', () => {
    expect(parseChargeEvent(event)).toEqual({
      event: 'charge.success',
      reference: 'EDU-abc',
      transactionId: '302961',
      amountKobo: 5000000,
      currency: 'NGN',
      status: 'success',
      paidAt: new Date('2026-10-01T10:00:00.000Z'),
      channel: 'card',
    });
  });

  it.each([
    ['not an object', 'nonsense'],
    ['null', null],
    ['no event name', { data: { reference: 'x', amount: 1 } }],
    ['no data', { event: 'charge.success' }],
    ['no reference', { event: 'charge.success', data: { amount: 1 } }],
    [
      'an empty reference',
      { event: 'charge.success', data: { reference: '', amount: 1 } },
    ],
    ['no amount', { event: 'charge.success', data: { reference: 'x' } }],
    [
      'an amount that is not a number',
      { event: 'charge.success', data: { reference: 'x', amount: '5000' } },
    ],
  ])('returns null for %s', (_label, payload) => {
    expect(parseChargeEvent(payload)).toBeNull();
  });

  it('falls back to the reference when Paystack sends no id', () => {
    const parsed = parseChargeEvent({
      event: 'charge.success',
      data: { reference: 'EDU-abc', amount: 100 },
    });
    expect(parsed?.transactionId).toBe('EDU-abc');
    expect(parsed?.paidAt).toBeNull();
    expect(parsed?.currency).toBe('NGN');
  });

  it('ignores an unparseable date rather than storing Invalid Date', () => {
    const parsed = parseChargeEvent({
      event: 'charge.success',
      data: { reference: 'x', amount: 1, paid_at: 'not a date' },
    });
    expect(parsed?.paidAt).toBeNull();
  });
});

describe('toKobo', () => {
  it.each([
    [50000, 5000000],
    [0.01, 1],
    [1234.56, 123456],
    // 19.99 * 100 is 1998.9999999999998 in binary floating point.
    [19.99, 1999],
  ])('%p naira → %p kobo', (naira, kobo) => {
    expect(toKobo(naira)).toBe(kobo);
  });
});

describe('parseChargeEvent — the dedupe key', () => {
  const event = (data: Record<string, unknown>) =>
    parseChargeEvent({
      event: 'charge.success',
      data: { reference: 'EDU-1', amount: 1000, ...data },
    });

  it('uses the provider transaction id when it is a number', () => {
    expect(event({ id: 302961 })?.transactionId).toBe('302961');
  });

  it('falls back to the reference when the id is not a scalar', () => {
    // A malformed id must not become "[object Object]", which would collide
    // across every event that carries one.
    expect(event({ id: { nested: true } })?.transactionId).toBe('EDU-1');
    expect(event({ id: [] })?.transactionId).toBe('EDU-1');
    expect(event({ id: '' })?.transactionId).toBe('EDU-1');
    expect(event({ id: null })?.transactionId).toBe('EDU-1');
  });
});
