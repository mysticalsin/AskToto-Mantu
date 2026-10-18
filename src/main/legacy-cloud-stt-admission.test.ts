import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'
import type { SettingsPolicyAuthoritySnapshot } from './settings-observation'
import type { ManagedSpeechPolicyRead } from './managed-speech-providers'
import { legacyCloudSttAdmission } from './legacy-cloud-stt-policy'

const ABSENT_POLICY: ManagedSpeechPolicyRead = { state: 'absent' }

function authority(patch: {
  readable?: boolean
  settings?: Partial<Settings>
  allowedProviders?: string[] | null
  lockedKeys?: string[]
} = {}): SettingsPolicyAuthoritySnapshot {
  return {
    settings: { ...DEFAULT_SETTINGS, ...patch.settings } as Settings,
    readable: patch.readable ?? true,
    epoch: 1,
    allowedProviders: patch.allowedProviders ?? null,
    localSpeechPack: null,
    lockedKeys: patch.lockedKeys ?? []
  }
}

describe('legacy cloud STT authority admission', () => {
  it('keeps an unmanaged, readable legacy profile operational', () => {
    expect(legacyCloudSttAdmission(authority(), ABSENT_POLICY)).toEqual({ ok: true })
  })

  it.each([
    ['unreadable settings', authority({ readable: false }), ABSENT_POLICY],
    [
      'managed legacy profile',
      authority({ settings: { enterpriseLive: { managed: true, inferenceMode: 'legacy', summaryOnly: false } } }),
      ABSENT_POLICY
    ],
    [
      'managed cloud-only profile',
      authority({ settings: { enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true } } }),
      ABSENT_POLICY
    ],
    [
      'broker route',
      authority({ settings: { brokerSpeech: { transport: 'broker-v1', engine: 'deepgram-nova3' } } }),
      ABSENT_POLICY
    ],
    [
      'refused broker profile',
      authority({ settings: { brokerSpeech: { transport: 'refused', engine: 'unconfigured', reason: 'INVALID_PROFILE' } } }),
      ABSENT_POLICY
    ],
    ['managed provider allowlist', authority({ allowedProviders: ['openai'] }), ABSENT_POLICY],
    ['managed speech-provider policy', authority(), { state: 'valid', providers: { state: 'valid', providers: ['deepgram-nova3'] }, egressAllowlist: null }],
    ['invalid speech policy', authority(), { state: 'invalid' }],
    ['locked legacy provider', authority({ lockedKeys: ['cloudSttProvider'] }), ABSENT_POLICY],
    ['locked broker route', authority({ lockedKeys: ['brokerSpeech'] }), ABSENT_POLICY]
  ])('refuses %s', (_name, current, policy) => {
    expect(legacyCloudSttAdmission(current as SettingsPolicyAuthoritySnapshot, policy as ManagedSpeechPolicyRead)).toMatchObject({
      ok: false,
      code: 'APPROVED_GATEWAY_REQUIRED'
    })
  })

  it('wires admission before owner mutation and rechecks authority after session stop before credentials', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    const start = source.indexOf('ipcMain.handle(IPC.cloudSttStart')
    const stop = source.indexOf('ipcMain.handle(IPC.cloudSttStop')
    expect(start).toBeGreaterThan(-1)
    expect(stop).toBeGreaterThan(start)
    const handler = source.slice(start, stop)
    expect(handler.indexOf('await readLegacyCloudSttAdmission()')).toBeLessThan(handler.indexOf('setCloudSttIpcOwner(owner)'))
    expect(handler).toMatch(/start:\s*async\s*\(\)\s*=>/)
    const startCallback = handler.slice(handler.indexOf('start: async'))
    expect(startCallback.indexOf('await readLegacyCloudSttAdmission()')).toBeLessThan(
      startCallback.indexOf("getApiKey('cloudflare')")
    )
    expect(startCallback.indexOf('isCurrentCloudSttOwner(owner, e.sender)')).toBeLessThan(
      startCallback.indexOf("getApiKey('cloudflare')")
    )
  })
})
