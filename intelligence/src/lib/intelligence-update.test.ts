import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  INTELLIGENCE_STATUS_UNAVAILABLE_COPY,
  INTELLIGENCE_UPDATE_TRANSPORT_COPY,
  NO_PROVIDER_INDEX_COPY,
  SIGN_IN_INDEX_COPY,
  clearRecoveredIntelligenceUpdateError,
  createIntelligenceUpdateAttempt,
  intelligenceUpdateViewState,
  intelligenceUpdateError,
  ipcFailureMessage,
  runIntelligenceUpdateClick
} from './intelligence-update'

describe('dashboard Update Intelligence click', () => {
  it('surfaces no-provider and sign-in copy', async () => {
    expect(intelligenceUpdateError({ deferred: 'no-provider' })).toBe(NO_PROVIDER_INDEX_COPY)
    await expect(
      runIntelligenceUpdateClick(async () => ({ queued: 0, error: SIGN_IN_INDEX_COPY }))
    ).resolves.toEqual({ error: SIGN_IN_INDEX_COPY })
    await expect(runIntelligenceUpdateClick(async () => ({ queued: 2 }))).resolves.toEqual({ error: null })
  })

  it('NavBar mounts the Update Intelligence button', () => {
    const nav = readFileSync(join(__dirname, '../components/NavBar.tsx'), 'utf8')
    expect(nav).toMatch(/IntelligenceUpdateButton/)
    const btn = readFileSync(join(__dirname, '../components/IntelligenceUpdateButton.tsx'), 'utf8')
    expect(btn).toMatch(/Updating…/)
    expect(btn).toMatch(/createIntelligenceUpdateAttempt/)
    expect(btn).toMatch(/window\.intelligence/)
  })

  it('keeps busy through dispatch and an authoritative running refresh, then follows terminal status', async () => {
    let releaseDispatch!: (result: { queued: number }) => void
    const dispatch = vi.fn(
      () =>
        new Promise<{ queued: number }>((resolve) => {
          releaseDispatch = resolve
        })
    )
    const refresh = vi.fn(async () => ({ running: true }))
    const states: Array<{
      busy: boolean
      error: string | null
      errorKind: 'action' | 'transport' | null
    }> = []
    const attempt = createIntelligenceUpdateAttempt((state) => states.push(state))

    const first = attempt.run(dispatch, refresh)
    await expect(attempt.run(dispatch, refresh)).resolves.toBe('ignored')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(states.at(-1)).toEqual({ busy: true, error: null, errorKind: null })

    releaseDispatch({ queued: 1 })
    await expect(first).resolves.toBe('running')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(states.at(-1)).toEqual({ busy: false, error: null, errorKind: null })

    expect(
      intelligenceUpdateViewState(states.at(-1)!, { running: true, lastError: null })
    ).toEqual({ busy: true, error: null, errorKind: null })
    expect(
      intelligenceUpdateViewState(states.at(-1)!, { running: false, lastError: null })
    ).toEqual({ busy: false, error: null, errorKind: null })
    expect(
      intelligenceUpdateViewState(states.at(-1)!, {
        running: false,
        lastError: 'The provider could not finish this index run.'
      })
    ).toEqual({
      busy: false,
      error: 'The provider could not finish this index run.',
      errorKind: null
    })

    const failedStates: Array<{
      busy: boolean
      error: string | null
      errorKind: 'action' | 'transport' | null
    }> = []
    const failedAttempt = createIntelligenceUpdateAttempt((state) => failedStates.push(state))
    await expect(
      failedAttempt.run(async () => ({ queued: 1 }), async () => ({
        running: false,
        lastError: 'The provider could not finish this index run.'
      }))
    ).resolves.toBe('failed')
    expect(failedStates.at(-1)).toEqual({
      busy: false,
      error: null,
      errorKind: null
    })
  })

  it('uses fixed safe copy for transport failures and missing authoritative status', async () => {
    expect(INTELLIGENCE_UPDATE_TRANSPORT_COPY).toContain('may still be running')
    expect(INTELLIGENCE_UPDATE_TRANSPORT_COPY).not.toContain('Could not start')
    expect(ipcFailureMessage(new Error('/Users/private/key.txt provider secret'))).toBe(
      INTELLIGENCE_UPDATE_TRANSPORT_COPY
    )
    expect(intelligenceUpdateError({ error: '/Users/private/key.txt provider secret' })).toBe(
      INTELLIGENCE_UPDATE_TRANSPORT_COPY
    )

    const transportStates: Array<{
      busy: boolean
      error: string | null
      errorKind: 'action' | 'transport' | null
    }> = []
    const transportAttempt = createIntelligenceUpdateAttempt((state) => transportStates.push(state))
    await expect(
      transportAttempt.run(async () => {
        throw new Error('/Users/private/key.txt provider secret')
      }, async () => ({ running: false }))
    ).resolves.toBe('failed')
    expect(transportStates.at(-1)).toEqual({
      busy: false,
      error: INTELLIGENCE_UPDATE_TRANSPORT_COPY,
      errorKind: 'transport'
    })

    const refreshFailureStates: Array<{
      busy: boolean
      error: string | null
      errorKind: 'action' | 'transport' | null
    }> = []
    const refreshFailureAttempt = createIntelligenceUpdateAttempt((state) =>
      refreshFailureStates.push(state)
    )
    await expect(
      refreshFailureAttempt.run(async () => ({ queued: 1 }), async () => {
        throw new Error('/Users/private/status.sock')
      })
    ).resolves.toBe('failed')
    expect(refreshFailureStates.at(-1)).toEqual({
      busy: false,
      error: INTELLIGENCE_UPDATE_TRANSPORT_COPY,
      errorKind: 'transport'
    })

    const missingStates: Array<{
      busy: boolean
      error: string | null
      errorKind: 'action' | 'transport' | null
    }> = []
    const missingAttempt = createIntelligenceUpdateAttempt((state) => missingStates.push(state))
    await expect(
      missingAttempt.run(async () => ({ queued: 1 }), async () => null)
    ).resolves.toBe('failed')
    expect(missingStates.at(-1)).toEqual({
      busy: false,
      error: INTELLIGENCE_STATUS_UNAVAILABLE_COPY,
      errorKind: 'transport'
    })
  })

  it('clears uncertain transport copy on valid status recovery without resurrecting it later', () => {
    const uncertain = {
      busy: false,
      error: INTELLIGENCE_UPDATE_TRANSPORT_COPY,
      errorKind: 'transport' as const
    }
    expect(intelligenceUpdateViewState(uncertain, null)).toEqual(uncertain)

    const recovered = clearRecoveredIntelligenceUpdateError(uncertain)
    expect(recovered).toEqual({ busy: false, error: null, errorKind: null })
    expect(intelligenceUpdateViewState(recovered, { running: true })).toEqual({
      busy: true,
      error: null,
      errorKind: null
    })
    expect(intelligenceUpdateViewState(recovered, { running: false })).toEqual({
      busy: false,
      error: null,
      errorKind: null
    })

    const actionable = {
      busy: false,
      error: NO_PROVIDER_INDEX_COPY,
      errorKind: 'action' as const
    }
    expect(clearRecoveredIntelligenceUpdateError(actionable)).toEqual(actionable)
    expect(
      intelligenceUpdateViewState(actionable, {
        running: false,
        lastError: 'The current index run failed safely.'
      })
    ).toEqual({
      busy: false,
      error: 'The current index run failed safely.',
      errorKind: null
    })
  })
})
