import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron')

import { app } from 'electron'
import { devEnv, isPackagedBuild } from './dev-env'

// Regression locks for the "dev env kill-switch honored in a packaged build" family (MQA-148, MQA-167).
// src/main/index.ts boots Electron at import time, so there is no index.test.ts anywhere in this repo —
// the established pattern (index-audit-fixes.contract.test.ts, c-main-fixes.contract.test.ts) lifts the
// real expression out of the source and EXECUTES it with injected collaborators, so these assertions
// exercise the shipped logic rather than its shape.
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

/** Slice the source from `from` up to (excluding) the next occurrence of `to`. */
function sliceBetween(from: string, to: string): string {
  const start = indexSrc.indexOf(from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = indexSrc.indexOf(to, start)
  expect(end, `end marker not found after ${from}: ${to}`).toBeGreaterThan(-1)
  return indexSrc.slice(start, end)
}

type DevEnv = (name: string) => string | undefined
/** What devEnv() returns in a packaged build: nothing, whatever the environment says. */
const packagedDevEnv: DevEnv = () => undefined
const unpackagedDevEnv: DevEnv = (name) => process.env[name]

describe('devEnv — the single gate for dev-only environment switches', () => {
  afterEach(() => {
    delete (app as { isPackaged?: boolean }).isPackaged
    delete process.env.ASKTOTO_GATE_PROBE
  })

  it('returns nothing in a packaged build, whatever the environment says', () => {
    process.env.ASKTOTO_GATE_PROBE = '1'
    ;(app as { isPackaged?: boolean }).isPackaged = true
    expect(isPackagedBuild()).toBe(true)
    expect(devEnv('ASKTOTO_GATE_PROBE')).toBeUndefined()
  })

  it('still passes the value through for an unpackaged dev/QA run', () => {
    process.env.ASKTOTO_GATE_PROBE = '1'
    ;(app as { isPackaged?: boolean }).isPackaged = false
    expect(devEnv('ASKTOTO_GATE_PROBE')).toBe('1')
  })

  it('fails CLOSED when app.isPackaged cannot be read, instead of throwing into the caller', () => {
    process.env.ASKTOTO_GATE_PROBE = '1'
    Object.defineProperty(app, 'isPackaged', {
      configurable: true,
      get() {
        throw new Error('app not ready')
      }
    })
    expect(isPackagedBuild()).toBe(true)
    expect(devEnv('ASKTOTO_GATE_PROBE')).toBeUndefined()
  })
})

describe('MQA-148 — ASKTOTO_DISABLE_CP must not disable Private View in a packaged build', () => {
  /** Lift privateViewOn's real body out of index.ts and run it. */
  const privateViewOn = (env: DevEnv, privateView: boolean): boolean => {
    const src = sliceBetween('function privateViewOn(): boolean {', '\n}')
    const body = src.slice(src.indexOf('{') + 1)
    const lifted = new Function('devEnv', 'getSettings', body) as (
      devEnv: DevEnv,
      getSettings: () => { privateView: boolean }
    ) => boolean
    return lifted(env, () => ({ privateView }))
  }

  afterEach(() => {
    delete process.env.ASKTOTO_DISABLE_CP
  })

  it('MQA-148 — keeps Private View ON in a packaged build even with ASKTOTO_DISABLE_CP set', () => {
    // The threat: `setx ASKTOTO_DISABLE_CP 1` + relaunch needs no elevation, and privateViewOn() is the
    // single authority behind getScreenshot()'s pre/post checks and screen-preprocess's describe pass.
    process.env.ASKTOTO_DISABLE_CP = '1'
    expect(privateViewOn(packagedDevEnv, true)).toBe(true)
  })

  it('MQA-148 — still honors the switch for an unpackaged dev/screenshot run', () => {
    process.env.ASKTOTO_DISABLE_CP = '1'
    expect(privateViewOn(unpackagedDevEnv, true)).toBe(false)
  })

  it('MQA-148 — Settings reports the Private View value actually applied, not the raw stored one', () => {
    // Same UI-honesty rule contentProtection already follows at the line above: a display that keeps
    // reading the stored value would show "Private View: On" while capture is really running.
    const returned = sliceBetween('function publicSettings(): PublicSettings {', 'visionReady:')
    expect(returned).toMatch(/privateView:\s*privateViewOn\(\)/)
  })
})

describe('MQA-167 — the destructive self-test suite must not run in a packaged build', () => {
  /** Lift the real ASKTOTO_SELFTEST branch out of index.ts's whenReady body and run it. */
  const runSelfTestBranch = async (env: DevEnv): Promise<{ ran: string[]; quit: number; result: unknown }> => {
    const region = sliceBetween("process.on('unhandledRejection'", 'if (!app.isPackaged) loadDotEnv()')
      .split('\n')
      .slice(1)
      .join('\n')
    const ran: string[] = []
    let quit = 0
    const lifted = new Function(
      'devEnv',
      'runSelfTest',
      'app',
      'console',
      `return (async () => {\n${region}\nreturn 'branch-skipped'\n})()`
    ) as (
      devEnv: DevEnv,
      runSelfTest: (out: string) => Promise<void>,
      app: { quit: () => void },
      console: Console
    ) => Promise<unknown>
    const result = await lifted(
      env,
      async (out: string) => {
        ran.push(out)
      },
      { quit: () => { quit += 1 } },
      console
    )
    return { ran, quit, result }
  }

  afterEach(() => {
    delete process.env.ASKTOTO_SELFTEST
  })

  it('MQA-167 — a packaged build ignores ASKTOTO_SELFTEST instead of wiping the live profile', async () => {
    // runSelfTest overwrites and then deletes <userData>/settings.json and managed-config.json, so a
    // planted `setx ASKTOTO_SELFTEST out.json` would destroy the real profile on every launch.
    process.env.ASKTOTO_SELFTEST = '/tmp/planted-selftest-out.json'
    const { ran, quit, result } = await runSelfTestBranch(packagedDevEnv)
    expect(ran).toEqual([])
    expect(quit).toBe(0)
    expect(result).toBe('branch-skipped')
  })

  it('MQA-167 — an unpackaged dev/QA run still gets the self-test', async () => {
    process.env.ASKTOTO_SELFTEST = '/tmp/selftest-out.json'
    const { ran, quit } = await runSelfTestBranch(unpackagedDevEnv)
    expect(ran).toEqual(['/tmp/selftest-out.json'])
    expect(quit).toBe(1)
  })
})
