import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXCERPT_FILES, STALLS_FILE, excerptOf, excerptRows, stallBundleNames, writeAttributionBundle } from './attribution-bundle.mjs'

const BOOT = '0f8fad5b-d9cb-469f-a165-70867728950e'
const jsonl = (rows: object[]): string => rows.map((row) => `${JSON.stringify(row)}\n`).join('')
const mainThreadSample = `Sampling process 4242 for 10 seconds with 1 millisecond of run time between samples
Call graph:
    2500 Thread_12345   DispatchQueue_1: com.apple.main-thread  (serial)
    + 2500 start  (in dyld) + 1904
    + ! 2499 main  (in /Applications/Metis.app/Contents/MacOS/Metis) + 12
    + ! : 2498 -[NSApplication run]  (in AppKit) + 512
    240 Thread_67890
    + 240 worker_secret  (in SecretRenderer) + 1
`

describe('M2-0194 attribution excerpts', () => {
  it('assigns each attribution event to exactly one excerpt and ignores the rest', () => {
    expect(excerptOf('app.stall')).toBe('stall')
    expect(excerptOf('app.stall.summary')).toBeNull()
    expect(excerptOf('app.stall.sampled')).toBe('sampler')
    expect(excerptOf('app.stall.sample_failed')).toBeNull()
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
          { event: 'app.stall.sampled', ts: '2026-10-02T12:00:01.010Z', bootId: BOOT, stalledMs: 31000, bundle: name },
          { event: 'reveal', reason: 'activate', outcome: 'shown' },
          { event: 'sidecar.spawn', name: 'asr', pid: 7 },
          { event: 'app.stall', ts: '2026-10-02T12:00:01.000Z', durationMs: 31000 }
        ])
      )
      mkdirSync(join(out, 'samples'), { recursive: true })
      writeFileSync(join(out, 'samples', 'row-1-history-open-main.sample.txt'), mainThreadSample)
      writeFileSync(join(out, 'sample-index.jsonl'), jsonl([
        { row: 'row-1-history-open', role: 'main', capturedMs: Date.parse('2026-10-02T12:00:01.009Z'), file: 'samples/row-1-history-open-main.sample.txt' }
      ]))
      writeFileSync(join(out, 'matrix.jsonl'), jsonl([
        {
          row: 'row-1-history-open',
          operator_result: 'pass',
          automatic: true,
          row_started_ms: Date.parse('2026-10-02T12:00:00.000Z'),
          row_finished_ms: Date.parse('2026-10-02T12:00:02.000Z')
        }
      ]))
      writeAttributionBundle({ profiles: [profile], out })
      const read = (file: string): string => readFileSync(join(out, file), 'utf8')
      expect(read(EXCERPT_FILES.sampler)).toContain('app.stall.sampled')
      expect(read(EXCERPT_FILES.sampler)).not.toContain('bootId')
      expect(read(EXCERPT_FILES.sampler)).not.toContain(name)
      expect(read(EXCERPT_FILES.sampler)).toContain(`"tMs":${Date.parse('2026-10-02T12:00:01.010Z')}`)
      expect(read(EXCERPT_FILES.reveal)).toContain('"outcome":"shown"')
      expect(read(EXCERPT_FILES.sidecar)).toContain('sidecar.spawn')
      expect(read(EXCERPT_FILES.stall)).toContain('app.stall')
      expect(read(EXCERPT_FILES.stall)).toContain('"stalledMs":31000')
      expect(read(STALLS_FILE)).toContain('"frames":[{"symbol":"start","image":"dyld"},{"symbol":"main","image":"Metis"},{"symbol":"-[NSApplication run]","image":"AppKit"}]')
      expect(read(STALLS_FILE)).not.toContain('worker_secret')
      expect(read(STALLS_FILE)).not.toContain('SecretRenderer')
      expect(read(STALLS_FILE)).toContain('"row":"row-1-history-open"')
      expect(JSON.parse(read('stall-bundle-names.json'))).toEqual({ names: [name] })
      expect(read('stall-bundle-names.json')).not.toContain('secret-frame')
    } finally {
      rmSync(profile, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('records Windows hosted-live stall sampling as not applicable instead of a failure', () => {
    const profile = mkdtempSync(join(tmpdir(), 'attribution-windows-profile-'))
    const out = mkdtempSync(join(tmpdir(), 'attribution-windows-out-'))
    try {
      mkdirSync(join(profile, 'logs'))
      writeFileSync(join(profile, 'logs', 'audit.log'), jsonl([
        { event: 'app.stall', ts: '2026-10-02T12:00:01.000Z', durationMs: 31000 }
      ]))
      writeFileSync(join(out, 'matrix.jsonl'), jsonl([
        {
          row: 'row-1-history-open',
          operator_result: 'pass',
          automatic: true,
          row_started_ms: Date.parse('2026-10-02T12:00:00.000Z'),
          row_finished_ms: Date.parse('2026-10-02T12:00:02.000Z')
        }
      ]))
      writeAttributionBundle({ profiles: [profile], out, host: 'windows-latest' })
      const stalls = readFileSync(join(out, STALLS_FILE), 'utf8')
      expect(stalls).toContain('"status":"NOT_APPLICABLE"')
      expect(stalls).toContain('/usr/bin/sample is macOS-only')
      expect(stalls).not.toContain('"status":"FAIL"')
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
      expect(readFileSync(join(out, STALLS_FILE), 'utf8')).toBe('')
      expect(JSON.parse(readFileSync(join(out, 'stall-bundle-names.json'), 'utf8'))).toEqual({ names: [] })
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
