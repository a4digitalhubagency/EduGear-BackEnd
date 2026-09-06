import { Prisma, StudentFeeStatus } from '@prisma/client';

/**
 * Money arithmetic for invoices.
 *
 * Everything here works in `Prisma.Decimal`, never `number`: naira totals have
 * to add up exactly, and 0.1 + 0.2 does not. Amounts only become numbers at the
 * DTO boundary, where they are read rather than added.
 */

export const ZERO = new Prisma.Decimal(0);

export function sum(amounts: readonly Prisma.Decimal[]): Prisma.Decimal {
  return amounts.reduce<Prisma.Decimal>((total, next) => total.add(next), ZERO);
}

export interface InvoiceAmounts {
  totalAmount: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
}

/** What is actually owed after any discount, never below zero. */
export function payable(invoice: InvoiceAmounts): Prisma.Decimal {
  const net = invoice.totalAmount.sub(invoice.discountAmount);
  return net.isNegative() ? ZERO : net;
}

/** What is still outstanding, never below zero — an overpayment is not a debt. */
export function balance(invoice: InvoiceAmounts): Prisma.Decimal {
  const remaining = payable(invoice).sub(invoice.amountPaid);
  return remaining.isNegative() ? ZERO : remaining;
}

/**
 * Status follows the money, so it can never disagree with it. WAIVED and
 * CANCELLED are decisions a person makes, so they are preserved rather than
 * recomputed.
 */
export function deriveStatus(
  invoice: InvoiceAmounts,
  current?: StudentFeeStatus,
): StudentFeeStatus {
  if (
    current === StudentFeeStatus.WAIVED ||
    current === StudentFeeStatus.CANCELLED
  ) {
    return current;
  }

  const due = payable(invoice);

  // A fully discounted invoice is settled, not unpaid.
  if (due.isZero()) return StudentFeeStatus.PAID;
  if (invoice.amountPaid.gte(due)) return StudentFeeStatus.PAID;
  if (invoice.amountPaid.greaterThan(ZERO)) return StudentFeeStatus.PARTIAL;
  return StudentFeeStatus.UNPAID;
}

/** Invoice statuses that still owe money — the debtor definition. */
export const OWING_STATUSES: readonly StudentFeeStatus[] = [
  StudentFeeStatus.UNPAID,
  StudentFeeStatus.PARTIAL,
];

/** Decimal to a plain number, for reading only. */
export function toAmount(value: Prisma.Decimal): number {
  return value.toDecimalPlaces(2).toNumber();
}
