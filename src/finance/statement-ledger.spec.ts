import { PaymentStatus, Prisma, StudentFeeStatus } from '@prisma/client';
import {
  LedgerInvoice,
  LedgerPayment,
  buildLedger,
  expectedClosingBalance,
} from './statement-ledger';

const d = (value: number) => new Prisma.Decimal(value);
const day = (n: number) => new Date(Date.UTC(2025, 8, n));

function invoice(overrides: Partial<LedgerInvoice> = {}): LedgerInvoice {
  return {
    id: 'inv-1',
    structureName: 'First Term',
    totalAmount: d(50000),
    discountAmount: d(0),
    amountPaid: d(0),
    status: StudentFeeStatus.UNPAID,
    waiverReason: null,
    createdAt: day(1),
    updatedAt: day(1),
    ...overrides,
  };
}

function payment(overrides: Partial<LedgerPayment> = {}): LedgerPayment {
  return {
    studentFeeId: 'inv-1',
    amount: d(20000),
    status: PaymentStatus.VERIFIED,
    receiptNumber: 'RCP/2025/000001',
    method: 'BANK_TRANSFER',
    paidAt: day(5),
    ...overrides,
  };
}

describe('buildLedger', () => {
  it('opens with the invoice as a debit', () => {
    const { entries, closingBalance } = buildLedger([invoice()], []);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('INVOICE');
    expect(closingBalance.toNumber()).toBe(50000);
  });

  it('runs the balance down with each verified payment', () => {
    const { entries, closingBalance } = buildLedger(
      [invoice({ amountPaid: d(30000), status: StudentFeeStatus.PARTIAL })],
      [
        payment({ amount: d(20000), paidAt: day(5) }),
        payment({
          amount: d(10000),
          paidAt: day(9),
          receiptNumber: 'RCP/2025/000002',
        }),
      ],
    );

    expect(entries.map((e) => e.balance.toNumber())).toEqual([
      50000, 30000, 20000,
    ]);
    expect(closingBalance.toNumber()).toBe(20000);
  });

  it('ignores pending and rejected payments', () => {
    const { closingBalance } = buildLedger(
      [invoice()],
      [
        payment({ status: PaymentStatus.PENDING }),
        payment({ status: PaymentStatus.REJECTED }),
      ],
    );
    expect(closingBalance.toNumber()).toBe(50000);
  });

  it('credits a discount against its invoice', () => {
    const { entries, closingBalance } = buildLedger(
      [invoice({ discountAmount: d(5000), waiverReason: 'Sibling discount' })],
      [],
    );
    expect(entries[1]).toMatchObject({
      type: 'DISCOUNT',
      description: 'Discount: Sibling discount',
    });
    expect(closingBalance.toNumber()).toBe(45000);
  });

  it('forgives only the unpaid remainder of a waived invoice', () => {
    const { entries, closingBalance } = buildLedger(
      [
        invoice({
          amountPaid: d(20000),
          status: StudentFeeStatus.WAIVED,
          waiverReason: 'Scholarship',
          updatedAt: day(10),
        }),
      ],
      [payment({ amount: d(20000) })],
    );

    const waiver = entries.find((e) => e.type === 'WAIVER');
    expect(waiver?.credit.toNumber()).toBe(30000);
    expect(closingBalance.toNumber()).toBe(0);
  });

  it('leaves cancelled invoices and their payments out entirely', () => {
    const { entries, closingBalance } = buildLedger(
      [invoice({ status: StudentFeeStatus.CANCELLED })],
      [payment()],
    );
    expect(entries).toHaveLength(0);
    expect(closingBalance.toNumber()).toBe(0);
  });

  it('orders a same-day credit after the debit it settles', () => {
    const { entries } = buildLedger(
      [invoice({ amountPaid: d(50000), status: StudentFeeStatus.PAID })],
      [payment({ amount: d(50000), paidAt: day(1) })],
    );
    expect(entries.map((e) => e.type)).toEqual(['INVOICE', 'PAYMENT']);
    expect(entries.map((e) => e.balance.toNumber())).toEqual([50000, 0]);
  });

  it('posts a back-entered charge no later than the first payment against it', () => {
    // Invoice typed in on day 20; the parent had paid on day 5.
    const { entries } = buildLedger(
      [
        invoice({
          createdAt: day(20),
          amountPaid: d(20000),
          status: StudentFeeStatus.PARTIAL,
        }),
      ],
      [payment({ amount: d(20000), paidAt: day(5) })],
    );

    expect(entries.map((e) => e.type)).toEqual(['INVOICE', 'PAYMENT']);
    expect(entries[0].date).toEqual(day(5));
    // Never dips below zero on the way to the correct close.
    expect(entries.every((e) => !e.balance.isNegative())).toBe(true);
  });

  it('always closes at the true outstanding balance across a mixed book', () => {
    const invoices = [
      invoice({
        id: 'a',
        amountPaid: d(20000),
        status: StudentFeeStatus.PARTIAL,
      }),
      invoice({
        id: 'b',
        totalAmount: d(15000),
        discountAmount: d(5000),
        amountPaid: d(10000),
        status: StudentFeeStatus.PAID,
      }),
      invoice({
        id: 'c',
        status: StudentFeeStatus.WAIVED,
        waiverReason: 'Staff child',
      }),
      invoice({ id: 'd', status: StudentFeeStatus.CANCELLED }),
      invoice({ id: 'e', totalAmount: d(7000) }),
    ];
    const payments = [
      payment({ studentFeeId: 'a', amount: d(20000) }),
      payment({ studentFeeId: 'b', amount: d(10000) }),
      payment({
        studentFeeId: 'a',
        amount: d(99999),
        status: PaymentStatus.REJECTED,
      }),
    ];

    const { closingBalance } = buildLedger(invoices, payments);
    expect(closingBalance.toNumber()).toBe(
      expectedClosingBalance(invoices).toNumber(),
    );
    expect(closingBalance.toNumber()).toBe(37000);
  });
});
