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
