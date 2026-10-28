import {
  DEFAULT_SCHOOL_DAYS_MASK,
  daysFromMask,
  humanWeekday,
  isSchoolDay,
  maskFromDays,
  normaliseMask,
  weekdayOf,
} from './school-days';

/** The Sunday the register was wrongly accepted for, and the days around it. */
const SUNDAY = new Date(Date.UTC(2025, 9, 12));
const SATURDAY = new Date(Date.UTC(2025, 9, 11));
const MONDAY = new Date(Date.UTC(2025, 9, 13));
const FRIDAY = new Date(Date.UTC(2025, 9, 17));

describe('weekdayOf', () => {
  it('names the day in UTC', () => {
    expect(weekdayOf(SUNDAY)).toBe('SUNDAY');
    expect(weekdayOf(SATURDAY)).toBe('SATURDAY');
    expect(weekdayOf(MONDAY)).toBe('MONDAY');
  });

  it('reads the UTC day even when the local day differs', () => {
    // 23:30 UTC on Sunday is already Monday in Lagos (UTC+1). The stored value
    // is what counts, so this is still Sunday.
    const lateSunday = new Date(Date.UTC(2025, 9, 12, 23, 30));
    expect(weekdayOf(lateSunday)).toBe('SUNDAY');
  });
});

describe('isSchoolDay', () => {
  it('refuses the weekend by default', () => {
    expect(isSchoolDay(SATURDAY, DEFAULT_SCHOOL_DAYS_MASK)).toBe(false);
    expect(isSchoolDay(SUNDAY, DEFAULT_SCHOOL_DAYS_MASK)).toBe(false);
  });

  it('accepts Monday to Friday by default', () => {
    expect(isSchoolDay(MONDAY, DEFAULT_SCHOOL_DAYS_MASK)).toBe(true);
    expect(isSchoolDay(FRIDAY, DEFAULT_SCHOOL_DAYS_MASK)).toBe(true);
  });

  it('accepts Saturday for a school that opens on one', () => {
    const sixDayWeek = maskFromDays([
      'MONDAY',
      'TUESDAY',
      'WEDNESDAY',
      'THURSDAY',
      'FRIDAY',
      'SATURDAY',
    ]);
    expect(isSchoolDay(SATURDAY, sixDayWeek)).toBe(true);
    expect(isSchoolDay(SUNDAY, sixDayWeek)).toBe(false);
  });

  it('can refuse a weekday a school does not open', () => {
    const fridayOff = maskFromDays([
      'MONDAY',
      'TUESDAY',
      'WEDNESDAY',
      'THURSDAY',
    ]);
    expect(isSchoolDay(FRIDAY, fridayOff)).toBe(false);
    expect(isSchoolDay(MONDAY, fridayOff)).toBe(true);
  });
});

describe('maskFromDays / daysFromMask', () => {
  it('round-trips', () => {
    const days = ['MONDAY', 'WEDNESDAY', 'SATURDAY'] as const;
    expect(daysFromMask(maskFromDays(days))).toEqual([
      'MONDAY',
      'WEDNESDAY',
      'SATURDAY',
    ]);
  });

  it('returns days in week order regardless of input order', () => {
    expect(daysFromMask(maskFromDays(['FRIDAY', 'MONDAY']))).toEqual([
      'MONDAY',
      'FRIDAY',
    ]);
  });

  it('ignores a day listed twice', () => {
    expect(maskFromDays(['MONDAY', 'MONDAY'])).toBe(maskFromDays(['MONDAY']));
  });

  it('describes the default as the working week', () => {
    expect(daysFromMask(DEFAULT_SCHOOL_DAYS_MASK)).toEqual([
      'MONDAY',
      'TUESDAY',
      'WEDNESDAY',
      'THURSDAY',
      'FRIDAY',
    ]);
  });
});

describe('normaliseMask', () => {
  it('falls back to the default rather than closing the school forever', () => {
    expect(normaliseMask(0)).toBe(DEFAULT_SCHOOL_DAYS_MASK);
  });

  it('drops bits outside the week', () => {
    expect(normaliseMask(0b11111111)).toBe(0b1111111);
  });

  it('survives a value that is not a whole number', () => {
    expect(normaliseMask(Number.NaN)).toBe(DEFAULT_SCHOOL_DAYS_MASK);
    expect(normaliseMask(1.5)).toBe(DEFAULT_SCHOOL_DAYS_MASK);
  });

  it('keeps a legitimate single-day week', () => {
    expect(normaliseMask(maskFromDays(['SATURDAY']))).toBe(0b1000000);
  });
});

describe('humanWeekday', () => {
  it('reads as a word, not a constant', () => {
    expect(humanWeekday('SUNDAY')).toBe('Sunday');
    expect(humanWeekday('WEDNESDAY')).toBe('Wednesday');
  });
});
