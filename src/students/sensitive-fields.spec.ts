import {
  blankSensitiveToNull,
  clearSensitiveFields,
  consentColumns,
  hasSensitiveConsent,
  hasSensitiveData,
  populatedSensitiveFields,
  SENSITIVE_STUDENT_FIELDS,
  sensitiveFieldsNeedingConsent,
  withdrawSensitiveConsent,
} from './sensitive-fields';

describe('SENSITIVE_STUDENT_FIELDS', () => {
  it('covers every section 65 category the student record touches', () => {
    expect([...SENSITIVE_STUDENT_FIELDS].sort()).toEqual([
      'bloodGroup',
      'genotype',
      'lga',
      'religion',
      'stateOfOrigin',
    ]);
  });

  it('does not include nationality', () => {
    // Civil status, not ethnic origin. It appears on statutory returns and is
    // outside the section 65 list — erasing it with the rest would quietly
    // damage records the school is required to file.
    expect(SENSITIVE_STUDENT_FIELDS).not.toContain('nationality');
  });
});

describe('clearSensitiveFields', () => {
  it('nulls every field in the list', () => {
    expect(clearSensitiveFields()).toEqual({
      genotype: null,
      bloodGroup: null,
      religion: null,
      stateOfOrigin: null,
      lga: null,
    });
  });

  it('stays in step with the list', () => {
    // The payload is derived, not written out, so adding a field above cannot
    // leave a column un-erased here. This asserts that derivation holds.
    expect(Object.keys(clearSensitiveFields()).sort()).toEqual(
      [...SENSITIVE_STUDENT_FIELDS].sort(),
    );
  });

  it('returns a fresh object each time', () => {
    expect(clearSensitiveFields()).not.toBe(clearSensitiveFields());
  });
});

describe('populatedSensitiveFields', () => {
  it('names only the fields actually holding a value', () => {
    expect(
      populatedSensitiveFields({ genotype: 'AA', religion: 'Islam' }),
    ).toEqual(['genotype', 'religion']);
  });

  it('returns them in the declared order, not the order given', () => {
    expect(
      populatedSensitiveFields({ religion: 'Islam', genotype: 'AA' }),
    ).toEqual(['genotype', 'religion']);
  });

  it('ignores null, undefined and blank', () => {
    expect(
      populatedSensitiveFields({
        genotype: null,
        bloodGroup: undefined,
        religion: '',
        stateOfOrigin: '   ',
      }),
    ).toEqual([]);
  });

  it('handles a record with none of the fields at all', () => {
    expect(populatedSensitiveFields({})).toEqual([]);
  });
});

describe('hasSensitiveData', () => {
  it('is false for an empty record', () => {
    expect(hasSensitiveData({})).toBe(false);
    expect(hasSensitiveData({ genotype: null, lga: '' })).toBe(false);
  });

  it('is true as soon as one field holds a value', () => {
    expect(hasSensitiveData({ lga: 'Ikeja' })).toBe(true);
  });
});

describe('sensitive data consent', () => {
  const held = { sensitiveConsentAt: new Date('2026-09-01T00:00:00Z') };
  const none = { sensitiveConsentAt: null };

  describe('hasSensitiveConsent', () => {
    it('is true when a date is on record', () => {
      expect(hasSensitiveConsent(held)).toBe(true);
    });

    it('is false for a null date, a null record and an absent one', () => {
      expect(hasSensitiveConsent(none)).toBe(false);
      expect(hasSensitiveConsent(null)).toBe(false);
      expect(hasSensitiveConsent(undefined)).toBe(false);
    });
  });

  describe('sensitiveFieldsNeedingConsent', () => {
    it('names the fields a payload would populate when none is on record', () => {
      expect(
        sensitiveFieldsNeedingConsent(
          { genotype: 'AA', religion: 'Islam' },
          none,
        ),
      ).toEqual(['genotype', 'religion']);
    });

    it('needs nothing when consent is already on record', () => {
      expect(sensitiveFieldsNeedingConsent({ genotype: 'AA' }, held)).toEqual(
        [],
      );
    });

    it('ignores fields the payload does not touch', () => {
      expect(sensitiveFieldsNeedingConsent({ lga: undefined }, none)).toEqual(
        [],
      );
      expect(sensitiveFieldsNeedingConsent({}, none)).toEqual([]);
    });

    // Refusing to let a school delete sensitive data until it produces a
    // consent form would be exactly backwards.
    it('never asks for consent to clear a field', () => {
      expect(
        sensitiveFieldsNeedingConsent(
          { genotype: null, religion: '', lga: '   ' },
          none,
        ),
      ).toEqual([]);
    });

    it('asks only about the populated half of a mixed payload', () => {
      expect(
        sensitiveFieldsNeedingConsent({ genotype: null, lga: 'Ikeja' }, none),
      ).toEqual(['lga']);
    });
  });

  describe('blankSensitiveToNull', () => {
    it('turns a blank into null so the column matches IS NOT NULL honestly', () => {
      expect(blankSensitiveToNull({ genotype: '', lga: '  ' })).toEqual({
        genotype: null,
        lga: null,
      });
    });

    it('leaves real values, nulls and absent keys alone', () => {
      expect(blankSensitiveToNull({ genotype: 'AA', religion: null })).toEqual({
        genotype: 'AA',
        religion: null,
      });
      expect(Object.keys(blankSensitiveToNull({}))).toEqual([]);
    });

    it('does not touch anything outside the sensitive set', () => {
      const payload = { firstName: '  ', genotype: '  ' } as Record<
        string,
        unknown
      >;
      expect(blankSensitiveToNull(payload)).toEqual({
        firstName: '  ',
        genotype: null,
      });
    });

    it('does not mutate its argument', () => {
      const payload = { genotype: '' };
      blankSensitiveToNull(payload);
      expect(payload.genotype).toBe('');
    });
  });

  describe('consentColumns', () => {
    const now = new Date('2026-11-22T10:00:00Z');

    it('records the declaration', () => {
      expect(
        consentColumns({ method: 'ADMISSION_FORM', givenBy: 'Mrs Obi' }, now),
      ).toEqual({
        sensitiveConsentAt: now,
        sensitiveConsentBy: 'Mrs Obi',
        sensitiveConsentMethod: 'ADMISSION_FORM',
        sensitiveConsentWithdrawnAt: null,
      });
    });

    it('keeps the date on the form when one is given', () => {
      const signed = new Date('2026-09-04T00:00:00Z');
      expect(
        consentColumns({ method: 'CONSENT_FORM', givenAt: signed }, now)
          .sensitiveConsentAt,
      ).toEqual(signed);
    });

    // A bulk declaration has no individual signatory; the paper forms do.
    it('allows an absent signatory', () => {
      expect(
        consentColumns({ method: 'ADMISSION_FORM' }, now).sensitiveConsentBy,
      ).toBeNull();
    });

    // The whole reason this is one function and not three call sites.
    it('always ends a standing withdrawal', () => {
      expect(
        consentColumns({ method: 'CONSENT_FORM' }, now)
          .sensitiveConsentWithdrawnAt,
      ).toBeNull();
    });
  });

  describe('withdrawSensitiveConsent', () => {
    const now = new Date('2026-11-22T10:00:00Z');

    it('drops the record and stamps the refusal', () => {
      expect(withdrawSensitiveConsent(now)).toEqual({
        sensitiveConsentAt: null,
        sensitiveConsentBy: null,
        sensitiveConsentMethod: null,
        sensitiveConsentWithdrawnAt: now,
      });
    });

    // "A parent said no" and "nobody has asked yet" both leave the five
    // fields empty, and a bursar has to be able to tell them apart.
    it('leaves a trace, rather than returning the row to untouched', () => {
      expect(withdrawSensitiveConsent(now).sensitiveConsentWithdrawnAt).toEqual(
        now,
      );
    });
  });
});
