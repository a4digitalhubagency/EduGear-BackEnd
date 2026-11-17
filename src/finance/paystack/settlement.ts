/**
 * Where a school's fees settle.
 *
 * Online fees go straight to the school's own bank through a Paystack
 * subaccount: EduGear never holds the money. The rules here are the pure part
 * of arranging that — what counts as an account number, and how much of one we
 * are willing to keep.
 *
 * **We do not store the account number.** Paystack is the system of record for
 * it, and nothing in this application needs to read it back: a subaccount is
 * updated by its code, not by its account number. What a bursar needs to see
 * is enough to recognise the account they chose, which is the bank, the name
 * the bank returned, and the last four digits. Keeping the rest would be
 * storing a credential we have no use for.
 */

/** NUBAN: every Nigerian bank account number is exactly ten digits. */
const NUBAN_LENGTH = 10;

/**
 * Accepts what a person types — spaces and hyphens from reading it off a card
 * or a statement — and returns the digits, or null if it is not an account
 * number. Rejecting a correct account because it was pasted with a space is
 * the kind of thing that makes someone give up and ring the office.
 */
export function normaliseAccountNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const digits = value.replace(/[\s-]/g, '');
  if (digits.length !== NUBAN_LENGTH) return null;
  if (!/^\d+$/.test(digits)) return null;

  return digits;
}

/** The only part of an account number we keep, so a bursar can recognise it. */
export function lastFour(accountNumber: string): string {
  return accountNumber.slice(-4);
}

/**
 * For display. Never reconstruct an account number from this — it is lossy on
 * purpose, and the digits it hides were never stored to begin with.
 */
export function maskAccountNumber(last4: string): string {
  return `${'*'.repeat(NUBAN_LENGTH - last4.length)}${last4}`;
}

/**
 * A school can only take card payments once its settlement account exists at
 * Paystack. Without a subaccount the money would land in EduGear's own
 * account, which is the one outcome this whole design exists to prevent — so
 * the absence of a code refuses the payment rather than falling back.
 */
export function canAcceptOnlinePayments(
  subaccountCode: string | null,
): boolean {
  return typeof subaccountCode === 'string' && subaccountCode.length > 0;
}

/**
 * EduGear charges nothing per transaction: the product is sold as a
 * subscription, so the whole fee belongs to the school.
 *
 * Paystack reads `percentage_charge` as the **main** account's cut, so zero is
 * what sends 100% to the subaccount. Had it meant the subaccount's share, this
 * value would hand every naira to the wrong party — which is why it is named
 * and commented rather than written inline as a bare `0`.
 */
export const PLATFORM_PERCENTAGE_CHARGE = 0;

/**
 * The school bears Paystack's processing charge, which keeps the amount paid
 * equal to the amount invoiced. A surcharge added at checkout would break that
 * equality, and with it the receipt, the reconciliation and the amount check
 * that guards every webhook.
 *
 * Paystack defaults this to `account` — EduGear — so it has to be sent on
 * every transaction. Omit it and EduGear quietly pays every school's fees.
 */
export const FEE_BEARER = 'subaccount' as const;
