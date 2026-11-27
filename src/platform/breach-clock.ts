/**
 * The 72-hour clock in section 40(2) of the Nigeria Data Protection Act 2023.
 *
 * > A data controller shall, **within 72 hours of becoming aware of a breach**
 * > which is likely to result in a risk to the rights and freedoms of
 * > individuals, notify the Commission of the breach …
 *
 * Two details decide every answer here, and both are easy to get wrong:
 *
 * 1. **The clock starts when we became aware, not when the breach happened.**
 *    A breach discovered in November that began in August is still 72 hours
 *    from discovery. That is why `discoveredAt` is a separate column from
 *    `occurredFrom`, and why this module takes the former.
 *
 * 2. **Not every breach is notifiable.** The duty attaches to one "likely to
 *    result in a risk". A breach assessed as carrying no such risk is recorded
 *    under s.40(8) but not reported — and the *reason* is recorded, so that a
 *    blank notification date reads as a decision rather than an omission.
 *
 * Pure on purpose: `now` is a parameter, so the states below are testable at
 * the boundary rather than only when a real clock happens to be near one.
 */

/** Section 40(2). */
export const COMMISSION_NOTIFICATION_WINDOW_HOURS = 72;

/**
 * How close to the deadline counts as needing a decision now. Not a legal
 * figure — an operational one — but it is shared with the register's query
 * filter so the list and this function cannot drift apart.
 */
export const ATTENTION_WARNING_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

export type NotificationState =
  /** Assessed as not notifiable, with a reason recorded. */
  | 'NOT_REQUIRED'
  /** Notifiable, still inside the window, not yet sent. */
  | 'DUE'
  /** Notifiable, window has passed, still not sent. The bad one. */
  | 'OVERDUE'
  /** Sent inside the window. */
  | 'ON_TIME'
  /** Sent, but after the window had closed. */
  | 'LATE';

export interface BreachClockInput {
  /** When we became aware. */
  discoveredAt: Date;
  /** When the Commission was notified, if it has been. */
  commissionNotifiedAt?: Date | null;
  /** A recorded, reasoned decision that s.40(2) does not apply. */
  notificationNotRequiredReason?: string | null;
}

/** The moment the section 40(2) window closes. */
export function commissionDeadline(discoveredAt: Date): Date {
  return new Date(
    discoveredAt.getTime() + COMMISSION_NOTIFICATION_WINDOW_HOURS * MS_PER_HOUR,
  );
}

/**
 * Whole hours left before the deadline. Negative once it has passed, so the
 * caller can say "14 hours left" or "9 hours late" from one number.
 *
 * Truncated towards zero rather than rounded: reporting "1 hour remaining"
 * when 90 seconds are left would be a lie in the direction that hurts.
 */
export function hoursUntilDeadline(discoveredAt: Date, now: Date): number {
  const remainingMs =
    commissionDeadline(discoveredAt).getTime() - now.getTime();
  return Math.trunc(remainingMs / MS_PER_HOUR);
}

/** True once the window has closed, whether or not anything was sent. */
export function isWindowClosed(discoveredAt: Date, now: Date): boolean {
  return now.getTime() > commissionDeadline(discoveredAt).getTime();
}

/**
 * Where this breach stands against section 40(2).
 *
 * Order matters. A recorded "not required" decision wins over everything,
 * because re-reading an assessed breach as OVERDUE every day afterwards would
 * bury the ones that genuinely are.
 */
export function notificationState(
  input: BreachClockInput,
  now: Date,
): NotificationState {
  const { discoveredAt, commissionNotifiedAt, notificationNotRequiredReason } =
    input;

  if (commissionNotifiedAt) {
    // Notifying exactly on the deadline is within "within 72 hours".
    return commissionNotifiedAt.getTime() <=
      commissionDeadline(discoveredAt).getTime()
      ? 'ON_TIME'
      : 'LATE';
  }

  if (notificationNotRequiredReason?.trim()) {
    return 'NOT_REQUIRED';
  }

  return isWindowClosed(discoveredAt, now) ? 'OVERDUE' : 'DUE';
}

/**
 * The ones a person has to act on today: notifiable, unsent, and either past
 * the deadline or close enough that waiting is a decision.
 */
export function needsAttention(
  input: BreachClockInput,
  now: Date,
  warnWithinHours = ATTENTION_WARNING_HOURS,
): boolean {
  const state = notificationState(input, now);
  if (state === 'OVERDUE') return true;
  if (state !== 'DUE') return false;
  return hoursUntilDeadline(input.discoveredAt, now) <= warnWithinHours;
}
