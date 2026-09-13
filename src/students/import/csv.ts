/**
 * A small RFC 4180 CSV reader, written rather than imported because the rules
 * are short and the edge cases that matter are specific to how schools make
 * these files — in Excel, exported "CSV UTF-8":
 *
 *   - a UTF-8 byte-order mark before the first header,
 *   - CRLF line endings (and the odd bare CR from older Macs),
 *   - quoted fields holding commas, quotes ("") and even line breaks,
 *   - trailing blank lines, and rows of nothing but commas.
 */
export interface ParsedCsv {
  headers: string[];
  /** Data rows only, each paired with its 1-based line number in the file. */
  rows: { line: number; values: string[] }[];
}

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`Line ${line}: ${message}`);
    this.name = 'CsvParseError';
  }
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const records: { line: number; values: string[] }[] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let fieldStarted = false;

  const endField = () => {
    record.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, values: record });
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line++;
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (fieldStarted && field.trim() !== '') {
        throw new CsvParseError(
          'a quote may only open a field, not appear inside an unquoted one',
          line,
        );
      }
      field = '';
      inQuotes = true;
      fieldStarted = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += char;
      fieldStarted = true;
    }
  }

  if (inQuotes) {
    throw new CsvParseError('a quoted field is never closed', recordLine);
  }
  if (field !== '' || record.length > 0) {
    endRecord();
  }

  const meaningful = records.filter((r) =>
    r.values.some((value) => value.trim() !== ''),
  );
  if (meaningful.length === 0) {
    throw new CsvParseError('the file is empty', 1);
  }

  const [header, ...rows] = meaningful;
  return {
    headers: header.values.map((value) => value.trim()),
    rows,
  };
}

/** Quotes a value only when it needs it, for writing a template. */
export function toCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
