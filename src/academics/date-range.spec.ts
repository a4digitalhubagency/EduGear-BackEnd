import {
  rangeContains,
  rangesOverlap,
  toDateOnly,
  validateRange,
} from './date-range';

const range = (start: string, end: string) => ({
  startDate: new Date(start),
  endDate: new Date(end),
});

describe('validateRange', () => {
  it('accepts a normal school year', () => {
    expect(validateRange(range('2025-09-15', '2026-07-24'))).toBeNull();
  });

  it('rejects an end date before the start', () => {
    expect(validateRange(range('2026-07-24', '2025-09-15'))).toMatch(
      /before endDate/,
    );
  });

  it('rejects a zero-length session', () => {
    expect(validateRange(range('2025-09-15', '2025-09-15'))).toMatch(
      /before endDate/,
    );
  });
});

describe('toDateOnly', () => {
  it('strips the time so a late-evening submission keeps its date', () => {
    expect(toDateOnly(new Date('2025-09-15T23:30:00Z')).toISOString()).toBe(
      '2025-09-15T00:00:00.000Z',
    );
  });
});

describe('rangesOverlap', () => {
  const session = range('2025-09-15', '2026-07-24');

  it('detects a fully contained range', () => {
    expect(rangesOverlap(session, range('2025-10-01', '2025-12-20'))).toBe(
      true,
    );
  });

  it('detects a partial overlap at the tail', () => {
    expect(rangesOverlap(session, range('2026-07-01', '2027-01-01'))).toBe(
      true,
    );
  });

  it('treats a single shared day as an overlap', () => {
    // A school cannot be running two sessions on the same date.
    expect(rangesOverlap(session, range('2026-07-24', '2027-07-24'))).toBe(
      true,
    );
  });

  it('allows the next session to start the day after', () => {
    expect(rangesOverlap(session, range('2026-07-25', '2027-07-24'))).toBe(
      false,
    );
  });

  it('allows a session entirely in the past', () => {
    expect(rangesOverlap(session, range('2024-09-15', '2025-07-24'))).toBe(
      false,
    );
  });
});

describe('rangeContains', () => {
  const session = range('2025-09-15', '2026-07-24');

  it('accepts a term inside the session', () => {
    expect(rangeContains(session, range('2025-09-15', '2025-12-19'))).toBe(
      true,
    );
  });

  it('accepts a term spanning the whole session', () => {
    expect(rangeContains(session, range('2025-09-15', '2026-07-24'))).toBe(
      true,
    );
  });

  it('rejects a term starting before the session', () => {
    expect(rangeContains(session, range('2025-09-01', '2025-12-19'))).toBe(
      false,
    );
  });

  it('rejects a term ending after the session', () => {
    expect(rangeContains(session, range('2026-05-01', '2026-08-01'))).toBe(
      false,
    );
  });
});
