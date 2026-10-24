import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createDataExport,
  DATA_EXPORT_KIND,
  type DataExportDeps,
  type ExportDirectoryRequest,
  type ExportOutcome
} from './data-export'

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

function build(over: Partial<DataExportDeps> = {}) {
  const requests: ExportDirectoryRequest[] = []
  const readMeeting = vi.fn(async (file: string) =>
    file.startsWith('cloud')
      ? ({ status: 'not-downloaded' } as const)
      : ({ status: 'ok', markdown: `# synthetic ${file}\n`, modifiedAt: 5, origin: 'meeting-capture' } as const)
  )
  const deps: DataExportDeps = {
    listMeetingFiles: async () => ['2026-10-24_100000-a.md', 'cloud-only.md'],
    readMeeting,
    extraRecords: async () => [
      {
        store: 'assistants',
        name: 'a',
        sourceId: 'src1',
        origin: 'user-typed',
        modifiedAt: 7,
        text: '{"name":"Coach"}'
      },
      {
        store: 'brain',
        name: 'b',
        sourceId: 'src2',
        origin: 'derived',
        derivedFrom: ['src1'],
        modifiedAt: 8,
        text: '{"summary":"synthetic"}'
      }
    ],
    exportDirectory: async (request): Promise<ExportOutcome> => {
      requests.push(request)
      return { ok: true }
    },
    now: () => new Date(Date.UTC(2026, 9, 24)),
    appVersion: () => '0.0.0-test',
    ...over
  }
  return { deps, requests, readMeeting }
}

const manifestOf = (request: ExportDirectoryRequest) =>
  JSON.parse(request.entries.find((e) => e.name === 'manifest.json')!.bytes.toString('utf8')) as {
    records: Array<{
      store: string
      name: string
      sourceId: string
      origin: string
      derivedFrom?: string[]
      sha256: string
      bytes: number
    }>
    skipped: Array<{ store: string; sourceId?: string; reason: string }>
    exportedAt: string
    appVersion: string
  }

describe('data export (G82)', () => {
  it('manifest sha256 matches bytes', async () => {
    const { deps, requests } = build()
    expect(await createDataExport(deps)()).toEqual({ ok: true, records: 3, skipped: 1 })
    const request = requests[0]!
    const manifest = manifestOf(request)
    for (const record of manifest.records) {
      const entry = request.entries.find((e) => e.name === record.name)!
      expect(record.sha256).toBe(sha(entry.bytes))
      expect(record.bytes).toBe(entry.bytes.byteLength)
    }
    expect(manifest.appVersion).toBe('0.0.0-test')
    expect(manifest.exportedAt).toBe('2026-10-24T00:00:00.000Z')
  })

  it('derived records name derivedFrom', async () => {
    const { deps, requests } = build()
    await createDataExport(deps)()
    const manifest = manifestOf(requests[0]!)
    expect(manifest.records.find((r) => r.store === 'brain')).toMatchObject({
      origin: 'derived',
      derivedFrom: ['src1']
    })
    expect(manifest.records.find((r) => r.store === 'assistants')?.derivedFrom).toBeUndefined()
  })

  it('cloud-only meeting skipped, not hydrated, and names never leak into the bundle', async () => {
    const { deps, requests, readMeeting } = build()
    await createDataExport(deps)()
    const manifest = manifestOf(requests[0]!)
    expect(manifest.skipped).toEqual([expect.objectContaining({ store: 'meetings', reason: 'not-downloaded' })])
    expect(requests[0]!.entries.some((e) => e.bytes.toString().includes('cloud-only'))).toBe(false)
    expect(JSON.stringify(manifest)).not.toMatch(/cloud-only|planning|2026-10-24_100000/)
    expect(readMeeting).toHaveBeenCalledTimes(2) // a read each; the dependency is the non-hydrating reader
  })

  it('uses exportDirectory with kind data-rights-bundle', async () => {
    const { deps, requests } = build()
    await createDataExport(deps)()
    expect(requests[0]!.kind).toBe(DATA_EXPORT_KIND)
    expect(DATA_EXPORT_KIND).toBe('data-rights-bundle')
  })

  it('a cancelled save dialog writes nothing and a failed export is a content-free refusal', async () => {
    const cancelled = build({ exportDirectory: async () => ({ ok: false, cancelled: true }) })
    expect(await createDataExport(cancelled.deps)()).toEqual({ ok: true, cancelled: true, records: 0, skipped: 0 })
    const failed = build({ exportDirectory: async () => ({ ok: false, error: '/Users/someone/x failed' }) })
    expect(await createDataExport(failed.deps)()).toEqual({ ok: false, reason: 'unavailable' })
  })
})
