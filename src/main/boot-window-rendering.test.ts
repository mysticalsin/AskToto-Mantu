import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron')

import { bootWindowOptions, bootWindowVariant, bootWindowYield } from './boot-window-rendering'
import { projectEvent } from './infra/observability/projection'

/** BOOT_WINDOW_VARIANT as a fresh import resolves it, under the given build identity and QA variable value. */
async function launchVariant(qaIdentity: boolean, value: string): Promise<string> {
  vi.resetModules()
  vi.doMock('./qa-identity', () => ({ QA_IDENTITY_BUILD: qaIdentity }))
  vi.stubEnv('METIS_QA_WINDOW_VARIANT', value)
  return (await import('./boot-window-rendering')).BOOT_WINDOW_VARIANT
}

describe('the boot window variant (M2-0516)', () => {
  afterEach(() => {
    vi.doUnmock('./qa-identity')
    vi.unstubAllEnvs()
  })

  it('is always shipped in a shipping build, whatever the QA variable says', async () => {
    expect(await launchVariant(false, 'paint-when-hidden')).toBe('shipped')
    expect(await launchVariant(false, 'prewarm-view')).toBe('shipped')
  })

  it('is the variable’s variant in the QA-identity build', async () => {
    expect(await launchVariant(true, 'spellcheck-off')).toBe('spellcheck-off')
    expect(await launchVariant(true, 'prewarm-spellchecker')).toBe('prewarm-spellchecker')
  })

  it('is shipped for an unset, empty or unknown value', () => {
    for (const value of [undefined, '', 'transparent', 'SHIPPED']) expect(bootWindowVariant(value)).toBe('shipped')
    expect(bootWindowVariant('shipped')).toBe('shipped')
  })

  it('reaches the audit trail with the constructor stage, and the navigation stage is admitted too', () => {
    const bootId = '123e4567-e89b-42d3-a456-426614174000'
    const construct = { bootId, stage: 'createWindow.construct', ms: 700, transparent: true, windowVariant: 'prewarm-view' }
    expect(projectEvent('app.boot.stage', construct)).toEqual(construct)
    expect(projectEvent('app.boot.stage', { ...construct, windowVariant: 'not-a-variant' })).not.toHaveProperty('windowVariant')
    expect(projectEvent('app.boot.stage', { bootId, stage: 'createWindow.navigate', ms: 30 })).toEqual({
      bootId,
      stage: 'createWindow.navigate',
      ms: 30
    })
  })
})

describe('bootWindowOptions (M2-0516)', () => {
  it('sets no option for shipped or a prewarm variant, so the window is exactly its inline options', () => {
    for (const variant of ['shipped', 'prewarm-spellchecker', 'prewarm-view'] as const) {
      expect(bootWindowOptions(variant)).toEqual({ window: {}, webPreferences: {} })
    }
  })

  it('changes exactly one constructor option per option variant', () => {
    expect(bootWindowOptions('spellcheck-off')).toEqual({ window: {}, webPreferences: { spellcheck: false } })
    expect(bootWindowOptions('paint-when-hidden')).toEqual({ window: { paintWhenInitiallyHidden: true }, webPreferences: {} })
  })
})

describe('bootWindowYield (M2-0516)', () => {
  /** A yield that records itself, and prewarms that record themselves, in one shared order. */
  function recorder() {
    const order: string[] = []
    const prewarms = { spellchecker: () => order.push('spellchecker'), view: () => order.push('view') }
    const yieldTask = async (): Promise<void> => {
      order.push('yield')
    }
    return { order, prewarms, yieldTask }
  }

  it('only yields for a variant without a prewarm', async () => {
    const { order, prewarms, yieldTask } = recorder()
    for (const variant of ['shipped', 'spellcheck-off', 'paint-when-hidden'] as const) {
      await bootWindowYield(variant, prewarms, yieldTask, vi.fn())()
    }
    expect(order).toEqual(['yield', 'yield', 'yield'])
  })

  it('runs the prewarm in a task of its own between the caller’s and the constructor’s, once', async () => {
    const { order, prewarms, yieldTask } = recorder()
    const beforeWindow = bootWindowYield('prewarm-spellchecker', prewarms, yieldTask, vi.fn())
    await beforeWindow()
    expect(order).toEqual(['yield', 'spellchecker', 'yield'])
    await beforeWindow()
    expect(order).toEqual(['yield', 'spellchecker', 'yield', 'yield'])
  })

  it('prewarms a bare web contents for prewarm-view', async () => {
    const { order, prewarms, yieldTask } = recorder()
    await bootWindowYield('prewarm-view', prewarms, yieldTask, vi.fn())()
    expect(order).toEqual(['yield', 'view', 'yield'])
  })

  it('reports a prewarm that throws and still yields to the constructor', async () => {
    const { order, yieldTask } = recorder()
    const error = new Error('no web contents')
    const fail = vi.fn()
    const throwing = { spellchecker: vi.fn(), view: () => { throw error } }
    await bootWindowYield('prewarm-view', throwing, yieldTask, fail)()
    expect(fail).toHaveBeenCalledExactlyOnceWith(error)
    expect(order).toEqual(['yield', 'yield'])
  })
})
