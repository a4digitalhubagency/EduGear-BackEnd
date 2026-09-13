import { Gender, GuardianRelationship } from '@prisma/client';
import { ImportField } from './import-columns';

/**
 * Turns one spreadsheet row of free text into typed values.
 *
 * Normalisation is deliberately forgiving about *form* — "f", "Female" and
 * "GIRL" are one gender; "15/09/2025" and "2025-09-15" are one date — and
 * strict about *meaning*: a date that does not exist, or a class nobody has
 * created, is an error the registrar has to see, never a guess.
 */

export interface RowIssue {
  field: string;
  message: string;
}

export interface NormalisedRow {
  studentId?: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  gender?: Gender;
  dateOfBirth?: Date;
  admissionDate?: Date;
  classArm?: string;
  classArmId?: string;
  email?: string;
  phone?: string;
  addressLine?: string;
  stateOfOrigin?: string;
  lga?: string;
  nationality?: string;
  religion?: string;
  bloodGroup?: string;
  genotype?: string;
  notes?: string;
  guardian?: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    relationship: GuardianRelationship;
  };
}

const GENDERS: Record<string, Gender> = {
  m: Gender.MALE,
  male: Gender.MALE,
  boy: Gender.MALE,
  f: Gender.FEMALE,
  female: Gender.FEMALE,
  girl: Gender.FEMALE,
};

const RELATIONSHIPS: Record<string, GuardianRelationship> = {
  father: GuardianRelationship.FATHER,
  dad: GuardianRelationship.FATHER,
  daddy: GuardianRelationship.FATHER,
  mother: GuardianRelationship.MOTHER,
  mum: GuardianRelationship.MOTHER,
  mom: GuardianRelationship.MOTHER,
  mummy: GuardianRelationship.MOTHER,
  guardian: GuardianRelationship.GUARDIAN,
  parent: GuardianRelationship.GUARDIAN,
  grandparent: GuardianRelationship.GRANDPARENT,
  grandfather: GuardianRelationship.GRANDPARENT,
  grandmother: GuardianRelationship.GRANDPARENT,
  sibling: GuardianRelationship.SIBLING,
  brother: GuardianRelationship.SIBLING,
  sister: GuardianRelationship.SIBLING,
  uncle: GuardianRelationship.UNCLE,
  aunt: GuardianRelationship.AUNT,
  aunty: GuardianRelationship.AUNT,
  auntie: GuardianRelationship.AUNT,
  other: GuardianRelationship.OTHER,
};

/** Honorifics dropped when splitting a one-column parent name. */
const TITLES = new Set([
  'mr',
  'mrs',
  'miss',
  'ms',
  'dr',
  'prof',
  'chief',
  'alhaji',
  'alhaja',
  'hajia',
  'mallam',
  'pastor',
  'rev',
  'engr',
  'barr',
  'sir',
  'lady',
  'hon',
  'deacon',
  'deaconess',
  'evang',
  'elder',
  'arc',
  'pharm',
]);

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DAY_FIRST = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

function realDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31/02/2025 rather than letting it roll over into March.
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

/**
 * ISO or day-first. Nigerian spreadsheets write DD/MM/YYYY, so "03/04/2013"
 * is 3 April — never read month-first, which would silently swap them.
 */
export function parseSchoolDate(value: string): Date | null {
  const iso = ISO_DATE.exec(value);
  if (iso) return realDate(+iso[1], +iso[2], +iso[3]);

  const dayFirst = DAY_FIRST.exec(value);
  if (dayFirst) return realDate(+dayFirst[3], +dayFirst[2], +dayFirst[1]);

  return null;
}

export function normaliseGender(value: string): Gender | null {
  return GENDERS[value.trim().toLowerCase()] ?? null;
}

export function normaliseRelationship(
  value: string,
): GuardianRelationship | null {
  const key = value.trim().toLowerCase();
  if (RELATIONSHIPS[key]) return RELATIONSHIPS[key];
  const upper = key.toUpperCase();
  return (Object.values(GuardianRelationship) as string[]).includes(upper)
    ? (upper as GuardianRelationship)
    : null;
}

/** Spaces, dashes, dots and brackets are how people type numbers, not part of them. */
export function normalisePhone(value: string): string {
  return value.replace(/[\s\-().]/g, '');
}

/** "Alhaji Musa Bello" → Musa / Bello. One remaining word cannot be split. */
export function splitName(
  full: string,
): { firstName: string; lastName: string } | null {
  const words = full
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !TITLES.has(word.toLowerCase().replace(/\.$/, '')));

  if (words.length < 2) return null;
  return { firstName: words[0], lastName: words[words.length - 1] };
}

/**
 * A cell holds text, a number or a boolean. A JSON row can carry anything, and
 * an object would otherwise stringify to "[object Object]" and be accepted as
 * a name — so non-scalars are reported instead.
 */
function text(
  raw: Partial<Record<ImportField, unknown>>,
  field: ImportField,
  issues: RowIssue[],
): string | undefined {
  const value = raw[field];
  if (value === null || value === undefined) return undefined;

  let scalar: string;
  if (typeof value === 'string') scalar = value;
  else if (typeof value === 'number' || typeof value === 'boolean') {
    scalar = String(value);
  } else {
    issues.push({ field, message: 'must be plain text, not a list or object' });
    return undefined;
  }

  const trimmed = scalar.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function normaliseRow(raw: Partial<Record<ImportField, unknown>>): {
  row: NormalisedRow;
  issues: RowIssue[];
} {
  const issues: RowIssue[] = [];
  const row: NormalisedRow = {};

  for (const field of [
    'studentId',
    'firstName',
    'lastName',
    'middleName',
    'classArm',
    'classArmId',
    'addressLine',
    'stateOfOrigin',
    'lga',
    'nationality',
    'religion',
    'bloodGroup',
    'genotype',
    'notes',
  ] as const) {
    row[field] = text(raw, field, issues);
  }

  const email = text(raw, 'email', issues);
  if (email) row.email = email.toLowerCase();
  const phone = text(raw, 'phone', issues);
  if (phone) row.phone = normalisePhone(phone);

  const gender = text(raw, 'gender', issues);
  if (gender) {
    const parsed = normaliseGender(gender);
    if (parsed) row.gender = parsed;
    else issues.push({ field: 'gender', message: `"${gender}" is not M or F` });
  }

  for (const field of ['dateOfBirth', 'admissionDate'] as const) {
    const value = raw[field];
    if (value instanceof Date) {
      row[field] = value;
      continue;
    }
    const raw_ = text(raw, field, issues);
    if (!raw_) continue;
    const parsed = parseSchoolDate(raw_);
    if (parsed) row[field] = parsed;
    else
      issues.push({
        field,
        message: `"${raw_}" is not a real date in DD/MM/YYYY or YYYY-MM-DD form`,
      });
  }

  const guardian = normaliseGuardian(raw, issues);
  if (guardian) row.guardian = guardian;

  return { row, issues };
}

function normaliseGuardian(
  raw: Partial<Record<ImportField, unknown>>,
  issues: RowIssue[],
): NormalisedRow['guardian'] | undefined {
  const fullName = text(raw, 'guardianName', issues);
  let firstName = text(raw, 'guardianFirstName', issues);
  let lastName = text(raw, 'guardianLastName', issues);
  const phoneRaw = text(raw, 'guardianPhone', issues);
  const email = text(raw, 'guardianEmail', issues)?.toLowerCase();
  const relationshipRaw = text(raw, 'guardianRelationship', issues);

  const anything =
    fullName || firstName || lastName || phoneRaw || email || relationshipRaw;
  if (!anything) return undefined;

  if (fullName && !firstName && !lastName) {
    const split = splitName(fullName);
    if (split) ({ firstName, lastName } = split);
    else
      issues.push({
        field: 'guardianName',
        message: `"${fullName}" needs a first name and a surname`,
      });
  }

  let relationship: GuardianRelationship = GuardianRelationship.GUARDIAN;
  if (relationshipRaw) {
    const parsed = normaliseRelationship(relationshipRaw);
    if (parsed) relationship = parsed;
    else
      issues.push({
        field: 'guardianRelationship',
        message: `"${relationshipRaw}" is not a relationship we recognise`,
      });
  }

  return {
    firstName,
    lastName,
    phone: phoneRaw ? normalisePhone(phoneRaw) : undefined,
    email,
    relationship,
  };
}

/**
 * One form for a Nigerian mobile number, so "+2348031234567", "2348031234567"
 * and "08031234567" are recognised as the same parent.
 */
export function canonicalPhone(phone: string): string {
  const compact = phone.replace(/[^\d+]/g, '');
  if (compact.startsWith('+234')) return `0${compact.slice(4)}`;
  if (compact.startsWith('234') && compact.length === 13) {
    return `0${compact.slice(3)}`;
  }
  return compact;
}

/** Every stored form a number might already be on file under. */
export function phoneVariants(phone: string): string[] {
  const canonical = canonicalPhone(phone);
  if (canonical.startsWith('0') && canonical.length === 11) {
    const national = canonical.slice(1);
    return [canonical, `234${national}`, `+234${national}`];
  }
  return [canonical];
}

/** "JSS1 A", "jss 1a" and "JSS1A" all name the same arm. */
export function armKey(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '');
}
