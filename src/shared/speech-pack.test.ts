import { describe, expect, it } from 'vitest'
import {
  SpeechPackActionRequestSchema,
  SpeechPackActionResultSchema,
  SpeechPackInstallWithPlanRequestSchema,
  SpeechPackPlanPreviewRequestSchema,
  SpeechPackProgressSchema,
  SpeechPackSnapshotSchema
} from './speech-pack'

const identity = 'a'.repeat(64)
const componentId = 'asr.whisper-base-q8' as const
const row = {
  componentId,
  manifestIdentity: identity,
  version: '1',
  state: 'not-installed',
  downloadBytes: 100,
  installedBytes: 200,
  sourceHost: 'huggingface.co',
  integrity: 'not-verified'
}
const snapshot = {
  featureEnabled: true,
  profile: 'lean',
  profileError: null,
  selectedEngine: 'whisper',
  selectedComponent: componentId,
  packageProfile: {
    status: 'verified',
    profile: 'lean',
    identity,
    platform: 'darwin',
    arch: 'arm64',
    reason: null
  },
  engineReadiness: {
    engine: 'whisper',
    state: 'not-configured',
    modelComponentId: componentId,
    runtimeComponentIds: ['runtime.asr-whisper-worker']
  },
  optionalRuntimeReadiness: { speakerEmbedding: 'not-configured', localLlm: 'not-configured' },
  components: [row],
  progress: null
}

describe('speech pack boundary', () => {
  it('requires an explicit action and the displayed immutable manifest identity', () => {
    for (const action of ['download', 'pause', 'cancel', 'retry', 'repair']) {
      expect(SpeechPackActionRequestSchema.safeParse({ componentId, action, manifestIdentity: identity }).success).toBe(
        true
      )
    }
    for (const value of [
      { componentId, action: 'download' },
      { componentId, action: 'download', manifestIdentity: 'latest' },
      { componentId, action: 'download', manifestIdentity: identity, url: 'https://example.com' },
      { componentId: 'unknown', action: 'download', manifestIdentity: identity }
    ])
      expect(SpeechPackActionRequestSchema.safeParse(value).success).toBe(false)
  })

  it('accepts configured status and explicitly unavailable source/profile states', () => {
    expect(SpeechPackSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(
      SpeechPackSnapshotSchema.safeParse({ ...snapshot, profile: null, profileError: 'invalid-profile' }).success
    ).toBe(true)
    expect(
      SpeechPackSnapshotSchema.safeParse({
        ...snapshot,
        components: [{ ...row, sourceHost: null, state: 'not-configured' }]
      }).success
    ).toBe(true)
  })

  it('binds plan preview and execution to opaque main-owned plan identities', () => {
    expect(SpeechPackPlanPreviewRequestSchema.safeParse({ componentId, manifestIdentity: identity }).success).toBe(true)
    expect(
      SpeechPackPlanPreviewRequestSchema.safeParse({ componentId, manifestIdentity: identity, action: 'repair' }).success
    ).toBe(true)
    expect(SpeechPackPlanPreviewRequestSchema.safeParse({ componentId, manifestIdentity: identity, url: 'https://x' }).success).toBe(
      false
    )
    expect(SpeechPackInstallWithPlanRequestSchema.safeParse({ planId: 'not-a-uuid', action: 'install' }).success).toBe(
      false
    )
  })

  it('rejects duplicate components, wrong selected engine and contradictory profiles', () => {
    for (const value of [
      { ...snapshot, components: [row, row] },
      { ...snapshot, selectedEngine: 'parakeet' },
      { ...snapshot, selectedEngine: 'apple' },
      { ...snapshot, profile: null },
      { ...snapshot, profileError: 'invalid-profile' },
      { ...snapshot, components: [{ ...row, sourceHost: 'https://huggingface.co/path' }] },
      { ...snapshot, components: [{ ...row, sourceHost: null }] },
      { ...snapshot, components: [{ ...row, state: 'ready' }] },
      { ...snapshot, privatePath: '/private/model' }
    ])
      expect(SpeechPackSnapshotSchema.safeParse(value).success).toBe(false)
  })

  it('bounds transfer/disk counters without coercion or nonfinite values', () => {
    const progress = { componentId, manifestIdentity: identity, bytesDone: 1, bytesTotal: 100, state: 'downloading' }
    expect(SpeechPackProgressSchema.safeParse(progress).success).toBe(true)
    for (const bytesDone of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1', 101]) {
      expect(SpeechPackProgressSchema.safeParse({ ...progress, bytesDone }).success).toBe(false)
    }
    for (const freeBytes of [-1, Infinity, 1.1, '100']) {
      expect(SpeechPackSnapshotSchema.safeParse({ ...snapshot, components: [{ ...row, freeBytes }] }).success).toBe(
        false
      )
    }
    expect(
      SpeechPackSnapshotSchema.safeParse({ ...snapshot, progress: { ...progress, manifestIdentity: 'b'.repeat(64) } })
        .success
    ).toBe(false)
  })

  it('returns finite failures without leaking arbitrary native errors', () => {
    expect(SpeechPackActionResultSchema.safeParse({ ok: true }).success).toBe(true)
    expect(SpeechPackActionResultSchema.safeParse({ ok: false, reason: 'not-configured' }).success).toBe(true)
    for (const value of [
      { ok: false },
      { ok: false, reason: 'native stack' },
      { ok: true, reason: 'busy' },
      { ok: false, reason: 'busy', error: '/private/path' }
    ]) {
      expect(SpeechPackActionResultSchema.safeParse(value).success).toBe(false)
    }
  })
})
