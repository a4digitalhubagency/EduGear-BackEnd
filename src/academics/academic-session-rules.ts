/**
 * Pure rules for an academic session. Kept out of the service so the domain
 * logic can be tested without a database.
 */

/** The Nigerian convention, and the format the schema documents: "2025/2026". */
const SESSION_NAME_PATTERN = /^(\d{4})\/(\d{4})$/;

export interface DateRange {
  startDate: Date;
  endDate: Date;
}

/**
 * Sessions are date-only (`@db.Date`). Normalising to UTC midnight keeps a
 * request from a UTC+1 client from landing on the previous day.
 */
export function toDateOnly(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

/**
 * Returns null when valid, otherwise the reason. A session spans two
 * consecutive years, so "2025/2027" is a typo rather than a naming choice.
 */
export function validateSessionName(name: string): string | null {
  const match = SESSION_NAME_PATTERN.exec(name);
  if (!match) {
    return 'name must look like "2025/2026"';
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end !== start + 1) {
    return `name must span consecutive years, e.g. "${start}/${start + 1}"`;
  }

  return null;
}

/** Returns null when valid, otherwise the reason. */
export function validateSessionRange(range: DateRange): string | null {
  if (range.startDate.getTime() >= range.endDate.getTime()) {
    return 'startDate must be before endDate';
  }
  return null;
}

/**
 * Inclusive overlap: two sessions sharing a single day still overlap, because a
 * school cannot be in two sessions on the same date.
 */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return (
    a.startDate.getTime() <= b.endDate.getTime() &&
    b.startDate.getTime() <= a.endDate.getTime()
  );
}
