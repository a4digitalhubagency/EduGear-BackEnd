import { Gender, GuardianRelationship } from '@prisma/client';
import {
  armKey,
  canonicalPhone,
  normaliseGender,
  normalisePhone,
  normaliseRelationship,
  normaliseRow,
  parseSchoolDate,
  phoneVariants,
  splitName,
} from './import-row';

const utc = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d));

describe('parseSchoolDate', () => {
  it('reads ISO dates', () => {
    expect(parseSchoolDate('2025-09-15')).toEqual(utc(2025, 9, 15));
  });

  it('reads day-first dates with slashes, dots or dashes', () => {
    expect(parseSchoolDate('15/09/2025')).toEqual(utc(2025, 9, 15));
    expect(parseSchoolDate('15.09.2025')).toEqual(utc(2025, 9, 15));
    expect(parseSchoolDate('15-09-2025')).toEqual(utc(2025, 9, 15));
    expect(parseSchoolDate('5/9/2025')).toEqual(utc(2025, 9, 5));
  });

  it('reads 03/04 as 3 April, never March 4th', () => {
    expect(parseSchoolDate('03/04/2013')).toEqual(utc(2013, 4, 3));
  });

  it.each(['31/02/2025', '29/02/2025', '00/01/2025', '15/13/2025'])(
    'rejects the impossible date %p rather than rolling it over',
    (value) => {
      expect(parseSchoolDate(value)).toBeNull();
    },
  );

  it('accepts a real leap day', () => {
    expect(parseSchoolDate('29/02/2024')).toEqual(utc(2024, 2, 29));
  });

  it.each(['15/09/25', 'September 15', '2025/09/15', ''])(
    'rejects the ambiguous form %p',
    (value) => {
      expect(parseSchoolDate(value)).toBeNull();
    },
  );
});

describe('normaliseGender', () => {
  it.each([
    ['M', Gender.MALE],
    ['male', Gender.MALE],
    ['Boy', Gender.MALE],
    ['f', Gender.FEMALE],
    ['FEMALE', Gender.FEMALE],
    [' girl ', Gender.FEMALE],
  ])('%p → %p', (value, expected) => {
    expect(normaliseGender(value)).toBe(expected);
  });

  it('rejects anything else', () => {
    expect(normaliseGender('X')).toBeNull();
  });
});

describe('normaliseRelationship', () => {
  it.each([
    ['Father', GuardianRelationship.FATHER],
    ['mum', GuardianRelationship.MOTHER],
    ['Grandmother', GuardianRelationship.GRANDPARENT],
    ['sister', GuardianRelationship.SIBLING],
    ['AUNTY', GuardianRelationship.AUNT],
    ['GUARDIAN', GuardianRelationship.GUARDIAN],
  ])('%p → %p', (value, expected) => {
    expect(normaliseRelationship(value)).toBe(expected);
  });

  it('rejects an unknown relationship', () => {
    expect(normaliseRelationship('neighbour')).toBeNull();
  });
});

describe('normalisePhone', () => {
  it('strips the characters people type numbers with', () => {
    expect(normalisePhone('0803 123-4567')).toBe('08031234567');
    expect(normalisePhone('+234 (803) 123.4567')).toBe('+2348031234567');
  });
});

describe('splitName', () => {
  it.each([
    ['Emeka Okafor', 'Emeka', 'Okafor'],
    ['Mr Emeka Okafor', 'Emeka', 'Okafor'],
    ['Alhaji Musa Bello', 'Musa', 'Bello'],
    ['Mrs. Ngozi Chioma Eze', 'Ngozi', 'Eze'],
    ['Chief Dr Adewale Johnson', 'Adewale', 'Johnson'],
  ])('%p → %p %p', (full, first, last) => {
    expect(splitName(full)).toEqual({ firstName: first, lastName: last });
  });

  it('cannot split a single remaining word', () => {
    expect(splitName('Mr Okafor')).toBeNull();
  });
});

describe('normaliseRow', () => {
  it('normalises a whole spreadsheet row', () => {
    const { row, issues } = normaliseRow({
      firstName: ' Adaeze ',
      lastName: 'Okafor',
      gender: 'F',
      dateOfBirth: '14/03/2013',
      admissionDate: '15/09/2025',
      email: 'ADA@Example.com',
      middleName: '',
      guardianName: 'Mr Emeka Okafor',
      guardianPhone: '0803 123 4567',
      guardianRelationship: 'Father',
    });

    expect(issues).toEqual([]);
    expect(row).toMatchObject({
      firstName: 'Adaeze',
      gender: Gender.FEMALE,
      dateOfBirth: utc(2013, 3, 14),
      email: 'ada@example.com',
      guardian: {
        firstName: 'Emeka',
        lastName: 'Okafor',
        phone: '08031234567',
        relationship: GuardianRelationship.FATHER,
      },
    });
    expect(row.middleName).toBeUndefined();
  });

  it('collects every problem on a row instead of stopping at the first', () => {
    const { issues } = normaliseRow({
      gender: 'X',
      dateOfBirth: '31/02/2013',
      guardianName: 'Okafor',
      guardianRelationship: 'neighbour',
    });

    expect(issues.map((issue) => issue.field).sort()).toEqual([
      'dateOfBirth',
      'gender',
      'guardianName',
      'guardianRelationship',
    ]);
  });

  it('defaults the relationship to GUARDIAN', () => {
    const { row } = normaliseRow({
      guardianFirstName: 'Emeka',
      guardianLastName: 'Okafor',
      guardianPhone: '08031234567',
    });
    expect(row.guardian?.relationship).toBe(GuardianRelationship.GUARDIAN);
  });

  it('prefers explicit parent first and last names over splitting', () => {
    const { row } = normaliseRow({
      guardianName: 'Mr Emeka Chukwuma Okafor',
      guardianFirstName: 'Emeka Chukwuma',
      guardianLastName: 'Okafor',
      guardianPhone: '08031234567',
    });
    expect(row.guardian).toMatchObject({
      firstName: 'Emeka Chukwuma',
      lastName: 'Okafor',
    });
  });

  it('refuses a list or object where text belongs', () => {
    const { row, issues } = normaliseRow({
      firstName: { nested: true },
      lastName: ['Obi'],
    });
    expect(row.firstName).toBeUndefined();
    expect(issues.map((issue) => issue.field).sort()).toEqual([
      'firstName',
      'lastName',
    ]);
  });

  it('accepts a number in a text column', () => {
    expect(normaliseRow({ studentId: 1042 }).row.studentId).toBe('1042');
  });

  it('leaves a row with no parent columns without a guardian', () => {
    expect(normaliseRow({ firstName: 'Ada' }).row.guardian).toBeUndefined();
  });
});

describe('canonicalPhone', () => {
  it.each([
    ['08031234567', '08031234567'],
    ['+2348031234567', '08031234567'],
    ['2348031234567', '08031234567'],
    ['0803 123 4567', '08031234567'],
  ])('%p → %p', (value, expected) => {
    expect(canonicalPhone(value)).toBe(expected);
  });
});

describe('phoneVariants', () => {
  it('lists every stored form of a local number', () => {
    expect(phoneVariants('08031234567')).toEqual([
      '08031234567',
      '2348031234567',
      '+2348031234567',
    ]);
  });
});

describe('armKey', () => {
  it('ignores case and spacing', () => {
    expect(armKey('JSS1 A')).toBe(armKey('jss 1a'));
    expect(armKey('JSS1 A')).toBe(armKey('JSS1A'));
  });
});
