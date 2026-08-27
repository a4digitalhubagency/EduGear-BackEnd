/**
 * Rules specific to an academic session. Date arithmetic common to every
 * academic period lives in `date-range.ts`.
 */

/** The Nigerian convention, and the format the schema documents: "2025/2026". */
const SESSION_NAME_PATTERN = /^(\d{4})\/(\d{4})$/;

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
