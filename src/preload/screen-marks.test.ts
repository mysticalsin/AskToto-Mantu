import { describe, expect, it, vi } from 'vitest'
import { createScreenMarksPreloadApi, createScreenMarksQaApi } from './screen-marks'

describe('window.toto.screenMarks is QA-identity only (G43)', () => {
  it('a release (non-QA) preload exposes no qaPlace or qaClear', () => {
    // vitest compiles __METIS_QA_IDENTITY__ as false, exactly as a shipping preload does.
    const api = createScreenMarksPreloadApi({ invoke: vi.fn() })
    expect(api).toEqual({})
    expect('screenMarks' in api).toBe(false)
  })

  it('the QA bridge, when built, calls the QA channels and degrades to a refusal when main has no handler', async () => {
    const invoke = vi.fn(async () => ({ ok: true, markId: 'm1' }))
    const qa = createScreenMarksQaApi({ invoke })
    expect(await qa.screenMarks.qaPlace('obs-1', { kind: 'point', x: 1, y: 2 })).toEqual({ ok: true, markId: 'm1' })
    expect(invoke).toHaveBeenCalledWith('screenMarks:qaPlace', {
      screenshotId: 'obs-1',
      shape: { kind: 'point', x: 1, y: 2 }
    })
    const missing = createScreenMarksQaApi({ invoke: vi.fn().mockRejectedValue(new Error('no handler')) })
    expect(await missing.screenMarks.qaPlace('obs-1', { kind: 'point', x: 1, y: 2 })).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(await missing.screenMarks.qaClear()).toEqual({ ok: false })
  })

  it('the QA bridge is reachable only through a compile-time literal ternary, so a shipping bundle drops it', async () => {
    const { readModuleSource } = await import('../test-helpers/module-source')
    const src = readModuleSource(__dirname, './screen-marks').text
    expect(src).toMatch(/__METIS_QA_IDENTITY__\s*\?\s*createScreenMarksQaApi\(ipc\)\s*:\s*\{\}/)
  })
})
