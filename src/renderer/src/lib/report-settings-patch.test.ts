import { describe, expect, it, vi } from 'vitest'
import type { PublicSettings } from '@shared/ipc'
import { reportingPatch, SETTINGS_SAVE_FAILED_MESSAGE } from './report-settings-patch'
import { patchSettingsChecked } from './settings-patch-result'

const snapshot = { customBaseUrl: 'https://a.invalid' } as PublicSettings

describe('reportingPatch (Q10, D6-6)', () => {
  it('passes a successful write through and clears an earlier message', async () => {
    const report = vi.fn()
    const patch = reportingPatch(async () => snapshot, report)
    await expect(patch({ customBaseUrl: 'https://a.invalid' })).resolves.toBe(snapshot)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(null)
  })

  it('reports a rejected write once, in plain words, and still rejects for a caller that awaits it', async () => {
    const report = vi.fn()
    const patch = reportingPatch(() => Promise.reject(new Error('EACCES /Users/someone/settings.json')), report)
    await expect(patch({ launchAtLogin: true })).rejects.toThrow('EACCES')
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(SETTINGS_SAVE_FAILED_MESSAGE)
    expect(SETTINGS_SAVE_FAILED_MESSAGE).toBe("Métis couldn't save this change. Try again.")
    expect(SETTINGS_SAVE_FAILED_MESSAGE).not.toContain('settings.json')
  })

  it('leaves no unhandled rejection behind when a fire-and-forget caller ignores the result', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const report = vi.fn()
      const patch = reportingPatch(() => Promise.reject(new Error('disk full')), report)
      void patch({ launchAtLogin: true }) // what `onChange={(v) => patch(...)}` does
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(report).toHaveBeenCalledTimes(1)
      expect(report).toHaveBeenCalledWith(SETTINGS_SAVE_FAILED_MESSAGE)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('does not swallow the failure a patchSettingsChecked caller has to explain next to its own field', async () => {
    const report = vi.fn()
    const patch = reportingPatch(() => Promise.reject(new Error('disk full')), report)
    const result = await patchSettingsChecked(patch, { customBaseUrl: 'https://a.invalid' })
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    // The field shows its own message, so the pane-level line stays quiet (one message per failure).
    expect(report).not.toHaveBeenCalled()
  })
})
