import { describe, expect, it, vi } from 'vitest'
import type { PublicSettings } from '@shared/ipc'
import { patchSettingsChecked } from './settings-patch-result'

const snapshot = (over: Partial<PublicSettings>): PublicSettings => over as PublicSettings

describe('patchSettingsChecked', () => {
  it('is ok when the returned snapshot carries the requested value', async () => {
    const patch = vi.fn(async (p: Partial<PublicSettings>) => snapshot(p))
    await expect(patchSettingsChecked(patch, { customBaseUrl: 'https://a.invalid' })).resolves.toEqual({ ok: true })
  })

  it('reports a refusal when main returns the previous value', async () => {
    const patch = vi.fn(async () => snapshot({ customBaseUrl: 'https://old.invalid' }))
    await expect(patchSettingsChecked(patch, { customBaseUrl: 'https://new.invalid' })).resolves.toMatchObject({
      ok: false,
      reason: 'refused'
    })
  })

  it('reports a failure without leaking main’s message', async () => {
    const patch = vi.fn(async () => {
      throw new Error("Couldn't save settings at /private/path/settings.json")
    })
    const result = await patchSettingsChecked(patch, { customBaseUrl: 'https://a.invalid' })
    expect(result).toEqual({ ok: false, reason: 'failed', message: "Métis couldn't save this change. Try again." })
  })
})
