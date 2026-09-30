import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXCERPT_FILES, excerptOf, excerptRows, stallBundleNames, writeAttributionBundle } from './attribution-bundle.mjs'

const BOOT = '0f8fad5b-d9cb-469f-a165-70867728950e'
const jsonl = (rows: object[]): string => rows.map((row) => `${JSON.stringify(row)}\n`).join('')

describe('M2-0194 attribution excerpts', () => {
  it('assigns each attribution event to exactly one excerpt and ignores the rest', () => {
    expect(excerptOf('app.stall')).toBe('stall')
    expect(excerptOf('app.stall.summary')).toBe('stall')
    expect(excerptOf('app.stall.sampled')).toBe('sampler')
    expect(excerptOf('app.stall.sample_failed')).toBe('sampler')
    expect(excerptOf('reveal')).toBe('reveal')
    expect(excerptOf('sidecar.spawn')).toBe('sidecar')
    expect(excerptOf('sidecar.reaped')).toBe('sidecar')
    expect(excerptOf('app.started')).toBeNull()
    expect(excerptOf(undefined)).toBeNull()
  })

  it('groups audit rows by excerpt and skips lines that are not JSON', () => {
    const text = `${jsonl([{ event: 'reveal', outcome: 'shown' }, { event: 'app.started' }, { event: 'sidecar.exit', name: 'asr' }])}not json\n`
    const rows = excerptRows(text)
    expect(rows.reveal).toEqual([{ event: 'reveal', outcome: 'shown' }])
    expect(rows.sidecar).toEqual([{ event: 'sidecar.exit', name: 'asr' }])
    expect(rows.stall).toEqual([])
    expect(rows.sampler).toEqual([])
  })

  it('lists only well-formed stall bundle names', () => {
    const good = `${BOOT}.1700000000000.31000.txt`
    expect(stallBundleNames([`${BOOT}.1.2.sample`, 'notes.txt', good, `a/b.${BOOT}.1.2.txt`])).toEqual([good])
  })

  it('writes the four excerpts and the bundle names, never the bundle contents', () => {
    const profile = mkdtempSync(join(tmpdir(), 'attribution-profile-'))
    const out = mkdtempSync(join(tmpdir(), 'attribution-out-'))
    try {
      mkdirSync(join(profile, 'logs'))
      mkdirSync(join(profile, 'diagnostics', 'stalls'), { recursive: true })
      const name = `${BOOT}.1700000000000.31000.txt`
      writeFileSync(join(profile, 'diagnostics', 'stalls', name), 'Thread 1 (main)\n secret-frame\n')
      writeFileSync(
        join(profile, 'logs', 'audit.log'),
        jsonl([
          { event: 'app.stall.sampled', bootId: BOOT, stalledMs: 31000, bundle: name },
          { event: 'reveal', reason: 'activate', outcome: 'shown' },
          { event: 'sidecar.spawn', name: 'asr', pid: 7 },
          { event: 'app.stall.summary', count: 1 }
        ])
      )
      writeAttributionBundle({ profiles: [profile], out })
      const read = (file: string): string => readFileSync(join(out, file), 'utf8')
      expect(read(EXCERPT_FILES.sampler)).toContain('app.stall.sampled')
      expect(read(EXCERPT_FILES.reveal)).toContain('"outcome":"shown"')
      expect(read(EXCERPT_FILES.sidecar)).toContain('sidecar.spawn')
      expect(read(EXCERPT_FILES.stall)).toContain('app.stall.summary')
      expect(JSON.parse(read('stall-bundle-names.json'))).toEqual({ names: [name] })
      expect(read('stall-bundle-names.json')).not.toContain('secret-frame')
    } finally {
      rmSync(profile, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('writes empty excerpts and no names for a profile that never ran', () => {
    const out = mkdtempSync(join(tmpdir(), 'attribution-empty-'))
    try {
      writeAttributionBundle({ profiles: [join(out, 'missing')], out })
      for (const file of Object.values(EXCERPT_FILES)) expect(readFileSync(join(out, file), 'utf8')).toBe('')
      expect(JSON.parse(readFileSync(join(out, 'stall-bundle-names.json'), 'utf8'))).toEqual({ names: [] })
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
