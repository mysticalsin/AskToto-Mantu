import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDataExport } from '../features/data-rights/data-export'
import { createExportService } from '../features/export/export-service'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('data export through the G58 export service (G82)', () => {
  it('receipt logged: the bundle, its manifest and a receipt of kind data-rights-bundle land on disk', async () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-export-')))
    dirs.push(out)
    const receiptLog = join(out, 'receipts.jsonl')
    const service = createExportService({
      showSaveDialog: async () => ({ canceled: false, filePath: join(out, 'bundle') }),
      showMessageBox: async () => ({ response: 0 }),
      receiptLogPath: () => receiptLog,
      platform: 'darwin'
    })
    const run = createDataExport({
      listMeetingFiles: async () => ['2026-10-24_100000-a.md'],
      readMeeting: async () => ({ status: 'ok', markdown: '# synthetic\n', modifiedAt: 1, origin: 'meeting-capture' }),
      extraRecords: async () => [],
      exportDirectory: (request) => service.exportDirectory(request),
      now: () => new Date(Date.UTC(2026, 9, 24)),
      appVersion: () => '0.0.0-test'
    })
    expect(await run()).toEqual({ ok: true, records: 1, skipped: 0 })
    expect(readdirSync(join(out, 'bundle')).sort()).toEqual(['manifest.json', 'meeting-0001.md'])
    const logged = readFileSync(receiptLog, 'utf8')
    expect(logged).toContain('data-rights-bundle')
    expect(logged).not.toContain('# synthetic') // the receipt never carries a record's text
  })
})
