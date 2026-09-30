import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PARKED_BOUNDS, ParkPreconditionError, isParkedBounds, monitorParkedIdle, parkVerdict } from './park.mjs'
import { launchOptions, parkedIdlePreconditionFailureReport, pointerMoveCommand, validateParkedIdleProfile } from './run.mjs'

function fakeSleep(advance: (ms: number) => void) {
  return async <T = void>(delay?: number, value?: T): Promise<T> => {
    advance(delay ?? 0)
    return value as T
  }
}

describe('parked-idle window-bounds proof', () => {
  it('classifies only the parked 8x2 window bounds as parked', () => {
    expect(isParkedBounds({ ...PARKED_BOUNDS, left: 10, top: 0 })).toBe(true)
    expect(parkVerdict({ width: 8, height: 2, left: 10, top: 0 }, 0)).toEqual({
      observedAt: new Date(0).toISOString(),
      bounds: { width: 8, height: 2, left: 10, top: 0 },
      parked: true
    })
    expect(isParkedBounds({ width: 880, height: 120, left: 0, top: 0 })).toBe(false)
    expect(parkVerdict({ width: 880, height: 120, left: 0, top: 0 }, 0).parked).toBe(false)
  })

  it('treats a failed first park check as a PRECONDITION failure with observed bounds', async () => {
    let clockMs = 0
    await expect(
      monitorParkedIdle({
        seconds: 300,
        checkPark: async (observedAtMs: number) => parkVerdict({ width: 880, height: 120 }, observedAtMs),
        now: () => clockMs,
        sleep: fakeSleep((ms) => {
          clockMs += ms
        })
      })
    ).rejects.toMatchObject({
      name: 'ParkPreconditionError',
      exitCode: 2,
      details: {
        observedBounds: { width: 880, height: 120 }
      }
    })
  })

  it('builds the run.mjs PRECONDITION report for a failed first check with observed bounds', () => {
    const firstCheck = parkVerdict({ left: 0, top: 0, width: 880, height: 120 }, 0)

    const report = parkedIdlePreconditionFailureReport({
      parkedIdle: { pointerMovedOffTopEdge: { x: 32, y: 200, method: 'CGWarpMouseCursorPosition' } },
      firstCheck,
      productVersion: '1.9.7',
      platform: 'darwin',
      state: 'parked-idle',
      seconds: 300,
      mainPid: 123
    })

    expect(report).toMatchObject({
      evidenceLevel: 'PRECONDITION',
      state: 'parked-idle',
      mainPid: 123,
      statePrecondition: {
        required: true,
        kind: 'parked-idle',
        status: 'PRECONDITION',
        observedBounds: { left: 0, top: 0, width: 880, height: 120 }
      },
      parkedIdle: {
        pointerMovedOffTopEdge: { x: 32, y: 200, method: 'CGWarpMouseCursorPosition' },
        boundsSignal: 'Browser.getWindowForTarget/getWindowBounds',
        expectedBounds: PARKED_BOUNDS,
        checks: [firstCheck],
        summary: { checks: 1, parked: 0, notParked: 1, parkedCoverage: 0 }
      }
    })
  })

  it('records coverage when the window un-parks after the initial proof', async () => {
    let clockMs = 0
    let checks = 0
    const result = await monitorParkedIdle({
      seconds: 180,
      checkPark: async (observedAtMs: number) => {
        checks += 1
        return parkVerdict(checks < 3 ? PARKED_BOUNDS : { width: 880, height: 120 }, observedAtMs)
      },
      now: () => clockMs,
      sleep: fakeSleep((ms) => {
        clockMs += ms
      })
    })

    expect(result.checks.map((check) => check.parked)).toEqual([true, true, false, false])
    expect(result.summary).toEqual({ checks: 4, parked: 2, notParked: 2, parkedCoverage: 0.5 })
  })
})

describe('parked-idle launch preconditions', () => {
  function withManifest(layout: string, fn: (profile: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'metis-parked-idle-profile-'))
    try {
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'resource-census-profile.json'), `${JSON.stringify({ layout })}\n`, 'utf8')
      fn(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('requires a hide-layout profile manifest before launch', () => {
    withManifest('hide', (profile) => {
      expect(validateParkedIdleProfile(profile)).toEqual({ layout: 'hide' })
    })
    withManifest('bar', (profile) => {
      expect(() => validateParkedIdleProfile(profile)).toThrow(/layout "hide"; observed "bar"/)
    })
    expect(() => validateParkedIdleProfile('')).toThrow(ParkPreconditionError)
  })

  it('keeps smoke-reopen hooks and hosted floor override out of launch argv and env', () => {
    const options = launchOptions({
      profile: '/tmp/metis-census-profile',
      port: 9334,
      env: {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'redacted',
        ASKTOTO_SMOKE_REOPEN_PROBE: '1',
        METIS_QA_HOST_FLOOR_OVERRIDE: '1'
      }
    })

    expect(options.args).toEqual(['--remote-debugging-port=9334'])
    expect(options.args.join(' ')).not.toContain('--metis-smoke-reopen')
    expect(options.env).toMatchObject({ PATH: '/usr/bin', ASKTOTO_USERDATA: '/tmp/metis-census-profile' })
    expect(options.env).not.toHaveProperty('ASKTOTO_SMOKE_REOPEN_PROBE')
    expect(options.env).not.toHaveProperty('METIS_QA_HOST_FLOOR_OVERRIDE')
    expect(options.env).not.toHaveProperty('OPENAI_API_KEY')
  })

  it('uses platform cursor APIs to move the pointer off the top-edge strip', () => {
    expect(pointerMoveCommand('darwin', { x: 32, y: 200 })).toMatchObject({
      executable: '/usr/bin/swift',
      method: 'CGWarpMouseCursorPosition'
    })
    expect(pointerMoveCommand('win32', { x: 32, y: 200 })).toMatchObject({
      method: 'user32.SetCursorPos'
    })
  })
})
