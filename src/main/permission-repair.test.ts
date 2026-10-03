import { describe, expect, it, vi } from 'vitest'
import {
  repairScreenPermission,
  resumeScreenRepair,
  SCREEN_REPAIR_MANUAL_GUIDANCE,
  TCCUTIL_PATH,
  type ScreenRepairDeps
} from './permission-repair'

function deps(overrides: Partial<ScreenRepairDeps> = {}, execError: (Error & { code?: number | string }) | null = null) {
  const order: string[] = []
  const d: ScreenRepairDeps = {
    platform: 'darwin',
    bundleId: 'com.mantu.asktoto',
    execFile: vi.fn<ScreenRepairDeps['execFile']>((_file, _args, _opts, cb) => {
      order.push('exec')
      cb(execError)
    }),
    audit: vi.fn(() => void order.push('audit')),
    onRepairStarted: vi.fn(() => void order.push('started')),
    onRepairFailed: vi.fn(() => void order.push('failed')),
    relaunch: vi.fn(() => void order.push('relaunch')),
    ...overrides
  }
  return { d, order }
}

describe('repairScreenPermission', () => {
  it('runs exactly /usr/bin/tccutil reset ScreenCapture <own bundle id>, without a shell', async () => {
    const { d } = deps()
    await repairScreenPermission(d)
    expect(d.execFile).toHaveBeenCalledTimes(1)
    const [file, args, opts] = vi.mocked(d.execFile).mock.calls[0]
    expect(file).toBe(TCCUTIL_PATH)
    expect(args).toEqual(['reset', 'ScreenCapture', 'com.mantu.asktoto'])
    expect(opts).toMatchObject({ shell: false })
  })

  it('accepts the QA identity', async () => {
    const { d } = deps({ bundleId: 'com.mantu.asktoto.qa' })
    await expect(repairScreenPermission(d)).resolves.toEqual({ ok: true })
    expect(vi.mocked(d.execFile).mock.calls[0][1]).toEqual(['reset', 'ScreenCapture', 'com.mantu.asktoto.qa'])
  })

  it('on success audits ok, persists the pending re-probe, then relaunches', async () => {
    const { d, order } = deps()
    await expect(repairScreenPermission(d)).resolves.toEqual({ ok: true })
    expect(d.audit).toHaveBeenCalledWith('permission.repair', { ok: true, exitCode: 0 })
    expect(order).toEqual(['exec', 'audit', 'started', 'relaunch'])
  })

  it('on failure audits the exit code, never relaunches, and returns the remove-then-add guidance', async () => {
    const err = Object.assign(new Error('tccutil: Failed to reset ScreenCapture'), { code: 70 })
    const { d, order } = deps({}, err)
    await expect(repairScreenPermission(d)).resolves.toEqual({
      ok: false,
      reason: 'tccutil-failed',
      exitCode: 70,
      guidance: SCREEN_REPAIR_MANUAL_GUIDANCE
    })
    expect(d.audit).toHaveBeenCalledWith('permission.repair', { ok: false, exitCode: 70 })
    expect(order).toEqual(['exec', 'audit', 'failed'])
    expect(SCREEN_REPAIR_MANUAL_GUIDANCE).toMatch(/remove it with “–”.*add .*“\+”/)
  })

  it('a spawn failure (no numeric exit code) is a failure with exitCode null', async () => {
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    const { d } = deps({}, err)
    await expect(repairScreenPermission(d)).resolves.toMatchObject({ ok: false, exitCode: null })
  })

  it('refuses any bundle id outside the allowlist without running anything', async () => {
    for (const bundleId of ['com.apple.Safari', 'com.mantu.asktoto; rm -rf ~', '', 'All']) {
      const { d } = deps({ bundleId })
      await expect(repairScreenPermission(d)).resolves.toMatchObject({ ok: false, reason: 'bundle-not-allowed' })
      expect(d.execFile).not.toHaveBeenCalled()
      expect(d.relaunch).not.toHaveBeenCalled()
    }
  })

  it('refuses off macOS', async () => {
    for (const platform of ['win32', 'linux']) {
      const { d } = deps({ platform })
      await expect(repairScreenPermission(d)).resolves.toMatchObject({ ok: false, reason: 'unsupported-platform' })
      expect(d.execFile).not.toHaveBeenCalled()
    }
  })
})

describe('resumeScreenRepair', () => {
  it('does nothing on an ordinary launch', async () => {
    const probe = vi.fn(async () => true)
    const openScreenRecordingPane = vi.fn()
    await resumeScreenRepair({ takePending: () => false, probe, openScreenRecordingPane })
    expect(probe).not.toHaveBeenCalled()
    expect(openScreenRecordingPane).not.toHaveBeenCalled()
  })

  it('after a repair relaunch, re-probes once and deep-links to the pane while not granted', async () => {
    const probe = vi.fn(async () => false)
    const openScreenRecordingPane = vi.fn()
    await resumeScreenRepair({ takePending: () => true, probe, openScreenRecordingPane })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(openScreenRecordingPane).toHaveBeenCalledTimes(1)
  })

  it('a probe that already works needs no trip to the pane; a throwing probe still opens it', async () => {
    const open1 = vi.fn()
    await resumeScreenRepair({ takePending: () => true, probe: async () => true, openScreenRecordingPane: open1 })
    expect(open1).not.toHaveBeenCalled()
    const open2 = vi.fn()
    await resumeScreenRepair({ takePending: () => true, probe: async () => Promise.reject(new Error('x')), openScreenRecordingPane: open2 })
    expect(open2).toHaveBeenCalledTimes(1)
  })
})
