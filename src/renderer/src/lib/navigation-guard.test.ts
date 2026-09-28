import { describe, expect, it, vi } from 'vitest'
import { NavigationGuardService } from './navigation-guard'

describe('NavigationGuardService', () => {
  it('reveals before publishing a pending decision and resolves Save / Discard / Cancel asynchronously', async () => {
    const reveal = vi.fn()
    const service = new NavigationGuardService(reveal)
    const seen: Array<string | null> = []
    service.subscribe(() => seen.push(service.current()?.title ?? null))

    const first = service.request({ title: 'Dirty recap', message: 'Choose before leaving.' })
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['Dirty recap'])

    service.choose('save')
    await expect(first).resolves.toBe('save')
    expect(service.current()).toBeNull()
    expect(seen).toEqual(['Dirty recap', null])

    const second = service.request({ title: 'Replay onboarding', message: 'Replay setup.' })
    service.choose('discard')
    await expect(second).resolves.toBe('discard')

    const third = service.request({ title: 'Log out', message: 'Leave this account.' })
    service.choose('cancel')
    await expect(third).resolves.toBe('cancel')
  })

  it('keeps an open decision pending for 30 seconds without auto-recovery, reload, or repeated reveal', async () => {
    vi.useFakeTimers()
    try {
      const reveal = vi.fn()
      const service = new NavigationGuardService(reveal)
      let settled = false
      const decision = service
        .request({ title: 'Dirty recap', message: 'Choose before leaving.' })
        .then(() => { settled = true })

      await vi.advanceTimersByTimeAsync(30_000)

      expect(settled).toBe(false)
      expect(service.current()?.title).toBe('Dirty recap')
      expect(reveal).toHaveBeenCalledTimes(1)

      service.choose('cancel')
      await decision
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('queues overlapping requests so one in-DOM sheet owns the decision at a time', async () => {
    const service = new NavigationGuardService()
    const first = service.request({ title: 'First', message: 'First message.' })
    const second = service.request({ title: 'Second', message: 'Second message.' })

    expect(service.current()?.title).toBe('First')
    service.choose('discard')
    await expect(first).resolves.toBe('discard')

    expect(service.current()?.title).toBe('Second')
    service.choose('save')
    await expect(second).resolves.toBe('save')
    expect(service.current()).toBeNull()
  })
})
