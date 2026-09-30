import { describe, expect, it } from 'vitest'
import { CURSOR_LEAVE_GRACE_PX, CURSOR_REVEAL_DWELL_MS } from '../../../src/main/island/cursor-watch'
import {
  RIGHT_EDGE_DRAWER_WIDTH,
  RIGHT_EDGE_MARGIN_PX,
  RIGHT_EDGE_REVEAL_BAND_PX as GEOMETRY_BAND_PX
} from '../../../src/main/island/geometry'
import {
  CURSOR_WATCH_IDLE_INTERVAL_MS as THROTTLE_IDLE_INTERVAL_MS,
  CURSOR_WATCH_NEAR_PX
} from '../../../src/main/island/idle-throttle'
import { parkedIdleBlockedReport, stripSecretEnv, validatePointerAwayForState } from './lib.mjs'
import {
  DARWIN_POINTER_DRIVER,
  WIN32_POINTER_DRIVER,
  movePointer,
  parsePoint,
  parsePointerDriverOutput,
  pointerDriverArgs,
  pointerDriverCommand,
  stationaryMove
} from './pointer.mjs'
import { representativeSettings } from './profile.mjs'
import {
  APPROACH_SERIES,
  APPROACH_START_OFFSET_PX,
  CURSOR_WATCH_IDLE_INTERVAL_MS,
  REVEAL_LATENCY_P95_MAX_MS,
  RIGHT_EDGE_REVEAL_BAND_PX,
  RIGHT_EDGE_REVEAL_DWELL_MS,
  approachPlan,
  isParkedBounds,
  percentile,
  readRevealLatencyArgs,
  revealLatencyBlockedReport,
  revealLatencyExitCode,
  revealLatencyFailedReport,
  revealLatencyGate,
  revealLatencyReport,
  summarizeRevealSeries,
  validateRevealProfile
} from './reveal-latency-lib.mjs'

const macParked = { x: 1916, y: 240, width: 4, height: 600 }
// Windows widens the 4 px frameless park to 32 px, right-anchored.
const winParked = { x: 1888, y: 240, width: 32, height: 600 }

describe('reveal latency constants mirror the app (ADR-018)', () => {
  it('uses the shipped dwell, band and idle cadence', () => {
    expect(RIGHT_EDGE_REVEAL_DWELL_MS).toBe(CURSOR_REVEAL_DWELL_MS)
    expect(RIGHT_EDGE_REVEAL_BAND_PX).toBe(GEOMETRY_BAND_PX)
    expect(CURSOR_WATCH_IDLE_INTERVAL_MS).toBe(THROTTLE_IDLE_INTERVAL_MS)
    expect(REVEAL_LATENCY_P95_MAX_MS).toBe(150)
  })

  it('starts every approach at rest outside the fast-polling margin and outside the revealed drawer', () => {
    expect(APPROACH_START_OFFSET_PX).toBeGreaterThan(CURSOR_WATCH_NEAR_PX + RIGHT_EDGE_REVEAL_BAND_PX)
    // The rest point must let the revealed drawer see a leave and re-park between trials.
    expect(APPROACH_START_OFFSET_PX).toBeGreaterThan(RIGHT_EDGE_DRAWER_WIDTH + RIGHT_EDGE_MARGIN_PX + CURSOR_LEAVE_GRACE_PX)
  })

  it('gates on the design approach speed and records a faster fling without gating on it', () => {
    const gated = APPROACH_SERIES.filter((row) => row.gated)
    expect(gated).toHaveLength(1)
    expect(gated[0].speedPxPerMs).toBeLessThanOrEqual(CURSOR_WATCH_NEAR_PX / CURSOR_WATCH_IDLE_INTERVAL_MS)
    expect(APPROACH_SERIES.some((row) => !row.gated && row.speedPxPerMs > gated[0].speedPxPerMs)).toBe(true)
  })
})

describe('reveal latency profile and geometry', () => {
  it('accepts only a Hide right-edge profile with onboarding done', () => {
    expect(() => validateRevealProfile(representativeSettings('/tmp/p', 1, { overlayLayout: 'hide' }))).not.toThrow()
    expect(() => validateRevealProfile(representativeSettings('/tmp/p', 1))).toThrow(/overlayLayout hide/)
    expect(() =>
      validateRevealProfile({ ...representativeSettings('/tmp/p', 1, { overlayLayout: 'hide' }), overlayPlacement: 'top-center' })
    ).toThrow(/right-edge/)
    expect(() =>
      validateRevealProfile({ ...representativeSettings('/tmp/p', 1, { overlayLayout: 'hide' }), onboardingDone: false })
    ).toThrow(/onboarding/)
  })

  it('treats the 4 px band and the 32 px Windows park as parked, and a drawer as revealed', () => {
    expect(isParkedBounds(macParked)).toBe(true)
    expect(isParkedBounds(winParked)).toBe(true)
    expect(isParkedBounds({ x: 1500, y: 240, width: 408, height: 600 })).toBe(false)
    expect(isParkedBounds(null)).toBe(false)
  })

  it('approaches the band centre from rest and enters at the rightmost 4 px', () => {
    const plan = approachPlan(macParked)
    expect(plan.away).toEqual({ fromX: 1319, toX: 1319, y: 540, speedPxPerMs: 0, entryX: 1319 })
    expect(plan.approach(1)).toEqual({ fromX: 1319, toX: 1919, y: 540, speedPxPerMs: 1, entryX: 1916 })
    expect(approachPlan(winParked).approach(3)).toEqual({ fromX: 1319, toX: 1919, y: 540, speedPxPerMs: 3, entryX: 1916 })
  })

  it('refuses a window that is not parked or a display too narrow for the rest point', () => {
    expect(() => approachPlan({ x: 1500, y: 240, width: 408, height: 600 })).toThrow(/not parked/)
    expect(() => approachPlan({ x: 300, y: 0, width: 4, height: 600 })).toThrow(/too narrow/)
  })
})

describe('reveal latency summary and report', () => {
  const trial = (grossMs: number | null) => ({ entryAt: 1_000, revealAt: grossMs === null ? null : 1_000 + grossMs })

  it('uses nearest-rank percentiles', () => {
    expect(percentile([], 95)).toBeNull()
    expect(percentile([5], 95)).toBe(5)
    const hundred = Array.from({ length: 100 }, (_, i) => 100 - i)
    expect(percentile(hundred, 95)).toBe(95)
    expect(percentile(hundred, 50)).toBe(50)
    expect(percentile([3, 1, 2], 100)).toBe(3)
  })

  it('subtracts the intentional dwell and passes a net p95 at the bar', () => {
    const summary = summarizeRevealSeries(Array.from({ length: 20 }, (_, i) => trial(160 + i * 7)))
    expect(summary.netP50Ms).toBe(10 + 9 * 7)
    expect(summary.netP95Ms).toBe(10 + 18 * 7)
    expect(summary.netMaxMs).toBe(10 + 19 * 7)
    expect(summary.status).toBe('PASS')
    expect(summarizeRevealSeries([trial(RIGHT_EDGE_REVEAL_DWELL_MS + 150)]).status).toBe('PASS')
  })

  it('fails a net p95 over the bar', () => {
    const summary = summarizeRevealSeries([trial(200), trial(RIGHT_EDGE_REVEAL_DWELL_MS + 151)])
    expect(summary.netP95Ms).toBe(151)
    expect(summary.status).toBe('FAIL')
  })

  it('fails on a missed reveal instead of dropping it, and on no trials', () => {
    const summary = summarizeRevealSeries([trial(160), trial(null)])
    expect(summary.misses).toBe(1)
    expect(summary.netP95Ms).toBe(10)
    expect(summary.status).toBe('FAIL')
    expect(summarizeRevealSeries([]).status).toBe('FAIL')
  })

  it('takes its status from the gated series only', () => {
    const series = [
      { name: 'approach', speedPxPerMs: 1, gated: true, status: 'PASS' },
      { name: 'fling', speedPxPerMs: 3, gated: false, status: 'FAIL' }
    ]
    const report = revealLatencyReport({ platform: 'darwin', productVersion: '1.9.6', parked: macParked, series })
    expect(report).toMatchObject({ schema: 'metis.reveal-latency.v1', status: 'PASS', dwellMs: 150, p95MaxMs: 150 })
    expect(report.series).toEqual(series)
    const failed = revealLatencyReport({
      platform: 'darwin',
      productVersion: '1.9.6',
      parked: macParked,
      series: [{ ...series[0], status: 'FAIL' }, series[1]]
    })
    expect(failed.status).toBe('FAIL')
    expect(revealLatencyReport({ platform: 'darwin', productVersion: null, parked: macParked, series: [] }).status).toBe('FAIL')
  })

  it('exits 0 on PASS, 1 on FAIL and 3 on BLOCKED_EXTERNAL', () => {
    expect(revealLatencyExitCode({ status: 'PASS' })).toBe(0)
    expect(revealLatencyExitCode(revealLatencyFailedReport({ platform: 'win32', reason: 'never parked' }))).toBe(1)
    const blocked = revealLatencyBlockedReport({ platform: 'win32', reason: 'pointer did not move' })
    expect(blocked).toMatchObject({ status: 'BLOCKED_EXTERNAL', reason: 'pointer did not move' })
    expect(blocked.unblockStep).toContain('reveal-latency.mjs')
    expect(revealLatencyExitCode(blocked)).toBe(3)
  })

  it('gates CI: FAIL or no report fails, BLOCKED_EXTERNAL warns with the unblock step', () => {
    expect(revealLatencyGate(null).fail).toBe(true)
    expect(revealLatencyGate({ status: 'PASS' })).toMatchObject({ fail: false })
    expect(revealLatencyGate(revealLatencyFailedReport({ platform: 'darwin', reason: 'never parked' }))).toMatchObject({
      fail: true,
      message: expect.stringContaining('never parked')
    })
    const blocked = revealLatencyGate(revealLatencyBlockedReport({ platform: 'darwin', reason: 'pointer did not move' }))
    expect(blocked).toMatchObject({ fail: false, warning: true })
    expect(blocked.message).toContain('BLOCKED_EXTERNAL')
    expect(blocked.message).toContain('interactive desktop')
  })

  it('reads its arguments and refuses incomplete ones', () => {
    expect(readRevealLatencyArgs(['--app', 'A', '--profile', 'P', '--output', 'O'])).toEqual({
      app: 'A',
      profile: 'P',
      output: 'O',
      trials: 20,
      settleMs: 15_000
    })
    expect(readRevealLatencyArgs(['--app', 'A', '--profile', 'P', '--output', 'O', '--trials', '5']).trials).toBe(5)
    expect(() => readRevealLatencyArgs(['--app', 'A', '--profile', 'P'])).toThrow(/required/)
    expect(() => readRevealLatencyArgs(['--app', 'A', '--profile', 'P', '--output', 'O', '--trials', '0'])).toThrow(/trials/)
    expect(() => readRevealLatencyArgs(['--app', 'A', '--profile', 'P', '--output', 'O', '--bogus'])).toThrow(/unknown/)
  })
})

describe('pointer driver (ADR-018)', () => {
  const approach = { fromX: 1319, toX: 1919, y: 540, speedPxPerMs: 1, entryX: 1916 }

  it('moves the real pointer and reads it back on both OSes', () => {
    expect(DARWIN_POINTER_DRIVER).toContain('$.CGWarpMouseCursorPosition(')
    expect(DARWIN_POINTER_DRIVER).toContain('$.NSEvent.mouseLocation')
    expect(WIN32_POINTER_DRIVER).toContain('[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(')
    expect(WIN32_POINTER_DRIVER).toContain('$at = [System.Windows.Forms.Cursor]::Position')
  })

  it('passes a move as five positional non-negative numbers', () => {
    expect(pointerDriverArgs(approach)).toEqual(['1319', '1919', '540', '1', '1916'])
    expect(pointerDriverArgs(stationaryMove({ x: 400, y: 400 }))).toEqual(['400', '400', '400', '0', '400'])
    expect(() => pointerDriverArgs({ ...approach, fromX: -1 })).toThrow(/non-negative/)
    expect(() => pointerDriverArgs({ ...approach, toX: 1000 })).toThrow(/rightward/)
    expect(() => pointerDriverArgs({ ...approach, y: 540.5 })).toThrow(/whole/)
  })

  it('runs osascript JavaScript on macOS, Windows PowerShell -File on Windows, and nothing elsewhere', () => {
    expect(pointerDriverCommand('darwin', '/t/d.js', approach)).toEqual({
      command: '/usr/bin/osascript',
      args: ['-l', 'JavaScript', '/t/d.js', '1319', '1919', '540', '1', '1916']
    })
    const win = pointerDriverCommand('win32', 'C:\\t\\d.ps1', approach)
    expect(win?.command).toMatch(/powershell\.exe$/)
    expect(win?.args.slice(-7)).toEqual(['-File', 'C:\\t\\d.ps1', '1319', '1919', '540', '1', '1916'])
    expect(pointerDriverCommand('linux', '/t/d.js', approach)).toBeNull()
  })

  it('rejects an unsupported platform before running anything', async () => {
    await expect(movePointer(approach, { platform: 'linux' })).rejects.toThrow(/no pointer driver for linux/)
  })

  it('accepts a read-back at the end point and refuses a pointer that did not move', () => {
    const ok = '{"entryAt":1005,"endAt":1600,"readBack":{"x":1919,"y":541}}'
    expect(parsePointerDriverOutput(`noise\n${ok}\n`, approach)).toEqual({ entryAt: 1005, endAt: 1600, readBack: { x: 1919, y: 541 } })
    expect(() => parsePointerDriverOutput('{"entryAt":1005,"endAt":1600,"readBack":{"x":960,"y":540}}', approach)).toThrow(
      /did not move/
    )
    expect(() => parsePointerDriverOutput('{"entryAt":null,"endAt":1600,"readBack":{"x":1919,"y":540}}', approach)).toThrow(
      /entryX/
    )
    expect(() => parsePointerDriverOutput('execution error: not allowed', approach)).toThrow(/no result/)
    expect(() => parsePointerDriverOutput('{"endAt":1600}', approach)).toThrow(/readBack/)
  })

  it('parses a screen point', () => {
    expect(parsePoint('400,400')).toEqual({ x: 400, y: 400 })
    expect(() => parsePoint('400')).toThrow(/x,y/)
    expect(() => parsePoint('-1,4')).toThrow(/x,y/)
  })
})

describe('parked-idle pointer precondition (ADR-018)', () => {
  it('requires a pointer-away point for parked-idle only', () => {
    expect(() => validatePointerAwayForState('parked-idle', undefined)).toThrow(/--pointer-away/)
    expect(() => validatePointerAwayForState('parked-idle', { x: 400, y: 400 })).not.toThrow()
    expect(() => validatePointerAwayForState('settled-idle', undefined)).not.toThrow()
  })

  it('reports a pointer that cannot be moved as BLOCKED_EXTERNAL with no census numbers', () => {
    const report = parkedIdleBlockedReport({ platform: 'darwin', reason: 'pointer did not move' })
    expect(report).toEqual({
      state: 'parked-idle',
      platform: 'darwin',
      status: 'BLOCKED_EXTERNAL',
      reason: 'pointer did not move',
      unblockStep: expect.stringContaining('--pointer-away')
    })
  })

  it('launches measured apps without provider keys or tokens', () => {
    expect(stripSecretEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', GH_TOKEN: 'y', MY_SECRET: 'z' })).toEqual({ PATH: '/bin' })
  })
})
