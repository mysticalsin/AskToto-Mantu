// Minimal RFC4180 CSV encoder, with CSV-injection (formula-injection) neutralization.
//
// A field is quoted only when it contains a comma, a double quote, or a
// newline; embedded quotes are doubled per the spec. Rows are joined with
// CRLF (the RFC4180 line ending).
function csvField(value) {
  let str = value === null || value === undefined ? '' : String(value);
  // CSV-injection defense: Excel/Sheets/LibreOffice execute a cell whose value starts with = + - @
  // (or a tab/CR that can shift the parser onto one) as a FORMULA. An admin-writable field like a
  // company name of "=HYPERLINK(...)" would then run in the operator's spreadsheet. Prefix a single
  // quote so the cell is forced to plain text. (OWASP CSV-injection mitigation.)
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(rows) {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}
