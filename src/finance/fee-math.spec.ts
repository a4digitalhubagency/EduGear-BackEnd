import { Prisma, StudentFeeStatus } from '@prisma/client';
import { balance, deriveStatus, payable, sum, toAmount } from './fee-math';

const d = (value: string | number) => new Prisma.Decimal(value);

const invoice = (total: string, discount = '0', paid = '0') => ({
  totalAmount: d(total),
  discountAmount: d(discount),
  amountPaid: d(paid),
});

describe('sum', () => {
  it('is zero for nothing', () => {
    expect(sum([]).toString()).toBe('0');
  });

  it('adds exactly, where floats would not', () => {
    // 0.1 + 0.2 === 0.30000000000000004 as a float.
    expect(sum([d('0.1'), d('0.2')]).toString()).toBe('0.3');
  });

  it('adds kobo without drift across many items', () => {
    expect(sum(Array.from({ length: 10 }, () => d('0.01'))).toString()).toBe(
      '0.1',
    );
  });
});

describe('payable', () => {
  it('subtracts the discount', () => {
    expect(payable(invoice('50000', '5000')).toString()).toBe('45000');
  });

  it('never goes below zero', () => {
    expect(payable(invoice('1000', '5000')).toString()).toBe('0');
  });
});

describe('balance', () => {
  it('is the unpaid remainder', () => {
    expect(balance(invoice('50000', '0', '20000')).toString()).toBe('30000');
  });

  it('accounts for the discount', () => {
    expect(balance(invoice('50000', '10000', '20000')).toString()).toBe(
      '20000',
    );
  });

  it('treats an overpayment as settled, not as negative debt', () => {
    expect(balance(invoice('50000', '0', '60000')).toString()).toBe('0');
  });
});

describe('deriveStatus', () => {
  it('is UNPAID with nothing paid', () => {
    expect(deriveStatus(invoice('50000'))).toBe(StudentFeeStatus.UNPAID);
  });

  it('is PARTIAL part way', () => {
    expect(deriveStatus(invoice('50000', '0', '1'))).toBe(
      StudentFeeStatus.PARTIAL,
    );
  });

  it('is PAID when settled exactly', () => {
    expect(deriveStatus(invoice('50000', '0', '50000'))).toBe(
      StudentFeeStatus.PAID,
    );
  });

  it('is PAID when overpaid', () => {
    expect(deriveStatus(invoice('50000', '0', '60000'))).toBe(
      StudentFeeStatus.PAID,
    );
  });

  it('is PAID when the discount covers everything', () => {
    expect(deriveStatus(invoice('50000', '50000'))).toBe(StudentFeeStatus.PAID);
  });

  it('counts the discount toward settlement', () => {
    expect(deriveStatus(invoice('50000', '10000', '40000'))).toBe(
      StudentFeeStatus.PAID,
    );
  });

  it.each([StudentFeeStatus.WAIVED, StudentFeeStatus.CANCELLED])(
    'preserves %s, which is a decision rather than a calculation',
    (current) => {
      expect(deriveStatus(invoice('50000', '0', '0'), current)).toBe(current);
    },
  );

  it('recomputes from any other current status', () => {
    expect(
      deriveStatus(invoice('50000', '0', '50000'), StudentFeeStatus.UNPAID),
    ).toBe(StudentFeeStatus.PAID);
  });
});

describe('toAmount', () => {
  it('rounds to kobo', () => {
    expect(toAmount(d('1234.567'))).toBe(1234.57);
  });

  it('keeps whole naira clean', () => {
    expect(toAmount(d('50000'))).toBe(50000);
  });
});
