import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MalformedInput, collectRows, loadBaseline, runComparator } from './smoke-baseline.mjs'

const BLOCKED = { status: 'BLOCKED_EXTERNAL', reason: 'Seed the packaged local model assets.', ticket: 'M2-0461' }

function baselineText(rows: Record<string, unknown>): string {
  return JSON.stringify({ schema: 1, seededFromRun: '1', platforms: { win32: { rows } } })
}

const smokeReport = (rv: Array<{ id: string; status: string; unblock?: string }>) => ({ schema: 1, rv, navigationGuard: [] })

describe('smoke-baseline comparator', () => {
  let dir: string
  const write = (name: string, body: unknown): void => {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  }
  const run = (rows: Record<string, unknown>) => runComparator({ dir, platform: 'win32', baselineText: baselineText(rows) })
  const errors = (result: { annotations: string[] }) => result.annotations.filter((line) => line.startsWith('::error'))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-baseline-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('fails a baseline PASS row that is now BLOCKED_EXTERNAL, naming row, statuses and unblock text', () => {
    write('packaged-smoke.json', smokeReport([{ id: 'RV-4-tray-show', status: 'BLOCKED_EXTERNAL', unblock: 'Open a session.' }]))
    const result = run({ 'packaged-smoke/RV-4-tray-show': { status: 'PASS' } })
    expect(result.exitCode).toBe(1)
    expect(errors(result)).toHaveLength(1)
    expect(errors(result)[0]).toContain('packaged-smoke/RV-4-tray-show')
    expect(errors(result)[0]).toContain('baseline PASS, current BLOCKED_EXTERNAL')
    expect(errors(result)[0]).toContain('Open a session.')
  })

  it('fails a baseline PASS row that is now NOT_RUN or still PENDING', () => {
    write('packaged-smoke.json', smokeReport([{ id: 'a', status: 'NOT_RUN' }, { id: 'b', status: 'PENDING' }]))
    const result = run({ 'packaged-smoke/a': { status: 'PASS' }, 'packaged-smoke/b': { status: 'PASS' } })
    expect(result.exitCode).toBe(1)
    expect(errors(result)).toHaveLength(2)
  })

  it('fails one error per baseline PASS row when a named report is missing', () => {
    const result = run({ 'sidecar-boot-reaper/standIn': { status: 'PASS' }, 'packaged-smoke/a': { status: 'PASS' } })
    expect(result.exitCode).toBe(1)
    expect(errors(result)).toHaveLength(2)
    expect(errors(result)[0]).toContain('current MISSING')
  })

  it('only warns for a BLOCKED_EXTERNAL baseline row that is still blocked', () => {
    write('sidecar-boot-reaper.json', {
      proofs: { standIn: { result: 'pass' }, realLlama: { result: 'BLOCKED_EXTERNAL', unblock: 'Seed the packaged local model assets.' } }
    })
    const result = run({ 'sidecar-boot-reaper/standIn': { status: 'PASS' }, 'sidecar-boot-reaper/realLlama': BLOCKED })
    expect(result.exitCode).toBe(0)
    expect(errors(result)).toHaveLength(0)
    expect(result.annotations.some((line) => line.startsWith('::warning') && line.includes('sidecar-boot-reaper/realLlama'))).toBe(true)
    expect(result.summary).toContain('| sidecar-boot-reaper/realLlama | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL |')
  })

  it('prints a promote notice when a BLOCKED_EXTERNAL baseline row now passes', () => {
    write('sidecar-boot-reaper.json', { proofs: { standIn: { result: 'pass' }, realLlama: { result: 'pass' } } })
    const result = run({ 'sidecar-boot-reaper/standIn': { status: 'PASS' }, 'sidecar-boot-reaper/realLlama': BLOCKED })
    expect(result.exitCode).toBe(0)
    expect(result.annotations.some((line) => line.startsWith('::notice') && line.includes('sidecar-boot-reaper/realLlama'))).toBe(true)
  })

  it('warns about a row absent from the baseline and leaves FAIL rows to the gate steps', () => {
    write('packaged-smoke.json', smokeReport([{ id: 'new-row', status: 'PASS' }, { id: 'a', status: 'FAIL' }]))
    const result = run({ 'packaged-smoke/a': { status: 'PASS' } })
    expect(result.exitCode).toBe(0)
    expect(result.annotations).toHaveLength(1)
    expect(result.annotations[0]).toMatch(/^::warning .*packaged-smoke\/new-row/)
  })

  it('ignores every unnamed file in the report directory', () => {
    write('packaged-smoke.json', smokeReport([{ id: 'a', status: 'PASS' }]))
    write('SHA256SUMS.txt', 'not json at all')
    write('tccutil-probe.json', '{ malformed')
    const result = run({ 'packaged-smoke/a': { status: 'PASS' } })
    expect(result.exitCode).toBe(0)
    expect(result.annotations).toEqual([])
  })

  it('takes the worst status across HK-M cycles of one scenario', () => {
    write('hk-m.json', {
      rows: [
        { scenario: 'idle', cycle: 1, status: 'PASS' },
        { scenario: 'idle', cycle: 2, status: 'BLOCKED_EXTERNAL', unblock: 'Confirm the ffmpeg sidecar.' }
      ]
    })
    expect(collectRows(dir, 'darwin').get('hk-m/idle')).toEqual({ status: 'BLOCKED_EXTERNAL', unblock: 'Confirm the ffmpeg sidecar.' })
  })

  it('exits 2 territory (MalformedInput) for a malformed named report or baseline', () => {
    write('packaged-smoke.json', '{ malformed')
    expect(() => run({ 'packaged-smoke/a': { status: 'PASS' } })).toThrow(MalformedInput)
    expect(() => runComparator({ dir, platform: 'win32', baselineText: '{ malformed' })).toThrow(MalformedInput)
  })

  it('rejects a BLOCKED_EXTERNAL baseline entry without a reason or a ticket id', () => {
    expect(() => loadBaseline(baselineText({ x: { status: 'BLOCKED_EXTERNAL', ticket: 'M2-0461' } }))).toThrow(MalformedInput)
    expect(() => loadBaseline(baselineText({ x: { status: 'BLOCKED_EXTERNAL', reason: 'why' } }))).toThrow(MalformedInput)
    expect(() => loadBaseline(baselineText({ x: { status: 'BLOCKED_EXTERNAL', reason: 'why', ticket: 'nope' } }))).toThrow(MalformedInput)
  })

  it('ships a valid checked-in baseline covering both platforms', () => {
    const baseline = loadBaseline(readFileSync(fileURLToPath(new URL('./smoke-baseline.json', import.meta.url)), 'utf8'))
    expect(baseline.seededFromRun).toBeTruthy()
    expect(Object.keys(baseline.platforms).sort()).toEqual(['darwin', 'win32'])
  })
})
