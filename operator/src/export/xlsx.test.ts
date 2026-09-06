import { describe, expect, it } from 'vitest'
import { guardFormulaInjection, type ExportColumn, type ExportRow } from './tables'
import { buildXlsxStream, colLetter, crc32, excelSerialDate } from './xlsx'

/** Tiny STORED-only ZIP reader, authoritative via the central directory (real crc/size even for the
 *  streaming worksheet entry, whose local header intentionally carries zeros - see xlsx.ts's doc
 *  comment on the data-descriptor convention). Verifies each entry's CRC-32 against what the central
 *  directory claims, so a bug in the writer's byte accounting fails here, not silently. */
function readStoredZip(buf: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocdOffset = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) throw new Error('end of central directory record not found')
  const count = view.getUint16(eocdOffset + 10, true)
  const cdOffset = view.getUint32(eocdOffset + 16, true)

  const files = new Map<string, Uint8Array>()
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    const sig = view.getUint32(p, true)
    if (sig !== 0x02014b50) throw new Error(`bad central directory signature at entry ${i}`)
    const crc = view.getUint32(p + 16, true)
    const compSize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localOffset = view.getUint32(p + 42, true)
    const name = new TextDecoder().decode(buf.slice(p + 46, p + 46 + nameLen))

    const localNameLen = view.getUint16(localOffset + 26, true)
    const localExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const data = buf.slice(dataStart, dataStart + compSize)
    expect(crc32(data)).toBe(crc)

    files.set(name, data)
    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}

const COLUMNS: ExportColumn[] = [
  { key: 'when', header: 'When', type: 'date' },
  { key: 'count', header: 'Count', type: 'number' },
  { key: 'name', header: 'Name', type: 'string' },
  { key: 'formula', header: 'Formula-ish', type: 'string' }
]

async function* batchesOf(rows: ExportRow[], size = 500): AsyncGenerator<ExportRow[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size)
}

async function collectXlsx(input: { columns: ExportColumn[]; batches: AsyncIterable<ExportRow[]>; sheetName?: string; now?: Date }): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of buildXlsxStream(input)) {
    chunks.push(chunk)
    total += chunk.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function decodeSheet(files: Map<string, Uint8Array>): string {
  const sheet = files.get('xl/worksheets/sheet1.xml')
  if (!sheet) throw new Error('sheet1.xml missing from zip')
  return new TextDecoder().decode(sheet)
}

describe('buildXlsxStream', () => {
  it('produces a ZIP whose central directory and local data agree (CRC-32 round trip)', async () => {
    const now = new Date('2026-09-06T14:00:00Z')
    const rows: ExportRow[] = [{ when: Date.UTC(2026, 8, 1), count: 42, name: 'Alice', formula: 'plain text' }]
    const buf = await collectXlsx({ columns: COLUMNS, batches: batchesOf(rows), now })
    const files = readStoredZip(buf)
    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/worksheets/sheet1.xml'
      ])
    )
  })

  it('header row carries every column label in order, bold-styled (s="1")', async () => {
    const buf = await collectXlsx({ columns: COLUMNS, batches: batchesOf([]) })
    const sheet = decodeSheet(readStoredZip(buf))
    const headerRow = /<row r="1">(.*?)<\/row>/.exec(sheet)![1]
    expect(headerRow).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">When</t></is></c>')
    expect(headerRow).toContain('>Count<')
    expect(headerRow).toContain('>Name<')
    expect(headerRow).toContain('>Formula-ish<')
  })

  it('freezes the header row via a pane element', async () => {
    const buf = await collectXlsx({ columns: COLUMNS, batches: batchesOf([]) })
    const sheet = decodeSheet(readStoredZip(buf))
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>')
  })

  it('declares an autoFilter over the full header-plus-data range, after sheetData', async () => {
    const rows: ExportRow[] = [
      { when: null, count: 1, name: 'a', formula: null },
      { when: null, count: 2, name: 'b', formula: null }
    ]
    const buf = await collectXlsx({ columns: COLUMNS, batches: batchesOf(rows) })
    const sheet = decodeSheet(readStoredZip(buf))
    expect(sheet.indexOf('</sheetData>')).toBeLessThan(sheet.indexOf('<autoFilter'))
    expect(sheet).toContain('<autoFilter ref="A1:D3"/>') // header + 2 data rows = row 3 last
  })

  it('writes a date cell as an Excel serial number with the date style (s="2")', async () => {
    const ms = Date.UTC(2026, 8, 6, 0, 0, 0)
    const rows: ExportRow[] = [{ when: ms, count: 1, name: 'x', formula: null }]
    const buf = await collectXlsx({ columns: COLUMNS, batches: batchesOf(rows) })
    const sheet = decodeSheet(readStoredZip(buf))
    const dataRow = /<row r="2">(.*?)<\/row>/.exec(sheet)![1]
    const cellMatch = /<c r="A2" s="2"><v>([\d.]+)<\/v><\/c>/.exec(dataRow)
    expect(cellMatch).toBeTruthy()
    expect(Number(cellMatch![1])).toBeCloseTo(excelSerialDate(ms), 5)
  })

  it('writes a number cell as a plain numeric <v>, no inline string wrapper', async () => {
    const rows: ExportRow[] = [{ when: null, count: 42, name: 'x', formula: null }]
    const buf = await collectXlsx({ columns: COLUMNS, batches: batchesOf(rows) })
    const sheet = decodeSheet(readStoredZip(buf))
    const dataRow = /<row r="2">(.*?)<\/row>/.exec(sheet)![1]
    expect(dataRow).toContain('<c r="B2"><v>42</v></c>')
  })

  it('guards a text cell that starts with =, +, - or @ with a leading single quote (formula injection)', async () => {
    const rows: ExportRow[] = [{ when: null, count: 1, name: '=SUM(A1:A9)', formula: '+cmd|/c calc' }]
    const buf = await collectXlsx({ columns: COLUMNS, batches: batchesOf(rows) })
    const sheet = decodeSheet(readStoredZip(buf))
    const dataRow = /<row r="2">(.*?)<\/row>/.exec(sheet)![1]
    expect(dataRow).toContain("<t xml:space=\"preserve\">'=SUM(A1:A9)</t>")
    expect(dataRow).toContain("<t xml:space=\"preserve\">'+cmd|/c calc</t>")
    expect(guardFormulaInjection('@import')).toBe("'@import")
    expect(guardFormulaInjection('safe text')).toBe('safe text')
  })

  it('guards a tab-prefixed or CR-prefixed formula in the worksheet XML (security review)', async () => {
    const rows: ExportRow[] = [{ when: null, count: 1, name: '\t=1+1', formula: '\r=1+1' }]
    const buf = await collectXlsx({ columns: COLUMNS, batches: batchesOf(rows) })
    const sheet = decodeSheet(readStoredZip(buf))
    // [\s\S] rather than `.` so the match spans the embedded \t/\r themselves (JS `.` excludes line
    // terminators, which would otherwise truncate the match right at the character under test).
    const dataRow = /<row r="2">([\s\S]*?)<\/row>/.exec(sheet)![1]
    expect(dataRow).toContain('<t xml:space="preserve">\'\t=1+1</t>')
    expect(dataRow).toContain('<t xml:space="preserve">\'\r=1+1</t>')
  })

  it('colLetter counts A..Z then AA', () => {
    expect(colLetter(0)).toBe('A')
    expect(colLetter(25)).toBe('Z')
    expect(colLetter(26)).toBe('AA')
  })

  it('a 20000-row export completes and produces the expected row count', async () => {
    const rows: ExportRow[] = Array.from({ length: 20_000 }, (_, i) => ({
      when: Date.UTC(2026, 0, 1) + i * 1000,
      count: i,
      name: `row-${i}`,
      formula: null
    }))
    const started = Date.now()
    const buf = await collectXlsx({ columns: COLUMNS, batches: batchesOf(rows, 1000) })
    const elapsedMs = Date.now() - started
    const sheet = decodeSheet(readStoredZip(buf))
    const rowMatches = sheet.match(/<row r="\d+">/g) ?? []
    expect(rowMatches).toHaveLength(20_001) // header + 20000 data rows
    expect(sheet).toContain('<autoFilter ref="A1:D20001"/>')
    expect(elapsedMs).toBeLessThan(10_000)
  })
})
