/**
 * Student fields that are **sensitive personal data** under section 65 of the
 * Nigeria Data Protection Act 2023.
 *
 * These are not merely "personal" like a name or an address. Section 30 governs
 * them separately, and — crucially — **it does not carry the exemption for
 * education that section 31(4)(b) provides.** So while an ordinary student
 * record needs no parental consent (it is processing "for purposes of
 * education … by a professional owing a duty of confidentiality"), these five
 * columns do: section 30(1)(a) consent, given by a parent under section 31(1).
 *
 * Two consequences follow, and both are implemented:
 *
 * 1. **Consent can always be withdrawn** (section 35), and withdrawal has to be
 *    as easy as giving it. So erasing these is unconditional — unlike the rest
 *    of the record, there is no competing lawful basis to weigh.
 * 2. **They are residue when a student leaves.** None of them appears on a
 *    transcript, so the retention schedule destroys them on departure while
 *    keeping the academic record.
 *
 * Keeping the list here, rather than spelling the columns out at each call
 * site, is what makes the set auditable: if a column is added to the schema
 * that falls within section 65, it is added here and every path that clears
 * sensitive data picks it up at once.
 *
 * @see docs/legal/retention-schedule.md §2.1, §9
 */

/**
 * Note on what is *absent*: `nationality` is not here. Section 65(b) covers
 * "race or ethnic origin", which `stateOfOrigin` and `lga` proxy closely in
 * Nigeria; nationality is a civil status, appears on statutory returns, and is
 * not within the section 65 list.
 */
export const SENSITIVE_STUDENT_FIELDS = [
  /** s.65(a) genetic data, and (d) health status. */
  'genotype',
  /** s.65(d) health status. */
  'bloodGroup',
  /** s.65(c) religious or similar beliefs. */
  'religion',
  /** s.65(b) race or ethnic origin — state of origin is a close proxy. */
  'stateOfOrigin',
  /** s.65(b) race or ethnic origin. */
  'lga',
] as const;

export type SensitiveStudentField = (typeof SENSITIVE_STUDENT_FIELDS)[number];

/** Any record shaped enough to ask the question of. */
export type MaybeSensitive = Partial<
  Record<SensitiveStudentField, string | null>
>;

/**
 * The update payload that clears every sensitive column.
 *
 * Built from the list rather than written out, so a new entry above cannot be
 * forgotten here.
 */
export function clearSensitiveFields(): Record<SensitiveStudentField, null> {
  return Object.fromEntries(
    SENSITIVE_STUDENT_FIELDS.map((field) => [field, null]),
  ) as Record<SensitiveStudentField, null>;
}

/**
 * Which sensitive fields this record actually holds a value for.
 *
 * Used to name them in the audit entry. Naming the *fields* is deliberate and
 * safe — "genotype, religion" records what was erased without writing the
 * values themselves into a log that outlives them, which would defeat the
 * erasure entirely.
 */
export function populatedSensitiveFields(
  row: MaybeSensitive,
): SensitiveStudentField[] {
  return SENSITIVE_STUDENT_FIELDS.filter((field) => {
    const value = row[field];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/** True when there is anything to erase. */
export function hasSensitiveData(row: MaybeSensitive): boolean {
  return populatedSensitiveFields(row).length > 0;
}

/* ------------------------------------------------------------------------- *
 * Consent
 *
 * The five fields above are held under consent, and section 26(2) of the NDP
 * Act puts the burden of *demonstrating* that consent on the controller. A
 * policy sentence saying "the school obtains consent" does not discharge it —
 * only a record does. So consent is a row on the student, and these are the
 * rules that keep the data and the record from drifting apart.
 * ------------------------------------------------------------------------- */

/** The consent record as stored, narrowed to what the rules actually read. */
export interface SensitiveConsentState {
  sensitiveConsentAt: Date | null;
}

/**
 * Whether consent is on record.
 *
 * `null` for the whole record — rather than a row with a null date — is what a
 * payload looks like before anything has been stored, so both are accepted and
 * both mean "no".
 */
export function hasSensitiveConsent(
  state: SensitiveConsentState | null | undefined,
): boolean {
  return state?.sensitiveConsentAt != null;
}

/**
 * The sensitive fields this payload would *populate*, which is the only case
 * consent is needed for.
 *
 * The three states a key can be in are deliberately distinguished:
 *
 * - absent (`undefined`) — not being touched, so nothing to authorise;
 * - `null` or blank — being cleared, which never needs consent (refusing to
 *   let a school delete sensitive data until it produces a consent form would
 *   be exactly backwards);
 * - a value — being written, which does.
 *
 * `populatedSensitiveFields` already draws that line, so this is the same
 * question asked of a payload instead of a row.
 */
export function sensitiveFieldsNeedingConsent(
  payload: MaybeSensitive,
  state: SensitiveConsentState | null | undefined,
): SensitiveStudentField[] {
  if (hasSensitiveConsent(state)) return [];
  return populatedSensitiveFields(payload);
}

/**
 * Rewrites blank sensitive values to null.
 *
 * An empty genotype is no genotype, and storing `''` for it would make the
 * column disagree with every other part of this module: `populatedSensitiveFields`
 * reads `''` as absent, while a `sensitiveConsentAt IS NULL AND genotype IS NOT
 * NULL` query would read it as present. One of the two has to give, and the
 * right answer is not to store the blank in the first place.
 *
 * Only keys actually present are touched, so an absent key stays absent and a
 * partial update stays partial.
 */
export function blankSensitiveToNull<T extends MaybeSensitive>(payload: T): T {
  const result = { ...payload };

  for (const field of SENSITIVE_STUDENT_FIELDS) {
    const value = result[field];
    if (typeof value === 'string' && value.trim().length === 0) {
      result[field] = null;
    }
  }

  return result;
}

/**
 * The update payload that withdraws consent.
 *
 * Paired with `clearSensitiveFields()` on the same write, never on its own:
 * leaving the data while dropping the record of why it was lawful to hold is
 * worse than either alone. `sensitiveConsentWithdrawnAt` is stamped rather
 * than left null so an empty genotype can be told apart from a refused one.
 */
export function withdrawSensitiveConsent(now: Date) {
  return {
    sensitiveConsentAt: null,
    sensitiveConsentBy: null,
    sensitiveConsentMethod: null,
    sensitiveConsentWithdrawnAt: now,
  } as const;
}

/**
 * A recorded consent, as whichever path is writing it supplies it.
 *
 * Generic in the method so this file stays free of generated Prisma types —
 * the enum lives in the schema, the rule lives here.
 */
export interface SensitiveConsentDeclaration<M = string> {
  method: M;
  /** Absent on a bulk declaration, where the paper forms name the signatories. */
  givenBy?: string | null;
  /** The date on the form, which may predate the record being entered. */
  givenAt?: Date;
}

/**
 * The four columns that record a consent.
 *
 * One implementation serving the single-student form, the bulk endpoint and the
 * spreadsheet import. Three call sites writing these columns by hand is three
 * chances to forget `sensitiveConsentWithdrawnAt: null` and leave a withdrawal
 * standing against data the parent has since re-consented to.
 */
export function consentColumns<M>(
  declaration: SensitiveConsentDeclaration<M>,
  now: Date,
) {
  return {
    sensitiveConsentAt: declaration.givenAt ?? now,
    sensitiveConsentBy: declaration.givenBy ?? null,
    sensitiveConsentMethod: declaration.method,
    // Consent given again ends an earlier withdrawal. Leaving the date behind
    // it would read as a refusal that is still standing.
    sensitiveConsentWithdrawnAt: null,
  };
}
