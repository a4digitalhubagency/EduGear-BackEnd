import { PaymentStatus, Prisma, StudentFeeStatus } from '@prisma/client';
import { ZERO, balance } from './fee-math';

/**
 * Builds a running-balance ledger from the facts on file.
 *
 * Every invoice is a debit, and every discount, waiver and verified payment a
 * credit. The closing balance therefore equals what is genuinely outstanding —
 * the property the unit tests pin — so a statement can never disagree with the
 * invoices it is built from. Cancelled invoices were withdrawn, not forgiven,
 * so they appear nowhere; pending and rejected payments are not money received.
 */

export type LedgerEntryType = 'INVOICE' | 'DISCOUNT' | 'WAIVER' | 'PAYMENT';

export interface LedgerEntry {
  date: Date;
  type: LedgerEntryType;
  description: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  balance: Prisma.Decimal;
  reference: string | null;
}

export interface LedgerInvoice {
  id: string;
  structureName: string;
  totalAmount: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  status: StudentFeeStatus;
  waiverReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LedgerPayment {
  studentFeeId: string;
  amount: Prisma.Decimal;
  status: PaymentStatus;
  receiptNumber: string;
  method: string;
  paidAt: Date;
}

/** Credits land after the debit they settle when both share a timestamp. */
const ORDER: Record<LedgerEntryType, number> = {
  INVOICE: 0,
  DISCOUNT: 1,
  PAYMENT: 2,
  WAIVER: 3,
};

export function buildLedger(
  invoices: readonly LedgerInvoice[],
  payments: readonly LedgerPayment[],
): { entries: LedgerEntry[]; closingBalance: Prisma.Decimal } {
  const live = invoices.filter(
    (invoice) => invoice.status !== StudentFeeStatus.CANCELLED,
  );
  const liveIds = new Set(live.map((invoice) => invoice.id));
  const verified = payments.filter(
    (payment) =>
      payment.status === PaymentStatus.VERIFIED &&
      liveIds.has(payment.studentFeeId),
  );

  const raw: Omit<LedgerEntry, 'balance'>[] = [];

  for (const invoice of live) {
    const posted = postingDate(invoice, verified);

    raw.push({
      date: posted,
      type: 'INVOICE',
      description: invoice.structureName,
      debit: invoice.totalAmount,
      credit: ZERO,
      reference: null,
    });

    if (invoice.discountAmount.greaterThan(0)) {
      raw.push({
        date: posted,
        type: 'DISCOUNT',
        description: `Discount${invoice.waiverReason ? `: ${invoice.waiverReason}` : ''}`,
        debit: ZERO,
        credit: invoice.discountAmount,
        reference: null,
      });
    }

    if (invoice.status === StudentFeeStatus.WAIVED) {
      // Only what was still owing is forgiven; money already paid stands.
      const forgiven = balance(invoice);
      if (forgiven.greaterThan(0)) {
        raw.push({
          date: invoice.updatedAt,
          type: 'WAIVER',
          description: `Waived${invoice.waiverReason ? `: ${invoice.waiverReason}` : ''}`,
          debit: ZERO,
          credit: forgiven,
          reference: null,
        });
      }
    }
  }

  for (const payment of verified) {
    raw.push({
      date: payment.paidAt,
      type: 'PAYMENT',
      description: `Payment (${payment.method.replace('_', ' ').toLowerCase()})`,
      debit: ZERO,
      credit: payment.amount,
      reference: payment.receiptNumber,
    });
  }

  raw.sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() || ORDER[a.type] - ORDER[b.type],
  );

  let running = ZERO;
  const entries = raw.map((entry) => {
    running = running.add(entry.debit).sub(entry.credit);
    return { ...entry, balance: running };
  });

  return { entries, closingBalance: running };
}

/**
 * When a charge enters the ledger.
 *
 * An invoice's createdAt is when it was typed in, which is often after the
 * parent paid — schools routinely back-enter bills when they start using the
 * system. A payment against a charge proves the charge existed by then, so the
 * charge is posted no later than its earliest payment. Otherwise the ledger
 * would show money arriving before the bill it settles, and dip below zero.
 */
function postingDate(
  invoice: LedgerInvoice,
  verified: readonly LedgerPayment[],
): Date {
  let earliest = invoice.createdAt;
  for (const payment of verified) {
    if (payment.studentFeeId === invoice.id && payment.paidAt < earliest) {
      earliest = payment.paidAt;
    }
  }
  return earliest;
}

/** What the ledger must close at — used to assert it in tests. */
export function expectedClosingBalance(
  invoices: readonly LedgerInvoice[],
): Prisma.Decimal {
  return invoices
    .filter(
      (invoice) =>
        invoice.status !== StudentFeeStatus.CANCELLED &&
        invoice.status !== StudentFeeStatus.WAIVED,
    )
    .reduce((total, invoice) => total.add(balance(invoice)), ZERO);
}
