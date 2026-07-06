import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from './csv.mjs';

describe('toCsv', () => {
  it('joins plain fields with commas and rows with CRLF', () => {
    const csv = toCsv([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    assert.equal(csv, 'a,b,c\r\n1,2,3');
  });

  it('quotes a field containing a comma', () => {
    const csv = toCsv([['Acme, Inc.', 'ok']]);
    assert.equal(csv, '"Acme, Inc.",ok');
  });

  it('quotes a field containing a double quote and doubles it', () => {
    const csv = toCsv([['Say "hi"', 'ok']]);
    assert.equal(csv, '"Say ""hi""",ok');
  });

  it('quotes a field containing a newline', () => {
    const csv = toCsv([['line one\nline two', 'ok']]);
    assert.equal(csv, '"line one\nline two",ok');
  });

  it('treats null and undefined as empty fields', () => {
    const csv = toCsv([[null, undefined, 'x']]);
    assert.equal(csv, ',,x');
  });
});
