import { describe, expect, it } from 'vitest'
import type { ExportColumn, ExportRow } from './tables'
import { CSV_BOM, csvField, csvLine, csvRows, guardFormulaInjection } from './csv'

const COLUMNS: ExportColumn[] = [
  { key: 'when', header: 'When', type: 'date' },
  { key: 'count', header: 'Count', type: 'number' },
  { key: 'name', header: 'Name', type: 'string' }
]

async function* batchesOf(rows: ExportRow[]): AsyncGenerator<ExportRow[]> {
  yield rows
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const chunk of gen) out += chunk
  return out
}

describe('guardFormulaInjection', () => {
  it('prefixes a leading =, +, - or @ with a single quote', () => {
    expect(guardFormulaInjection('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(guardFormulaInjection('+1')).toBe("'+1")
    expect(guardFormulaInjection('-1')).toBe("'-1")
    expect(guardFormulaInjection('@cmd')).toBe("'@cmd")
  })
  it('leaves an ordinary value alone', () => {
    expect(guardFormulaInjection('Alice')).toBe('Alice')
  })
})

describe('csvField', () => {
  it('quotes a field containing a comma, quote or newline, doubling internal quotes', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('a"b')).toBe('"a""b"')
    expect(csvField('a\nb')).toBe('"a\nb"')
  })
  it('applies the formula guard before quoting', () => {
    expect(csvField('=1,2')).toBe('"\'=1,2"')
  })
})

describe('csvLine', () => {
  it('joins fields with commas and ends with CRLF', () => {
    expect(csvLine(['a', 'b'])).toBe('a,b\r\n')
  })
})

describe('csvRows', () => {
  it('starts with the UTF-8 BOM, then the header row, then one CRLF-terminated row per input row', async () => {
    const rows: ExportRow[] = [{ when: Date.UTC(2026, 8, 6, 12, 0, 0), count: 3, name: 'Alice' }]
    const out = await collect(csvRows(COLUMNS, batchesOf(rows)))
    expect(out.startsWith(CSV_BOM)).toBe(true)
    expect(out).toContain('When,Count,Name\r\n')
    expect(out).toContain('2026-09-06T12:00:00.000Z,3,Alice\r\n')
  })

  it('formats a null cell as empty, and a date as ISO 8601', () => {
    return collect(csvRows(COLUMNS, batchesOf([{ when: null, count: 0, name: null }]))).then((out) => {
      expect(out).toContain(',0,\r\n')
    })
  })

  it('guards a formula-shaped name against injection', async () => {
    const out = await collect(csvRows(COLUMNS, batchesOf([{ when: null, count: 1, name: '=cmd|/c calc' }])))
    expect(out).toContain("'=cmd|/c calc")
  })

  it('streams across multiple batches without dropping or reordering rows', async () => {
    async function* twoBatches(): AsyncGenerator<ExportRow[]> {
      yield [{ when: null, count: 1, name: 'a' }]
      yield [{ when: null, count: 2, name: 'b' }]
    }
    const out = await collect(csvRows(COLUMNS, twoBatches()))
    const lines = out.split('\r\n').filter(Boolean)
    expect(lines).toHaveLength(3) // header + 2 rows
    expect(lines[1]).toContain(',1,a')
    expect(lines[2]).toContain(',2,b')
  })
})
