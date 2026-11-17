import {
  canAcceptOnlinePayments,
  FEE_BEARER,
  lastFour,
  maskAccountNumber,
  normaliseAccountNumber,
  PLATFORM_PERCENTAGE_CHARGE,
} from './settlement';

describe('normaliseAccountNumber', () => {
  it('accepts a plain ten-digit NUBAN', () => {
    expect(normaliseAccountNumber('0123456789')).toBe('0123456789');
  });

  it('accepts one typed the way it is printed', () => {
    expect(normaliseAccountNumber('0123 4567 89')).toBe('0123456789');
    expect(normaliseAccountNumber('0123-4567-89')).toBe('0123456789');
    expect(normaliseAccountNumber('  0123456789  ')).toBe('0123456789');
  });

  it('keeps a leading zero, which is most Nigerian accounts', () => {
    // The obvious bug here is reading it as a number somewhere upstream.
    expect(normaliseAccountNumber('0001234567')).toBe('0001234567');
  });

  it('refuses anything that is not ten digits', () => {
    expect(normaliseAccountNumber('012345678')).toBeNull();
    expect(normaliseAccountNumber('01234567890')).toBeNull();
    expect(normaliseAccountNumber('')).toBeNull();
  });

  it('refuses digits mixed with anything else', () => {
    expect(normaliseAccountNumber('01234S6789')).toBeNull();
    expect(normaliseAccountNumber('+2348012345')).toBeNull();
    // Ten characters, but not ten digits.
    expect(normaliseAccountNumber('0123.456789')).toBeNull();
  });

  it('refuses a value that is not a string', () => {
    expect(normaliseAccountNumber(123456789)).toBeNull();
    expect(normaliseAccountNumber(null)).toBeNull();
    expect(normaliseAccountNumber(undefined)).toBeNull();
    expect(normaliseAccountNumber({})).toBeNull();
  });
});

describe('lastFour / maskAccountNumber', () => {
  it('keeps only the last four digits', () => {
    expect(lastFour('0123456789')).toBe('6789');
  });

  it('masks to the full length of an account number', () => {
    expect(maskAccountNumber('6789')).toBe('******6789');
    expect(maskAccountNumber('6789')).toHaveLength(10);
  });

  it('hides everything but those four', () => {
    const masked = maskAccountNumber(lastFour('0123456789'));
    expect(masked).not.toContain('012345');
  });
});

describe('canAcceptOnlinePayments', () => {
  it('is false until a subaccount exists', () => {
    // The default has to be refusal: without a subaccount the money would
    // settle into EduGear's own account.
    expect(canAcceptOnlinePayments(null)).toBe(false);
    expect(canAcceptOnlinePayments('')).toBe(false);
  });

  it('is true once it does', () => {
    expect(canAcceptOnlinePayments('ACCT_8f4s1eq7ml6rlzj')).toBe(true);
  });
});

describe('the split', () => {
  it('leaves the whole fee with the school', () => {
    // Paystack reads percentage_charge as the MAIN account's cut, so zero is
    // what sends 100% to the school. A non-zero value here would quietly take
    // a cut of tuition that EduGear is not owed.
    expect(PLATFORM_PERCENTAGE_CHARGE).toBe(0);
  });

  it('puts Paystack charges on the school, not on EduGear', () => {
    // Paystack defaults this to "account". The value matters less than the
    // fact that it is always sent.
    expect(FEE_BEARER).toBe('subaccount');
  });
});
