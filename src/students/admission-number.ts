/**
 * Admission numbers are unique per school, not globally, so each school gets
 * its own sequence. The shape is `<admission year>/<4-digit sequence>` —
 * "2025/0001" — which is what Nigerian secondary schools already write on a
 * file, and it sorts correctly as text within a year.
 */
/**
 * Matches a generated number with or without a school's prefix, so changing the
 * prefix mid-year continues the sequence instead of restarting it at 0001.
 */
export const ADMISSION_NUMBER_PATTERN = /^(?:.*\/)?(\d{4})\/(\d{4,})$/;

export function formatAdmissionNumber(
  year: number,
  sequence: number,
  prefix?: string | null,
): string {
  const core = `${year}/${String(sequence).padStart(4, '0')}`;
  return prefix ? `${prefix}/${core}` : core;
}

/**
 * Finds every number issued in `year`, whatever prefix was in force when it
 * was issued.
 *
 * Both shapes have to be matched, and matching only one is how the prefix
 * setting came to brick admissions: with `admissionNumberPrefix = 'GFA'` the
 * numbers read `GFA/2026/0001`, which does not *start with* `2026/`. The
 * lookup therefore found nothing, `nextSequence` answered 1 every time, the
 * unique index refused it, and every retry recomputed the same 1 — so a school
 * that set a prefix could admit exactly one student and then saw "Could not
 * allocate an admission number" forever.
 *
 * `ADMISSION_NUMBER_PATTERN` was always prefix-tolerant, which is why this
 * looked right in review: the parser ignores the prefix, and nobody checked
 * that the query feeding it did too. The receipt-number lookup gets this right
 * with `contains`; this is the same idea for both shapes at once.
 *
 * A value that merely happens to contain `/2026/` is harmless — `nextSequence`
 * skips anything off-pattern.
 */
export function admissionNumbersIssuedIn(year: number) {
  return {
    OR: [
      // Unprefixed: "2026/0001".
      { studentId: { startsWith: `${year}/` } },
      // Prefixed with anything: "GFA/2026/0001".
      { studentId: { contains: `/${year}/` } },
    ],
  };
}

/**
 * Highest sequence already used in `year`, given the numbers on file. Anything
 * not matching the generated shape is a school's own hand-typed number and is
 * skipped rather than guessed at.
 */
export function nextSequence(
  existing: readonly string[],
  year: number,
): number {
  let highest = 0;

  for (const value of existing) {
    const match = ADMISSION_NUMBER_PATTERN.exec(value);
    if (!match || Number(match[1]) !== year) continue;

    highest = Math.max(highest, Number(match[2]));
  }

  return highest + 1;
}
