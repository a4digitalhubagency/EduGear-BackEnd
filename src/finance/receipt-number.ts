/**
 * Receipt numbers are issued on verification, not on recording: an unverified
 * payment has no receipt to present. They are unique per school and shaped
 * `RCP/<year>/<6-digit sequence>` so a bursar can read one over the phone.
 */
/** Any prefix, so changing it does not restart the year's numbering. */
export const RECEIPT_NUMBER_PATTERN = /^(?:.*\/)?(\d{4})\/(\d{6,})$/;

export function formatReceiptNumber(
  year: number,
  sequence: number,
  prefix = 'RCP',
): string {
  return `${prefix}/${year}/${String(sequence).padStart(6, '0')}`;
}

/** Highest sequence already issued in `year`, ignoring anything off-pattern. */
export function nextReceiptSequence(
  existing: readonly string[],
  year: number,
): number {
  let highest = 0;

  for (const value of existing) {
    const match = RECEIPT_NUMBER_PATTERN.exec(value);
    if (!match || Number(match[1]) !== year) continue;
    highest = Math.max(highest, Number(match[2]));
  }

  return highest + 1;
}
