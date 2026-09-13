import { CsvParseError, parseCsv, toCsvField } from './csv';

describe('parseCsv', () => {
  it('reads headers and rows', () => {
    const parsed = parseCsv('first,last\nAda,Obi\nBola,Ade');
    expect(parsed.headers).toEqual(['first', 'last']);
    expect(parsed.rows.map((r) => r.values)).toEqual([
      ['Ada', 'Obi'],
      ['Bola', 'Ade'],
    ]);
  });

  it('strips the byte-order mark Excel writes', () => {
    const parsed = parseCsv('﻿first,last\nAda,Obi');
    expect(parsed.headers[0]).toBe('first');
  });

  it('handles CRLF and bare CR line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4').rows).toHaveLength(2);
    expect(parseCsv('a,b\r1,2\r3,4').rows).toHaveLength(2);
  });

  it('keeps commas and escaped quotes inside quoted fields', () => {
    const parsed = parseCsv('name,address\nAda,"12, Ring Road ""Old"" Estate"');
    expect(parsed.rows[0].values[1]).toBe('12, Ring Road "Old" Estate');
  });

  it('keeps a line break inside a quoted field and still numbers lines', () => {
    const parsed = parseCsv('name,notes\nAda,"line one\nline two"\nBola,ok');
    expect(parsed.rows[0].values[1]).toBe('line one\nline two');
    // Bola sits on physical line 4 because Ada's note spans two.
    expect(parsed.rows[1].line).toBe(4);
  });

  it('reports the physical line of each row', () => {
    const parsed = parseCsv('a\n1\n\n2');
    expect(parsed.rows.map((r) => r.line)).toEqual([2, 4]);
  });

  it('skips blank lines and rows of bare commas', () => {
    const parsed = parseCsv('a,b\n1,2\n,,\n\n3,4\n\n');
    expect(parsed.rows.map((r) => r.values)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('keeps empty fields in position', () => {
    expect(parseCsv('a,b,c\n1,,3').rows[0].values).toEqual(['1', '', '3']);
  });

  it('trims header whitespace', () => {
    expect(parseCsv(' First Name , Surname \nAda,Obi').headers).toEqual([
      'First Name',
      'Surname',
    ]);
  });

  it('rejects an unclosed quote with its line', () => {
    expect(() => parseCsv('a\n"never closed')).toThrow(CsvParseError);
    expect(() => parseCsv('a\n"never closed')).toThrow(/^Line 2:/);
  });

  it('rejects a stray quote inside an unquoted field', () => {
    expect(() => parseCsv('a\nab"c')).toThrow(/quote may only open a field/);
  });

  it('rejects an empty file', () => {
    expect(() => parseCsv('\n\n')).toThrow(/empty/);
  });
});

describe('toCsvField', () => {
  it('leaves plain values alone', () => {
    expect(toCsvField('Ada')).toBe('Ada');
  });

  it('quotes values with commas and doubles their quotes', () => {
    expect(toCsvField('12, "Old" Road')).toBe('"12, ""Old"" Road"');
  });
});
