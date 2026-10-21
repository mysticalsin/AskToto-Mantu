import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindLiveJournalLifecycle,
  currentLiveJournalLifecycle,
  endLiveMeetingJournal,
  purgeLiveMeetingJournal,
  type LiveJournalLifecycle
} from './live-journal-lifecycle'

const lifecycle = (overrides: Partial<LiveJournalLifecycle> = {}): LiveJournalLifecycle => ({
  end: vi.fn(async () => undefined),
  purge: vi.fn(async () => undefined),
  draftHooks: () => null,
  recoverRemaining: async () => ({ promoted: 0 }),
  ...overrides
})

let unbind: (() => void) | undefined
afterEach(() => unbind?.())

describe('live journal lifecycle seam', () => {
  it('is a no-op until a journal is bound', async () => {
    expect(currentLiveJournalLifecycle()).toBeNull()
    await expect(endLiveMeetingJournal(1, 'finalized')).resolves.toBeUndefined()
    await expect(purgeLiveMeetingJournal(1)).resolves.toBeUndefined()
  })

  it('forwards to the bound journal and unbinds only its own binding', async () => {
    const first = lifecycle()
    const second = lifecycle()
    const unbindFirst = bindLiveJournalLifecycle(first)
    unbind = bindLiveJournalLifecycle(second)
    await endLiveMeetingJournal(7, 'discarded')
    await purgeLiveMeetingJournal(7)
    expect(second.end).toHaveBeenCalledWith(7, 'discarded')
    expect(second.purge).toHaveBeenCalledWith(7)
    expect(first.end).not.toHaveBeenCalled()
    unbindFirst() // a stale disposer must not unbind the newer journal
    expect(currentLiveJournalLifecycle()).toBe(second)
  })

  it('never throws, even when the journal does', async () => {
    unbind = bindLiveJournalLifecycle(
      lifecycle({
        end: async () => {
          throw new Error('seal failed')
        },
        purge: () => {
          throw new Error('purge failed')
        }
      })
    )
    await expect(endLiveMeetingJournal(1, 'finalized')).resolves.toBeUndefined()
    await expect(purgeLiveMeetingJournal(1)).resolves.toBeUndefined()
  })
})
