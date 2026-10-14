import { describe, expect, it } from 'vitest'
import {
  assertCurrentSpeechPackInstallAdmission,
  createSpeechPackInstallAdmission,
  resolveSpeechPackInstallAdmission,
  type CurrentSpeechPackInstallAdmission
} from './install-admission'

describe('speech-pack install admission', () => {
  it('binds a current explicit action to one component, manifest, and transaction', async () => {
    const transaction = Symbol('install')
    const admission = createSpeechPackInstallAdmission({
      operation: 'install',
      componentId: 'asr.whisper-base-q8',
      manifestIdentity: 'a'.repeat(64),
      resourcePolicyIdentity: 'policy-generation-1',
      transaction,
      assertCurrent: () => true,
      async refreshCurrent() {
        return true
      }
    })
    const current = resolveSpeechPackInstallAdmission(admission, 'asr.whisper-base-q8', transaction)
    await assertCurrentSpeechPackInstallAdmission(current)
    expect(current.operation).toBe('install')
    expect(current.manifestIdentity).toBe('a'.repeat(64))
    expect(() => resolveSpeechPackInstallAdmission(admission, 'asr.parakeet-tdt-0.6b-v3-int8', transaction)).toThrow(
      'SPEECH_PACK_INSTALL_ADMISSION_MISMATCH'
    )
    expect(() =>
      resolveSpeechPackInstallAdmission(admission, 'asr.whisper-base-q8', Symbol('other-transaction'))
    ).toThrow('SPEECH_PACK_INSTALL_ADMISSION_MISMATCH')
  })

  it('expires when the captured consent authority changes', async () => {
    let current = true
    const transaction = Symbol('repair')
    const admission = createSpeechPackInstallAdmission({
      operation: 'repair',
      componentId: 'asr.parakeet-tdt-0.6b-v3-int8',
      manifestIdentity: 'b'.repeat(64),
      resourcePolicyIdentity: 'policy-generation-2',
      transaction,
      assertCurrent: () => current,
      async refreshCurrent() {
        return current
      }
    })
    const resolved = resolveSpeechPackInstallAdmission(admission, 'asr.parakeet-tdt-0.6b-v3-int8', transaction)
    current = false
    expect(() => resolved.assertCurrent()).toThrow('SPEECH_PACK_INSTALL_ADMISSION_EXPIRED')
    await expect(assertCurrentSpeechPackInstallAdmission(resolved)).rejects.toThrow(
      'SPEECH_PACK_INSTALL_ADMISSION_EXPIRED'
    )
  })

  it('rejects a structurally forged resolved capability', async () => {
    await expect(
      assertCurrentSpeechPackInstallAdmission({
        operation: 'install',
        componentId: 'asr.whisper-base-q8',
        manifestIdentity: 'c'.repeat(64),
        resourcePolicyIdentity: 'policy-generation-3',
        transaction: Symbol('forged'),
        assertCurrent() {},
        async assertCurrentAsync() {}
      } as CurrentSpeechPackInstallAdmission)
    ).rejects.toThrow('SPEECH_PACK_INSTALL_ADMISSION_INVALID')
  })
})
