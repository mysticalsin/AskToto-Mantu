/**
 * Minimal OOXML (.xlsx) writer, no dependency (task B10, plan D11): a workbook with one worksheet,
 * built from `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`,
 * `xl/styles.xml` (bold header row, a date number format) and `xl/worksheets/sheet1.xml` (inline
 * strings, numbers as numbers, dates as serial numbers with the date style, frozen header row,
 * autoFilter on the header range, column widths from the header labels), packaged as a ZIP with
 * STORED (uncompressed) entries - local file headers, a central directory, an end-of-central-directory
 * record, CRC-32 computed in JS. No `node:zlib`, no npm package.
 *
 * The worksheet entry is written with the ZIP "data descriptor" streaming convention (general purpose
 * bit 3): its local header carries a zero crc/size, the real values follow the file data in a trailing
 * 16-byte descriptor, and the central directory (built once every row has been seen) carries the real
 * values too - the standard way a ZIP writer emits an entry whose length is not known in advance. This
 * is what keeps the writer building from the row batches as they arrive rather than buffering the
 * whole sheet to compute a size upfront, so memory stays flat across a large export. `dimension` is
 * omitted (optional in the schema; Excel recomputes the used range regardless) for the same reason -
 * it would need the final row count before `<sheetData>` opens. `autoFilter` does not have that
 * problem: it is declared AFTER `<sheetData>` in the OOXML schema, so it can safely use the row count
 * this writer only knows once the last batch has been seen.
 */
import type { ExportColumn, ExportRow } from './tables'

// ---------------------------------------------------------------------------
// CRC-32 (public domain algorithm, table-based).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function createCrc32(): { update(bytes: Uint8Array): void; digest(): number } {
  let crc = 0xffffffff
  return {
    update(bytes: Uint8Array) {
      for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
    },
    digest(): number {
      return (crc ^ 0xffffffff) >>> 0
    }
  }
}

export function crc32(bytes: Uint8Array): number {
  const c = createCrc32()
  c.update(bytes)
  return c.digest()
}

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

/** Same convention as `csv.ts`'s formula guard: a leading `=`, `+`, `-` or `@` is prefixed with a
 *  single quote so a spreadsheet never evaluates an untrusted string as a formula. */
export function guardFormulaInjection(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value
}

/** XML 1.0 forbids most C0 control characters outright (a stray one in a cell would produce a file
 *  Excel refuses to open); strip them before escaping the three characters that are always special. */
function xmlEscapeText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  return stripped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 0-based column index to a spreadsheet column letter: 0 -> A, 25 -> Z, 26 -> AA. */
export function colLetter(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Days since the Excel/Lotus epoch (1899-12-30) for a UTC millisecond timestamp. 25569 is the
 *  number of days between that epoch and the Unix epoch (1970-01-01); the 1900 leap-year bug only
 *  affects dates before March 1900, never reached by real Operator data. */
export function excelSerialDate(ms: number): number {
  return ms / 86_400_000 + 25569
}

function columnWidth(header: string): number {
  return Math.min(40, Math.max(10, header.length + 4))
}

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:\\/?*]/g, ' ').trim()
  return (cleaned || 'Sheet1').slice(0, 31)
}

// ---------------------------------------------------------------------------
// Fixed-content XML parts.
// ---------------------------------------------------------------------------

function contentTypesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>'
  )
}

function packageRelsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'
  )
}

function workbookXml(sheetName: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEscapeText(sanitizeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  )
}

function workbookRelsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>'
  )
}

/** Style index 0: default. 1: bold header. 2: date (numFmtId 164, `yyyy-mm-dd hh:mm:ss`). */
function stylesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  )
}

const HEADER_STYLE = 1
const DATE_STYLE = 2

function stringCell(ref: string, text: string, styleIndex = 0): string {
  const guarded = guardFormulaInjection(text)
  const escaped = xmlEscapeText(guarded)
  const styleAttr = styleIndex ? ` s="${styleIndex}"` : ''
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escaped}</t></is></c>`
}

function numberCell(ref: string, value: number): string {
  return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}"/>`
}

function dateCell(ref: string, ms: number): string {
  return Number.isFinite(ms) ? `<c r="${ref}" s="${DATE_STYLE}"><v>${excelSerialDate(ms)}</v></c>` : `<c r="${ref}"/>`
}

function cellFor(ref: string, value: ExportRow[string], type: ExportColumn['type']): string {
  if (value == null) return `<c r="${ref}"/>`
  if (type === 'number') return numberCell(ref, Number(value))
  if (type === 'date') return dateCell(ref, typeof value === 'number' ? value : Number(value))
  return stringCell(ref, String(value))
}

/** The worksheet body, as a stream of XML string chunks. Row numbers start at 2 (row 1 is the
 *  header); `<autoFilter>` is only emitted once every batch has been consumed, since it needs the
 *  final row count and the OOXML schema allows it after `<sheetData>`. */
export async function* sheetXmlChunks(columns: ExportColumn[], batches: AsyncIterable<ExportRow[]>): AsyncGenerator<string> {
  yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  yield '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  yield '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
    '</sheetView></sheetViews>'
  yield '<sheetFormatPr defaultRowHeight="15"/>'
  yield `<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${columnWidth(c.header)}" customWidth="1"/>`).join('')}</cols>`
  yield '<sheetData>'
  yield `<row r="1">${columns.map((c, i) => stringCell(`${colLetter(i)}1`, c.header, HEADER_STYLE)).join('')}</row>`
  let rowNum = 1
  for await (const batch of batches) {
    for (const row of batch) {
      rowNum++
      const cells = columns.map((c, i) => cellFor(`${colLetter(i)}${rowNum}`, row[c.key], c.type)).join('')
      yield `<row r="${rowNum}">${cells}</row>`
    }
  }
  yield '</sheetData>'
  const lastCol = colLetter(Math.max(0, columns.length - 1))
  yield `<autoFilter ref="A1:${lastCol}${rowNum}"/>`
  yield '</worksheet>'
}

// ---------------------------------------------------------------------------
// ZIP container (STORED entries, CRC-32 in JS, no compression, no dependency).
// ---------------------------------------------------------------------------

interface ZipEntry {
  nameBytes: Uint8Array
  offset: number
  crc: number
  size: number
  dosTime: number
  dosDate: number
  streaming: boolean
}

function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const dosTime = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f)
  const dosDate = (((Math.max(1980, date.getFullYear()) - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f)
  return { dosTime, dosDate }
}

function localFileHeader(entry: Omit<ZipEntry, 'offset'>): Uint8Array {
  const buf = new Uint8Array(30 + entry.nameBytes.length)
  const view = new DataView(buf.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, entry.streaming ? 0x0008 : 0, true)
  view.setUint16(8, 0, true) // compression method: 0 = stored
  view.setUint16(10, entry.dosTime, true)
  view.setUint16(12, entry.dosDate, true)
  view.setUint32(14, entry.streaming ? 0 : entry.crc, true)
  view.setUint32(18, entry.streaming ? 0 : entry.size, true)
  view.setUint32(22, entry.streaming ? 0 : entry.size, true)
  view.setUint16(26, entry.nameBytes.length, true)
  view.setUint16(28, 0, true)
  buf.set(entry.nameBytes, 30)
  return buf
}

function dataDescriptor(crc: number, size: number): Uint8Array {
  const buf = new Uint8Array(16)
  const view = new DataView(buf.buffer)
  view.setUint32(0, 0x08074b50, true)
  view.setUint32(4, crc, true)
  view.setUint32(8, size, true)
  view.setUint32(12, size, true)
  return buf
}

function centralDirectoryHeader(entry: ZipEntry): Uint8Array {
  const buf = new Uint8Array(46 + entry.nameBytes.length)
  const view = new DataView(buf.buffer)
  view.setUint32(0, 0x02014b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 20, true)
  view.setUint16(8, entry.streaming ? 0x0008 : 0, true)
  view.setUint16(10, 0, true)
  view.setUint16(12, entry.dosTime, true)
  view.setUint16(14, entry.dosDate, true)
  view.setUint32(16, entry.crc, true)
  view.setUint32(20, entry.size, true)
  view.setUint32(24, entry.size, true)
  view.setUint16(28, entry.nameBytes.length, true)
  view.setUint16(30, 0, true)
  view.setUint16(32, 0, true)
  view.setUint16(34, 0, true)
  view.setUint16(36, 0, true)
  view.setUint32(38, 0, true)
  view.setUint32(42, entry.offset, true)
  buf.set(entry.nameBytes, 46)
  return buf
}

function endOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Uint8Array {
  const buf = new Uint8Array(22)
  const view = new DataView(buf.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(4, 0, true)
  view.setUint16(6, 0, true)
  view.setUint16(8, count, true)
  view.setUint16(10, count, true)
  view.setUint32(12, cdSize, true)
  view.setUint32(16, cdOffset, true)
  view.setUint16(20, 0, true)
  return buf
}

export interface XlsxSheetInput {
  columns: ExportColumn[]
  sheetName?: string
  batches: AsyncIterable<ExportRow[]>
  /** Fixed for deterministic tests; defaults to the current time. */
  now?: Date
}

/**
 * Builds the whole .xlsx file as a stream of byte chunks: five small, fully-buffered parts
 * ([Content_Types].xml, _rels/.rels, xl/workbook.xml, xl/_rels/workbook.xml.rels, xl/styles.xml),
 * then the worksheet written via the streaming (data-descriptor) convention from `sheetXmlChunks`,
 * then the central directory and end-of-central-directory record.
 */
export async function* buildXlsxStream({ columns, sheetName = 'Sheet1', batches, now = new Date() }: XlsxSheetInput): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  const { dosTime, dosDate } = dosDateTime(now)
  let offset = 0
  const entries: ZipEntry[] = []

  function recordAndHeader(name: string, content: Uint8Array): { header: Uint8Array } {
    const nameBytes = encoder.encode(name)
    const crc = crc32(content)
    const header = localFileHeader({ nameBytes, crc, size: content.length, dosTime, dosDate, streaming: false })
    entries.push({ nameBytes, offset, crc, size: content.length, dosTime, dosDate, streaming: false })
    offset += header.length
    return { header }
  }

  for (const [name, content] of [
    ['[Content_Types].xml', encoder.encode(contentTypesXml())],
    ['_rels/.rels', encoder.encode(packageRelsXml())],
    ['xl/workbook.xml', encoder.encode(workbookXml(sheetName))],
    ['xl/_rels/workbook.xml.rels', encoder.encode(workbookRelsXml())],
    ['xl/styles.xml', encoder.encode(stylesXml())]
  ] as [string, Uint8Array][]) {
    const { header } = recordAndHeader(name, content)
    yield header
    offset += content.length
    yield content
  }

  // Streaming worksheet entry: header written with zero crc/size (bit 3 set), real values follow in
  // a trailing data descriptor once every batch has been consumed.
  const sheetPath = 'xl/worksheets/sheet1.xml'
  const sheetNameBytes = encoder.encode(sheetPath)
  const sheetHeader = localFileHeader({ nameBytes: sheetNameBytes, crc: 0, size: 0, dosTime, dosDate, streaming: true })
  const sheetLocalOffset = offset
  offset += sheetHeader.length
  yield sheetHeader

  const crcState = createCrc32()
  let sheetSize = 0
  for await (const chunkStr of sheetXmlChunks(columns, batches)) {
    const bytes = encoder.encode(chunkStr)
    crcState.update(bytes)
    sheetSize += bytes.length
    offset += bytes.length
    yield bytes
  }
  const sheetCrc = crcState.digest()
  entries.push({ nameBytes: sheetNameBytes, offset: sheetLocalOffset, crc: sheetCrc, size: sheetSize, dosTime, dosDate, streaming: true })
  const descriptor = dataDescriptor(sheetCrc, sheetSize)
  offset += descriptor.length
  yield descriptor

  const cdStart = offset
  for (const entry of entries) {
    const cd = centralDirectoryHeader(entry)
    offset += cd.length
    yield cd
  }
  const cdSize = offset - cdStart
  yield endOfCentralDirectory(entries.length, cdSize, cdStart)
}
