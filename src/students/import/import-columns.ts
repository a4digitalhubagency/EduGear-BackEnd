import { toCsvField } from './csv';

/**
 * The columns a student import understands, and every header a school is
 * likely to have typed for them. Headers are matched after lower-casing and
 * stripping punctuation, so "Adm. No", "ADM NO" and "adm_no" are one column.
 */
export interface ImportColumn {
  key: ImportField;
  label: string;
  aliases: string[];
  required: boolean;
  description: string;
}

export type ImportField =
  | 'studentId'
  | 'firstName'
  | 'lastName'
  | 'middleName'
  | 'gender'
  | 'dateOfBirth'
  | 'admissionDate'
  | 'classArm'
  | 'classArmId'
  | 'email'
  | 'phone'
  | 'addressLine'
  | 'stateOfOrigin'
  | 'lga'
  | 'nationality'
  | 'religion'
  | 'bloodGroup'
  | 'genotype'
  | 'notes'
  | 'guardianName'
  | 'guardianFirstName'
  | 'guardianLastName'
  | 'guardianPhone'
  | 'guardianEmail'
  | 'guardianRelationship';

export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  {
    key: 'studentId',
    label: 'Admission Number',
    aliases: [
      'admission no',
      'adm no',
      'admission number',
      'reg no',
      'registration number',
      'student id',
    ],
    required: false,
    description: 'Leave blank to generate one (e.g. 2025/0001).',
  },
  {
    key: 'firstName',
    label: 'First Name',
    aliases: ['first name', 'firstname', 'given name', 'forename'],
    required: true,
    description: 'Required.',
  },
  {
    key: 'lastName',
    label: 'Surname',
    aliases: ['surname', 'last name', 'lastname', 'family name'],
    required: true,
    description: 'Required.',
  },
  {
    key: 'middleName',
    label: 'Other Names',
    aliases: [
      'other names',
      'other name',
      'middle name',
      'middlename',
      'othernames',
    ],
    required: false,
    description: '',
  },
  {
    key: 'gender',
    label: 'Sex',
    aliases: ['sex', 'gender'],
    required: true,
    description: 'M or F (Male/Female also accepted).',
  },
  {
    key: 'dateOfBirth',
    label: 'Date of Birth',
    aliases: ['date of birth', 'dob', 'birth date', 'birthdate', 'd o b'],
    required: false,
    description: 'DD/MM/YYYY or YYYY-MM-DD.',
  },
  {
    key: 'admissionDate',
    label: 'Admission Date',
    aliases: [
      'admission date',
      'date of admission',
      'date admitted',
      'admitted',
    ],
    required: false,
    description: 'DD/MM/YYYY. Can be defaulted for the whole file.',
  },
  {
    key: 'classArm',
    label: 'Class',
    aliases: ['class', 'class arm', 'arm', 'classarm', 'class and arm'],
    required: false,
    description: 'As the school writes it, e.g. "JSS1 A".',
  },
  {
    key: 'classArmId',
    label: 'Class Arm ID',
    aliases: ['class arm id', 'classarmid'],
    required: false,
    description: 'For integrations; use Class otherwise.',
  },
  {
    key: 'email',
    label: 'Email',
    aliases: ['email', 'email address', 'student email'],
    required: false,
    description: '',
  },
  {
    key: 'phone',
    label: 'Phone',
    aliases: ['phone', 'phone number', 'student phone', 'mobile'],
    required: false,
    description: '',
  },
  {
    key: 'addressLine',
    label: 'Address',
    aliases: ['address', 'home address', 'residential address'],
    required: false,
    description: '',
  },
  {
    key: 'stateOfOrigin',
    label: 'State of Origin',
    aliases: ['state of origin', 'state', 'origin'],
    required: false,
    description: '',
  },
  {
    key: 'lga',
    label: 'LGA',
    aliases: ['lga', 'local government', 'local government area'],
    required: false,
    description: '',
  },
  {
    key: 'nationality',
    label: 'Nationality',
    aliases: ['nationality', 'country'],
    required: false,
    description: 'Defaults to Nigerian.',
  },
  {
    key: 'religion',
    label: 'Religion',
    aliases: ['religion'],
    required: false,
    description: '',
  },
  {
    key: 'bloodGroup',
    label: 'Blood Group',
    aliases: ['blood group', 'bloodgroup', 'blood type'],
    required: false,
    description: '',
  },
  {
    key: 'genotype',
    label: 'Genotype',
    aliases: ['genotype'],
    required: false,
    description: '',
  },
  {
    key: 'notes',
    label: 'Notes',
    aliases: ['notes', 'remarks', 'comment', 'comments'],
    required: false,
    description: '',
  },
  {
    key: 'guardianName',
    label: 'Parent Name',
    aliases: [
      'parent name',
      'guardian name',
      'parents name',
      'guardians name',
      'name of parent',
      'parent guardian name',
    ],
    required: false,
    description:
      'Full name in one column; titles such as Mr or Alhaji are dropped.',
  },
  {
    key: 'guardianFirstName',
    label: 'Parent First Name',
    aliases: ['parent first name', 'guardian first name'],
    required: false,
    description: 'Use instead of Parent Name for exact splitting.',
  },
  {
    key: 'guardianLastName',
    label: 'Parent Surname',
    aliases: [
      'parent surname',
      'parent last name',
      'guardian surname',
      'guardian last name',
    ],
    required: false,
    description: '',
  },
  {
    key: 'guardianPhone',
    label: 'Parent Phone',
    aliases: [
      'parent phone',
      'guardian phone',
      'parents phone',
      'parent phone number',
      'guardian phone number',
      'parent mobile',
    ],
    required: false,
    description:
      'Required when a parent is given. Siblings sharing it share a parent record.',
  },
  {
    key: 'guardianEmail',
    label: 'Parent Email',
    aliases: ['parent email', 'guardian email', 'parents email'],
    required: false,
    description: 'Needed for fee reminders and the parent portal.',
  },
  {
    key: 'guardianRelationship',
    label: 'Relationship',
    aliases: [
      'relationship',
      'guardian relationship',
      'relationship to student',
    ],
    required: false,
    description: 'Father, Mother, Guardian, Uncle… Defaults to Guardian.',
  },
];

export function normaliseHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const BY_ALIAS = new Map<string, ImportField>();
for (const column of IMPORT_COLUMNS) {
  for (const alias of [column.label, column.key, ...column.aliases]) {
    BY_ALIAS.set(normaliseHeader(alias), column.key);
  }
}

export interface HeaderMapping {
  /** Canonical field for each header position, or null when ignored. */
  fields: (ImportField | null)[];
  /** Headers that matched nothing — reported, never guessed at. */
  unknown: string[];
  /** Headers that map to a field another column already claimed. */
  duplicates: string[];
  missingRequired: string[];
}

export function mapHeaders(headers: readonly string[]): HeaderMapping {
  const seen = new Set<ImportField>();
  const fields: (ImportField | null)[] = [];
  const unknown: string[] = [];
  const duplicates: string[] = [];

  for (const header of headers) {
    const field = BY_ALIAS.get(normaliseHeader(header)) ?? null;
    if (!field) {
      if (header.trim() !== '') unknown.push(header);
      fields.push(null);
    } else if (seen.has(field)) {
      duplicates.push(header);
      fields.push(null);
    } else {
      seen.add(field);
      fields.push(field);
    }
  }

  const missingRequired = IMPORT_COLUMNS.filter(
    (column) => column.required && !seen.has(column.key),
  ).map((column) => column.label);

  return { fields, unknown, duplicates, missingRequired };
}

/** The downloadable starting point: headers plus two sibling rows. */
export function buildTemplateCsv(): string {
  const columns = IMPORT_COLUMNS.filter(
    (column) =>
      column.key !== 'classArmId' &&
      column.key !== 'guardianFirstName' &&
      column.key !== 'guardianLastName',
  );

  const example: Partial<Record<ImportField, string>> = {
    firstName: 'Adaeze',
    lastName: 'Okafor',
    middleName: 'Chioma',
    gender: 'F',
    dateOfBirth: '14/03/2013',
    admissionDate: '15/09/2025',
    classArm: 'JSS1 A',
    stateOfOrigin: 'Anambra',
    guardianName: 'Mr Emeka Okafor',
    guardianPhone: '08031234567',
    guardianEmail: 'emeka.okafor@example.com',
    guardianRelationship: 'Father',
  };
  const sibling: Partial<Record<ImportField, string>> = {
    ...example,
    firstName: 'Obinna',
    middleName: '',
    gender: 'M',
    dateOfBirth: '02/07/2011',
    classArm: 'JSS3 B',
  };

  const line = (values: Partial<Record<ImportField, string>>) =>
    columns.map((column) => toCsvField(values[column.key] ?? '')).join(',');

  return [
    columns.map((column) => toCsvField(column.label)).join(','),
    line(example),
    line(sibling),
  ].join('\r\n');
}
