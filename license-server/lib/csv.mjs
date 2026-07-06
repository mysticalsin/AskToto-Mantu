// Minimal RFC4180 CSV encoder.
//
// A field is quoted only when it contains a comma, a double quote, or a
// newline; embedded quotes are doubled per the spec. Rows are joined with
// CRLF (the RFC4180 line ending).
function csvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(rows) {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}
