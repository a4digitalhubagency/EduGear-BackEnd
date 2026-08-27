/**
 * Date arithmetic shared by every academic period — sessions, terms, and
 * whatever Phase 2 adds. Pure, so it is tested without a database.
 */
export interface DateRange {
  startDate: Date;
  endDate: Date;
}

/**
 * Academic periods are date-only (`@db.Date`). Normalising to UTC midnight keeps
 * a request from a UTC+1 client from landing on the previous day.
 */
export function toDateOnly(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

/** Returns null when valid, otherwise the reason. */
export function validateRange(range: DateRange): string | null {
  if (range.startDate.getTime() >= range.endDate.getTime()) {
    return 'startDate must be before endDate';
  }
  return null;
}

/**
 * Inclusive overlap: two periods sharing a single day still overlap, because a
 * school cannot be in two of them on the same date.
 */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return (
    a.startDate.getTime() <= b.endDate.getTime() &&
    b.startDate.getTime() <= a.endDate.getTime()
  );
}

/** True when `inner` falls entirely within `outer`, endpoints included. */
export function rangeContains(outer: DateRange, inner: DateRange): boolean {
  return (
    inner.startDate.getTime() >= outer.startDate.getTime() &&
    inner.endDate.getTime() <= outer.endDate.getTime()
  );
}
