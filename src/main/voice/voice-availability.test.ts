import { describe, expect, it, vi } from 'vitest'
import { commandSpeechAvailability, createParakeetPresence } from './voice-availability'

const base = { authenticated: true, localSpeechAllowed: true, asrEngine: 'parakeet', parakeetPresent: false }

describe('commandSpeechAvailability: voice actions no longer depend on the meeting engine', () => {
  it('the Parakeet engine stays available as before, even before the model is confirmed present', () => {
    expect(commandSpeechAvailability(base)).toEqual({ ok: true })
  })

  it('the Apple Speech engine still allows voice actions when the Parakeet model is present', () => {
    expect(commandSpeechAvailability({ ...base, asrEngine: 'apple', parakeetPresent: true })).toEqual({ ok: true })
  })

  it('the Whisper engine still allows voice actions when the Parakeet model is present', () => {
    expect(commandSpeechAvailability({ ...base, asrEngine: 'whisper', parakeetPresent: true })).toEqual({ ok: true })
  })

  it('a non-Parakeet engine without the model is unavailable, never silently ok', () => {
    expect(commandSpeechAvailability({ ...base, asrEngine: 'apple', parakeetPresent: false })).toEqual({
      ok: false,
      reason: 'unsupported_engine'
    })
  })

  it('signed out wins over everything, and managed cloud-only policy wins over the engine', () => {
    expect(commandSpeechAvailability({ ...base, authenticated: false, localSpeechAllowed: false })).toEqual({
      ok: false,
      reason: 'unauthorized'
    })
    expect(
      commandSpeechAvailability({ ...base, localSpeechAllowed: false, asrEngine: 'apple', parakeetPresent: true })
    ).toEqual({ ok: false, reason: 'policy_blocked' })
  })
})

describe('createParakeetPresence', () => {
  it('is false until the first probe resolves, then follows the probe', async () => {
    const probe = vi.fn(async () => true)
    const presence = createParakeetPresence(probe)
    expect(presence.get()).toBe(false)
    await expect(presence.refresh()).resolves.toBe(true)
    expect(presence.get()).toBe(true)
    probe.mockResolvedValueOnce(false)
    await presence.refresh()
    expect(presence.get()).toBe(false)
  })

  it('a probe that throws reads as absent and never rejects', async () => {
    const presence = createParakeetPresence(async () => {
      throw new Error('closure check failed')
    })
    await expect(presence.refresh()).resolves.toBe(false)
    expect(presence.get()).toBe(false)
  })

  it('coalesces concurrent refreshes into one probe', async () => {
    let release!: (value: boolean) => void
    const probe = vi.fn(() => new Promise<boolean>((resolve) => void (release = resolve)))
    const presence = createParakeetPresence(probe)
    const a = presence.refresh()
    const b = presence.refresh()
    release(true)
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    expect(probe).toHaveBeenCalledOnce()
  })
})
