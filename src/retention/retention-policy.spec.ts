import {
  clearFields,
  cutoff,
  cutoffsFor,
  GUARDIAN_RESIDUE_FIELDS,
  RETENTION,
  STUDENT_RESIDUE_FIELDS,
} from './retention-policy';

const NOW = new Date('2026-11-22T10:00:00.000Z');

describe('STUDENT_RESIDUE_FIELDS', () => {
  it('destroys contact details, notes, the photo and every sensitive field', () => {
    expect([...STUDENT_RESIDUE_FIELDS].sort()).toEqual([
      'addressLine',
      'bloodGroup',
      'email',
      'genotype',
      'lga',
      'middleName',
      'notes',
      'phone',
      'photoUrl',
      'religion',
      'sensitiveConsentAt',
      'sensitiveConsentBy',
      'sensitiveConsentMethod',
      'sensitiveConsentWithdrawnAt',
      'stateOfOrigin',
    ]);
  });

  it('destroys the consent record with the data it authorised', () => {
    // Keeping it would leave a parent's name and a declaration on file
    // justifying something no longer held — surplus in its own right. The
    // audit trail already proves the consent existed.
    for (const field of [
      'sensitiveConsentAt',
      'sensitiveConsentBy',
      'sensitiveConsentMethod',
      'sensitiveConsentWithdrawnAt',
    ]) {
      expect(STUDENT_RESIDUE_FIELDS).toContain(field);
    }
  });

  it('keeps everything a transcript needs', () => {
    // This is the whole design. A departing student's record is shrunk to the
    // minimum necessary, not anonymised — a transcript without a name is
    // useless, and that is what the record is kept for.
    for (const kept of [
      'firstName',
      'lastName',
      'studentId',
      'gender',
      'dateOfBirth',
      'admissionDate',
      'nationality',
      'status',
    ]) {
      expect(STUDENT_RESIDUE_FIELDS).not.toContain(kept);
    }
  });

  it('keeps date of birth specifically', () => {
    // It is what separates two former students with the same name. Removing
    // it makes the record ambiguous exactly when someone relies on it.
    expect(STUDENT_RESIDUE_FIELDS).not.toContain('dateOfBirth');
  });
});

describe('GUARDIAN_RESIDUE_FIELDS', () => {
  it('destroys contact details but not the name', () => {
    // The name stays with the student record: who a child's guardian was is
    // part of the record. How to ring them is not.
    expect([...GUARDIAN_RESIDUE_FIELDS].sort()).toEqual([
      'addressLine',
      'altPhone',
      'email',
      'occupation',
      'phone',
    ]);
    expect(GUARDIAN_RESIDUE_FIELDS).not.toContain('firstName');
    expect(GUARDIAN_RESIDUE_FIELDS).not.toContain('lastName');
  });
});

describe('cutoff', () => {
  it('subtracts days', () => {
    expect(cutoff(NOW, { days: 90 })).toEqual(
      new Date('2026-08-24T10:00:00.000Z'),
    );
  });

  it('subtracts years through the calendar', () => {
    expect(cutoff(NOW, { years: 7 })).toEqual(
      new Date('2019-11-22T10:00:00.000Z'),
    );
  });

  it('subtracts months and lands on the same day of the month', () => {
    expect(cutoff(NOW, { months: 12 })).toEqual(
      new Date('2025-11-22T10:00:00.000Z'),
    );
    expect(cutoff(NOW, { months: 24 })).toEqual(
      new Date('2024-11-22T10:00:00.000Z'),
    );
  });

  it('crosses a year boundary going back by months', () => {
    const march = new Date('2026-03-10T08:00:00.000Z');
    expect(cutoff(march, { months: 12 })).toEqual(
      new Date('2025-03-10T08:00:00.000Z'),
    );
  });

  it('clamps rather than overshooting into the next month', () => {
    // 31 March minus one month is not 31 February. Rolling forward to 2 or 3
    // March would push the cutoff LATER and silently extend the retention
    // period — the error that favours keeping data, which is the wrong way to
    // be wrong.
    const march31 = new Date('2026-03-31T10:00:00.000Z');
    expect(cutoff(march31, { months: 1 })).toEqual(
      new Date('2026-02-28T10:00:00.000Z'),
    );
  });

  it('clamps into a leap February', () => {
    const march31 = new Date('2028-03-31T10:00:00.000Z');
    expect(cutoff(march31, { months: 1 })).toEqual(
      new Date('2028-02-29T10:00:00.000Z'),
    );
  });

  it('handles 29 February going back a year', () => {
    const leapDay = new Date('2028-02-29T10:00:00.000Z');
    expect(cutoff(leapDay, { years: 1 })).toEqual(
      new Date('2027-03-01T10:00:00.000Z'),
    );
  });

  it('returns the instant itself for an empty period', () => {
    expect(cutoff(NOW, {})).toEqual(NOW);
  });

  it('does not mutate the date it is given', () => {
    const original = new Date(NOW.getTime());
    cutoff(NOW, { months: 6, days: 3 });
    expect(NOW).toEqual(original);
  });

  it('always moves backwards', () => {
    for (const period of [
      { days: 1 },
      { months: 1 },
      { years: 1 },
      { months: 18 },
    ]) {
      expect(cutoff(NOW, period).getTime()).toBeLessThan(NOW.getTime());
    }
  });
});

describe('clearFields', () => {
  it('nulls every field given', () => {
    expect(clearFields(['a', 'b'] as const)).toEqual({ a: null, b: null });
  });

  it('covers the whole residue list', () => {
    expect(Object.keys(clearFields(STUDENT_RESIDUE_FIELDS)).sort()).toEqual(
      [...STUDENT_RESIDUE_FIELDS].sort(),
    );
  });
});

describe('cutoffsFor', () => {
  it('derives every cutoff from one instant', () => {
    const c = cutoffsFor(NOW);
    expect(c.studentMinimisation).toEqual(cutoff(NOW, { days: 90 }));
    expect(c.financial).toEqual(cutoff(NOW, { years: 7 }));
    expect(c.audit).toEqual(cutoff(NOW, { years: 7 }));
    expect(c.notification).toEqual(cutoff(NOW, { months: 24 }));
  });

  it('matches the published schedule', () => {
    // These numbers are in a document given to schools and parents. A change
    // here is a change to that document, not an implementation detail.
    expect(RETENTION.studentMinimisationGraceDays).toBe(90);
    expect(RETENTION.guardianContactMonths).toBe(12);
    expect(RETENTION.financialYears).toBe(7);
    expect(RETENTION.auditYears).toBe(7);
    expect(RETENTION.deactivatedAccountMonths).toBe(24);
    expect(RETENTION.schoolExportWindowDays).toBe(90);
  });

  it('orders the horizons as the schedule describes', () => {
    const c = cutoffsFor(NOW);
    // The 7-year ones reach furthest back; the 90-day grace is most recent.
    expect(c.financial.getTime()).toBeLessThan(c.notification.getTime());
    expect(c.notification.getTime()).toBeLessThan(c.guardianContact.getTime());
    expect(c.guardianContact.getTime()).toBeLessThan(
      c.studentMinimisation.getTime(),
    );
  });
});
