import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'
import { emptyModelPolicyEntry, MODEL_POLICY_CAPABILITIES, type ModelPolicyDocument } from '@shared/model-policy'
import { provisionExplicitLocalModel, provisionLocalModel } from './local-model-provisioning'

const modelId = 'qwen3.5-0.8b'

describe('optional local-model provisioning compatibility', () => {
  it('does not fetch disabled local AI on automatic boot or setup checks', async () => {
    const ensure = vi.fn(async () => true)
    await expect(provisionLocalModel({ enabled: false, modelId: 'qwen3.5-4b' }, null, ensure)).resolves.toBe(false)
    expect(ensure).not.toHaveBeenCalled()
  })

  it.each(['automatic', 'explicit'] as const)('respects organization restrictions for %s requests', async (trigger) => {
    const ensure = vi.fn(async () => true)
    await expect(
      provisionLocalModel({ enabled: true, modelId: 'qwen3.5-4b' }, ['cloudflare'], ensure, trigger)
    ).resolves.toBe(false)
    expect(ensure).not.toHaveBeenCalled()
  })

  it.each([
    'qwen3.5-0.8b',
    'qwen3.5-4b'
  ])('keeps the selected %s model on an automatic request', async (selectedModel) => {
    const ensure = vi.fn(async () => true)
    await expect(provisionLocalModel({ enabled: true, modelId: selectedModel }, ['local'], ensure)).resolves.toBe(true)
    expect(ensure).toHaveBeenCalledExactlyOnceWith(selectedModel)
  })

  it('allows an explicit download without enabling local inference', async () => {
    const local = { enabled: false, modelId: 'qwen3.5-0.8b' }
    const ensure = vi.fn(async () => true)
    await expect(provisionLocalModel(local, null, ensure, 'explicit')).resolves.toBe(true)
    expect(ensure).toHaveBeenCalledExactlyOnceWith('qwen3.5-0.8b')
    expect(local.enabled).toBe(false)
  })

  it('preserves a failed provisioning verdict', async () => {
    await expect(provisionLocalModel({ enabled: true, modelId: 'qwen3.5-4b' }, null, async () => false)).resolves.toBe(
      false
    )
  })

  it('propagates an unexpected downloader failure to its caller', async () => {
    await expect(
      provisionLocalModel({ enabled: true, modelId: 'qwen3.5-4b' }, null, async () => {
        throw new Error('synthetic disk failure')
      })
    ).rejects.toThrow('synthetic disk failure')
  })
})

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
    configured?: boolean
    beforeEnsure?: () => void
  } = {}
) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    localLlm: { ...DEFAULT_SETTINGS.localLlm, modelId },
    operatorUrl: overrides.configured
      ? 'https://operator.test'
      : overrides.status === 'unconfigured'
        ? ''
        : 'https://operator.test',
    operatorIngestSecret: overrides.status === 'unconfigured' ? '' : 'configured',
    operatorLicenseToken: '',
    enterpriseLive: { ...DEFAULT_SETTINGS.enterpriseLive, managed: false, inferenceMode: 'legacy' }
  }
  let reads = 0
  let captureIdentity = 'capture:0'
  let proofIdentity = overrides.status === 'unconfigured' ? 'proof:1:unconfigured' : 'proof:1:policy-a'
  const ensure = vi.fn(async (_id: string, authorize: () => Promise<boolean>, validateCurrent: () => boolean) => {
    overrides.beforeEnsure?.()
    return (await authorize()) && validateCurrent()
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
      currentModelPolicyIdentity: () => proofIdentity,
      readSettings: async () => {
        reads++
        const status: NonNullable<typeof overrides.status> = overrides.status ?? 'managed'
        return {
          settings,
          readable: true,
          allowedProviders: null,
          modelPolicy:
            status === 'managed'
              ? { status, identity: proofIdentity, policy: policy() }
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
    },
    changeProofIdentity(identity: string) {
      proofIdentity = identity
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

  it('rejects a signed policy change after the initial decision and before transfer', async () => {
    let context: ReturnType<typeof setup>
    context = setup({ beforeEnsure: () => context.changeProofIdentity('proof:2:policy-b') })
    await expect(provisionExplicitLocalModel(context.options)).resolves.toBe(false)
    expect(context.ensure).toHaveBeenCalledOnce()
    expect(context.onReady).not.toHaveBeenCalled()
  })

  it('allows legacy unmanaged settings only without configured enterprise policy', async () => {
    const context = setup({ status: 'unconfigured' })
    await expect(provisionExplicitLocalModel(context.options)).resolves.toBe(true)
    expect(context.ensure).toHaveBeenCalledOnce()
  })

  it('denies an unconfigured proof status when an Operator URL is present', async () => {
    const context = setup({ status: 'unconfigured', configured: true })
    await expect(provisionExplicitLocalModel(context.options)).resolves.toBe(false)
    expect(context.ensure).not.toHaveBeenCalled()
  })
})
