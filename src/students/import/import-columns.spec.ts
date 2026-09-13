import { parseCsv } from './csv';
import {
  buildTemplateCsv,
  mapHeaders,
  normaliseHeader,
} from './import-columns';

describe('normaliseHeader', () => {
  it.each([
    ['Adm. No', 'adm no'],
    ['ADM_NO', 'adm no'],
    ["Parent's Phone", 'parents phone'],
    ['  Date of Birth ', 'date of birth'],
  ])('%p → %p', (raw, expected) => {
    expect(normaliseHeader(raw)).toBe(expected);
  });
});

describe('mapHeaders', () => {
  it('maps the headers schools actually write', () => {
    const mapping = mapHeaders([
      'Adm. No',
      'Surname',
      'First Name',
      'Sex',
      'DOB',
      'Class',
      "Parent's Phone",
    ]);
    expect(mapping.fields).toEqual([
      'studentId',
      'lastName',
      'firstName',
      'gender',
      'dateOfBirth',
      'classArm',
      'guardianPhone',
    ]);
    expect(mapping.missingRequired).toEqual([]);
  });

  it('reports unknown headers rather than guessing', () => {
    const mapping = mapHeaders(['First Name', 'Surname', 'Sex', 'Shoe Size']);
    expect(mapping.unknown).toEqual(['Shoe Size']);
    expect(mapping.fields[3]).toBeNull();
  });

  it('lists missing required columns by their label', () => {
    expect(mapHeaders(['First Name']).missingRequired).toEqual([
      'Surname',
      'Sex',
    ]);
  });

  it('refuses a second column for a field already claimed', () => {
    const mapping = mapHeaders(['First Name', 'Firstname', 'Surname', 'Sex']);
    expect(mapping.duplicates).toEqual(['Firstname']);
    expect(mapping.fields[1]).toBeNull();
  });
});

describe('buildTemplateCsv', () => {
  it('produces a file the importer maps without complaint', () => {
    const parsed = parseCsv(buildTemplateCsv());
    const mapping = mapHeaders(parsed.headers);

    expect(mapping.unknown).toEqual([]);
    expect(mapping.missingRequired).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
  });
});
