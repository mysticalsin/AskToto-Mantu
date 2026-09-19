import { describe, expect, it } from 'vitest'
import { ENCRYPTED_PROFILE_RECOVERY_ERROR_PREFIX } from '@shared/encrypted-profile-recovery'
import {
  ONBOARDING_COMPLETION_ERROR,
  createOnboardingCompletionFlow,
  ENCRYPTED_PROFILE_RECOVERY_UNCONFIRMED_MESSAGE,
  encryptedProfileRecoveryFailureMessage,
  isEncryptedProfileRecoveryError,
  persistOnboardingCompletion,
  type OnboardingCompletionState
} from './onboarding-completion'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('onboarding completion flow', () => {
  it('offers encrypted-profile recovery only for the safe, explicit key-unlock failure class', () => {
    expect(
      isEncryptedProfileRecoveryError(
        new Error(`${ENCRYPTED_PROFILE_RECOVERY_ERROR_PREFIX} Unlock or grant access to the original macOS Keychain, then try again.`)
      )
    ).toBe(true)
    expect(isEncryptedProfileRecoveryError(new Error('EACCES writing settings.json'))).toBe(false)
    expect(isEncryptedProfileRecoveryError(new Error('EACCES writing secret-key.bin'))).toBe(false)
    expect(isEncryptedProfileRecoveryError(new Error('Keychain query timed out'))).toBe(false)
    expect(isEncryptedProfileRecoveryError(new Error('Provider request failed'))).toBe(false)
  })

  it('keeps an archive failure honest without exposing its local recovery path', () => {
    const message = encryptedProfileRecoveryFailureMessage({
      error: 'Could not finish the profile archive. The partial recovery copy was left at /private/user-data/.metis-recovery-secret.'
    })

    expect(message).toContain('some encrypted files may be in the local recovery folder')
    expect(message).toContain('No data was deleted')
    expect(message).not.toContain('not changed')
    expect(message).not.toContain('/private/user-data')
  })

  it('makes no encrypted-data promise when the profile-recovery IPC rejects', () => {
    expect(ENCRYPTED_PROFILE_RECOVERY_UNCONFIRMED_MESSAGE).toContain('could not confirm')
    expect(ENCRYPTED_PROFILE_RECOVERY_UNCONFIRMED_MESSAGE).toContain('Restart Métis')
    expect(ENCRYPTED_PROFILE_RECOVERY_UNCONFIRMED_MESSAGE).not.toMatch(/deleted|unchanged|not changed/i)
    expect(ENCRYPTED_PROFILE_RECOVERY_UNCONFIRMED_MESSAGE).not.toContain('/private/user-data')
  })

  it('blocks duplicate completion while persistence is pending and runs the success action once', async () => {
    const pending = deferred<boolean>()
    const states: OnboardingCompletionState[] = []
    const events: string[] = []
    let finishCalls = 0
    const flow = createOnboardingCompletionFlow((state) => states.push(state))
    const finish = (): Promise<boolean> => {
      finishCalls += 1
      events.push('persist')
      return pending.promise
    }

    const first = flow.attempt(finish, () => events.push('navigate'))
    const duplicate = await flow.attempt(finish, () => events.push('navigate'))

    expect(duplicate).toBe('ignored')
    expect(finishCalls).toBe(1)
    expect(events).toEqual(['persist'])
    expect(states).toEqual([{ busy: true, error: null }])

    pending.resolve(true)
    expect(await first).toBe('completed')
    expect(events).toEqual(['persist', 'navigate'])
    expect(states.at(-1)).toEqual({ busy: false, error: null })

    expect(await flow.attempt(finish, () => events.push('navigate'))).toBe('ignored')
    expect(finishCalls).toBe(1)
    expect(events).toEqual(['persist', 'navigate'])
  })

  it('sanitizes a rejected save, permits retry, then persists before completion and AI Settings', async () => {
    const rawFailure = 'EACCES /Users/private/settings.json secret-key=do-not-show'
    const states: OnboardingCompletionState[] = []
    const events: string[] = []
    const patches: unknown[] = []
    let writes = 0
    const flow = createOnboardingCompletionFlow((state) => states.push(state))
    const finish = async (): Promise<boolean> => {
      await persistOnboardingCompletion({
        settingsPatch: {
          mode: 'meeting',
          recordingConsent: true,
          onboardingDone: true,
          onboardingDoneAt: 123
        },
        patch: async (settingsPatch) => {
          writes += 1
          patches.push(settingsPatch)
          if (writes === 1) throw new Error(rawFailure)
          events.push('persisted')
        },
        onCompleted: () => events.push('completed')
      })
      return true
    }

    expect(await flow.attempt(finish, () => events.push('settings'))).toBe('failed')
    expect(events).toEqual([])
    expect(states.filter((state) => state.error !== null)).toEqual([
      { busy: false, error: ONBOARDING_COMPLETION_ERROR }
    ])
    expect(ONBOARDING_COMPLETION_ERROR).not.toContain(rawFailure)

    expect(await flow.attempt(finish, () => events.push('settings'))).toBe('completed')
    expect(events).toEqual(['persisted', 'completed', 'settings'])
    expect(patches).toEqual([
      { mode: 'meeting', recordingConsent: true, onboardingDone: true, onboardingDoneAt: 123 },
      { mode: 'meeting', recordingConsent: true, onboardingDone: true, onboardingDoneAt: 123 }
    ])
    expect(states.at(-1)).toEqual({ busy: false, error: null })
  })

  it('does not navigate or permanently latch completion when the guarded finish is a no-op', async () => {
    const events: string[] = []
    const flow = createOnboardingCompletionFlow(() => {})

    expect(await flow.attempt(async () => false, () => events.push('settings'))).toBe('blocked')
    expect(events).toEqual([])
    expect(await flow.attempt(async () => true, () => events.push('settings'))).toBe('completed')
    expect(events).toEqual(['settings'])
  })
})
