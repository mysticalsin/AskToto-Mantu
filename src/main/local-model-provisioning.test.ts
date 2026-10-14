import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'
import { emptyModelPolicyEntry, MODEL_POLICY_CAPABILITIES, type ModelPolicyDocument } from '@shared/model-policy'
import { provisionExplicitLocalModel } from './local-model-provisioning'

const modelId = 'qwen3.5-0.8b'

function policy(): ModelPolicyDocument {
  const capabilities = Object.fromEntries(
    MODEL_POLICY_CAPABILITIES.map((capability) => [capability, emptyModelPolicyEntry('anthropic', 'claude-sonnet-4-6')])
  ) as ModelPolicyDocument['capabilities']
  capabilities.localModel = emptyModelPolicyEntry('local', modelId)
  return {
    version: 10,
    updatedAt: 10,
    updatedBy: 'owner@example.test',
    localSpeechPack: 'offered',
    capabilities
  }
}

function setup(
  overrides: {
    captureActive?: () => boolean
    status?: 'managed' | 'unmanaged' | 'unverified' | 'unconfigured'
    beforeEnsure?: () => void
  } = {}
) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    localLlm: { ...DEFAULT_SETTINGS.localLlm, modelId },
    operatorUrl: overrides.status === 'unconfigured' ? '' : 'https://operator.test',
    operatorIngestSecret: overrides.status === 'unconfigured' ? '' : 'configured',
    operatorLicenseToken: '',
    enterpriseLive: { ...DEFAULT_SETTINGS.enterpriseLive, managed: false, inferenceMode: 'legacy' }
  }
  let reads = 0
  let captureIdentity = 'capture:0'
  const ensure = vi.fn(async (_id: string, authorize: () => Promise<boolean>) => {
    overrides.beforeEnsure?.()
    return authorize()
  })
  const onReady = vi.fn()
  const captureActive = overrides.captureActive ?? (() => false)
  return {
    ensure,
    onReady,
    options: {
      runtimeAvailable: async () => true,
      captureActive,
      captureIdentity: () => captureIdentity,
      localModelIdentity: () => 'local-model:0',
      readSettings: async () => {
        reads++
        const status: NonNullable<typeof overrides.status> = overrides.status ?? 'managed'
        return {
          settings,
          readable: true,
          allowedProviders: null,
          modelPolicy:
            status === 'managed'
              ? { status, identity: 'proof:1:policy-a', policy: policy() }
              : { status, identity: `proof:1:${status}` }
        }
      },
      ensure,
      onReady
    },
    get reads() {
      return reads
    },
    changeCaptureIdentity(identity: string) {
      captureIdentity = identity
    }
  }
}

describe('explicit local model authority', () => {
  it('allows a full runtime with the current signed localModel capability', async () => {
    const context = setup()
    await expect(provisionExplicitLocalModel(context.options)).resolves.toBe(true)
    expect(context.ensure).toHaveBeenCalledOnce()
    expect(context.onReady).toHaveBeenCalledOnce()
    expect(context.reads).toBeGreaterThanOrEqual(3)
  })

  it('fails closed for configured but unverified model policy', async () => {
    const context = setup({ status: 'unverified' })
    await expect(provisionExplicitLocalModel(context.options)).resolves.toBe(false)
    expect(context.ensure).not.toHaveBeenCalled()
    expect(context.onReady).not.toHaveBeenCalled()
  })

  it('does not transfer while capture is active', async () => {
    const context = setup({ captureActive: () => true })
    await expect(provisionExplicitLocalModel(context.options)).resolves.toBe(false)
    expect(context.ensure).not.toHaveBeenCalled()
  })

  it('rejects an off-on capture epoch change before the downloader starts', async () => {
    let context: ReturnType<typeof setup>
    context = setup({ beforeEnsure: () => context.changeCaptureIdentity('capture:2') })
    await expect(provisionExplicitLocalModel(context.options)).resolves.toBe(false)
    expect(context.ensure).toHaveBeenCalledOnce()
    expect(context.onReady).not.toHaveBeenCalled()
  })

  it('allows legacy unmanaged settings only without configured enterprise policy', async () => {
    const context = setup({ status: 'unconfigured' })
    await expect(provisionExplicitLocalModel(context.options)).resolves.toBe(true)
    expect(context.ensure).toHaveBeenCalledOnce()
  })
})
