/**
 * Which days of the week a school actually opens.
 *
 * Being inside a term is not the same as being a school day: a term runs from
 * September to December without pausing for the weekends inside it, so a term
 * lookup alone accepts a register for a Sunday. Schools are the ones who know
 * their week — most run Monday to Friday, some run a sixth day — so the pattern
 * is a setting rather than a constant.
 *
 * Stored as a 7-bit mask so the settings row stays one scalar column: comparing
 * it for "did this change" is `!==`, which an array column would quietly get
 * wrong by comparing references.
 *
 * This does not model a single irregular day — a make-up Saturday, or a holiday
 * inside a term. That needs a per-date calendar, which is a larger feature than
 * a weekly pattern and deliberately not attempted here.
 */

/** Index is `Date.prototype.getUTCDay()`: 0 is Sunday. */
export const WEEKDAYS = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** Every bit that means anything; guards against a corrupt or stale value. */
const ALL_DAYS_MASK = 0b1111111;

/** Monday to Friday — what a school gets before it says otherwise. */
export const DEFAULT_SCHOOL_DAYS_MASK = 0b0111110;

/**
 * Dates here are date-only values at UTC midnight (see `toDateOnly`), so the
 * weekday must be read in UTC. Reading it locally would shift the day for any
 * server west of Greenwich and make a Monday register fail in Lagos.
 */
export function weekdayOf(date: Date): Weekday {
  return WEEKDAYS[date.getUTCDay()];
}

export function isSchoolDay(date: Date, mask: number): boolean {
  return (normaliseMask(mask) & (1 << date.getUTCDay())) !== 0;
}

export function daysFromMask(mask: number): Weekday[] {
  const normalised = normaliseMask(mask);
  return WEEKDAYS.filter((_, index) => (normalised & (1 << index)) !== 0);
}

export function maskFromDays(days: readonly Weekday[]): number {
  return days.reduce((mask, day) => mask | (1 << WEEKDAYS.indexOf(day)), 0);
}

/**
 * A school with no open day could never take a register again, and nothing in
 * the product would explain why — so an empty week is refused at the edge
 * rather than stored. Bits outside the week are dropped.
 */
export function normaliseMask(mask: number): number {
  const masked = Number.isInteger(mask) ? mask & ALL_DAYS_MASK : 0;
  return masked === 0 ? DEFAULT_SCHOOL_DAYS_MASK : masked;
}

/** "Saturday" rather than "SATURDAY", for a message a parent might read. */
export function humanWeekday(day: Weekday): string {
  return day.charAt(0) + day.slice(1).toLowerCase();
}
