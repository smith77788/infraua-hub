import { parseCsv } from '../../core/ingestion/csv';
import { describe, expect, it } from 'bun:test';

describe('parseCsv', () => {
  it('parses a simple two-row CSV into records keyed by header', () => {
    const records = parseCsv('name,role\nJohn Doe,Director\nJane Roe,Analyst');
    expect(records).toEqual([
      { name: 'John Doe', role: 'Director' },
      { name: 'Jane Roe', role: 'Analyst' },
    ]);
  });

  it('handles a quoted field containing an embedded comma', () => {
    const records = parseCsv('name,role\n"Doe, John",Director');
    expect(records).toEqual([{ name: 'Doe, John', role: 'Director' }]);
  });

  it('un-escapes a doubled quote inside a quoted field', () => {
    const records = parseCsv('note\n"He said ""hello"""');
    expect(records).toEqual([{ note: 'He said "hello"' }]);
  });

  it('preserves an embedded literal newline inside a quoted field', () => {
    const records = parseCsv('name,note\nJohn,"line1\nline2"');
    expect(records).toEqual([{ name: 'John', note: 'line1\nline2' }]);
  });

  it('treats CRLF and LF line endings identically', () => {
    const lf = parseCsv('name,role\nJohn Doe,Director');
    const crlf = parseCsv('name,role\r\nJohn Doe,Director');
    expect(crlf).toEqual(lf);
  });

  it('ignores a trailing blank line at the end of the input', () => {
    const records = parseCsv('name,role\nJohn Doe,Director\n\n');
    expect(records).toEqual([{ name: 'John Doe', role: 'Director' }]);
  });

  it('returns [] for header-only input', () => {
    expect(parseCsv('name,role\n')).toEqual([]);
    expect(parseCsv('name,role')).toEqual([]);
  });

  it('pads a short row with empty strings for missing trailing columns', () => {
    const records = parseCsv('a,b,c\n1,2\n');
    expect(records).toEqual([{ a: '1', b: '2', c: '' }]);
  });
});
