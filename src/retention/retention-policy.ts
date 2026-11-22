import { SENSITIVE_STUDENT_FIELDS } from '../students/sensitive-fields';

/**
 * The periods in `docs/legal/retention-schedule.md`, in one place.
 *
 * They are published to schools and to parents, so they are not implementation
 * detail that can be nudged — changing a number here changes a document we
 * have given people. The schedule is the source; this is its executable form,
 * and the two are meant to be read together.
 *
 * @see docs/legal/retention-schedule.md
 */
export const RETENTION = {
  /**
   * §2.1 — how long after a student leaves before the surplus is destroyed.
   * Not zero: a withdrawal entered by mistake has to be reversible, and a
   * leaving certificate often needs issuing after the status changes.
   */
  studentMinimisationGraceDays: 90,
  /** §3 — guardian contact details, after the last linked student leaves. */
  guardianContactMonths: 12,
  /** §6 — IP address and user-agent on an audit row. The entry survives. */
  auditNetworkDataMonths: 12,
  /** §5 — name and email on a deactivated account. The row survives. */
  deactivatedAccountMonths: 24,
  /** §6 */
  notificationMonths: 24,
  /** §6 */
  webhookEventMonths: 24,
  /** §4 — invoices, payments, receipts, evidence. */
  financialYears: 7,
  /** §6 — the audit trail itself. */
  auditYears: 7,
  /** §7 — expired refresh and verification tokens, after expiry. */
  expiredTokenDays: 30,
  /** §8 — export window after a school terminates. */
  schoolExportWindowDays: 90,
} as const;

/**
 * Fields destroyed when a student leaves — the "residue" in GAID ¶4(vi).
 *
 * **What is absent matters more than what is here.** `firstName`, `lastName`,
 * `studentId`, `gender`, `dateOfBirth`, `admissionDate` and `nationality` all
 * survive, because a transcript needs them and a transcript is the whole
 * reason the record is kept. That is the design: a departing student's record
 * is *shrunk to the minimum necessary*, not anonymised. Anonymising it would
 * destroy the thing it exists for.
 *
 * `dateOfBirth` survives deliberately — it is what distinguishes two former
 * students with the same name on a transcript, so removing it would make the
 * record ambiguous precisely when someone relies on it.
 */
export const STUDENT_RESIDUE_FIELDS = [
  'middleName',
  'email',
  'phone',
  'addressLine',
  'notes',
  // Cleared alongside the column; the stored file is deleted separately,
  // because nulling a URL leaves the photograph sitting in the bucket.
  'photoUrl',
  ...SENSITIVE_STUDENT_FIELDS,
  // The consent record goes with the data it authorised. Keeping it after the
  // five fields are destroyed would leave a parent's name and a declaration
  // on file justifying something no longer held — surplus under GAID ¶4(v) in
  // its own right, and the audit trail already carries proof the consent
  // existed for as long as anyone could need to show it.
  'sensitiveConsentAt',
  'sensitiveConsentBy',
  'sensitiveConsentMethod',
  'sensitiveConsentWithdrawnAt',
] as const;

export type StudentResidueField = (typeof STUDENT_RESIDUE_FIELDS)[number];

/** Guardian fields destroyed once no linked student remains enrolled. */
export const GUARDIAN_RESIDUE_FIELDS = [
  'email',
  'phone',
  'altPhone',
  'addressLine',
  'occupation',
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Period {
  days?: number;
  months?: number;
  years?: number;
}

/**
 * The moment before which a record is due for action.
 *
 * Months and years go through the calendar rather than through a fixed number
 * of days, so "12 months" lands on the same day of the month regardless of
 * leap years and month lengths. A 365-day approximation drifts, and a drifting
 * retention period is one we cannot honestly describe to a parent.
 */
export function cutoff(now: Date, period: Period): Date {
  const result = new Date(now.getTime());

  if (period.days) {
    result.setTime(result.getTime() - period.days * DAY_MS);
  }
  if (period.years) {
    result.setUTCFullYear(result.getUTCFullYear() - period.years);
  }
  if (period.months) {
    const targetMonth = result.getUTCMonth() - period.months;
    const dayOfMonth = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(targetMonth);
    // Going back to "the 31st" in a 30-day month would roll into the next
    // month and *extend* the retention period. Clamp to the month's end.
    const lastDay = daysInUtcMonth(result);
    result.setUTCDate(Math.min(dayOfMonth, lastDay));
  }

  return result;
}

function daysInUtcMonth(date: Date): number {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
}

/** The payload that clears a residue list. Derived, so nothing is forgotten. */
export function clearFields<T extends string>(
  fields: readonly T[],
): Record<T, null> {
  return Object.fromEntries(fields.map((f) => [f, null])) as Record<T, null>;
}

/** Every cutoff a run needs, computed once so one run uses one clock. */
export function cutoffsFor(now: Date) {
  return {
    studentMinimisation: cutoff(now, {
      days: RETENTION.studentMinimisationGraceDays,
    }),
    guardianContact: cutoff(now, { months: RETENTION.guardianContactMonths }),
    auditNetworkData: cutoff(now, {
      months: RETENTION.auditNetworkDataMonths,
    }),
    deactivatedAccount: cutoff(now, {
      months: RETENTION.deactivatedAccountMonths,
    }),
    notification: cutoff(now, { months: RETENTION.notificationMonths }),
    webhookEvent: cutoff(now, { months: RETENTION.webhookEventMonths }),
    financial: cutoff(now, { years: RETENTION.financialYears }),
    audit: cutoff(now, { years: RETENTION.auditYears }),
    expiredToken: cutoff(now, { days: RETENTION.expiredTokenDays }),
  };
}

export type RetentionCutoffs = ReturnType<typeof cutoffsFor>;
