import { describe, expect, it, vi } from 'vitest'
import { LOCAL_MODELS } from '../../../llm/local-models'
import type { PackageInventoryV1, PackageRuntimeContract } from './package-contract'
import { OPTIONAL_COMPONENT_DESCRIPTORS, descriptorFor } from './optional-component-descriptors'
import { resolveOptionalComponents, type OptionalComponentId } from './optional-components'
import { componentDownloadBytes, PARAKEET_TDT_V3_INT8, WHISPER_BASE_Q8 } from './manifest'
import type { OptionalRuntimeHostFacts } from './runtime-components'
import { runtimeIdsForEngine, runtimeIdsForLocalLlm } from './runtime-components'
import { OptionalComponentStatusSchema } from '../../../../shared/speech-pack'

vi.mock('electron')

const host: OptionalRuntimeHostFacts = {
  platform: 'darwin',
  arch: 'arm64',
  electronVersion: '43.6.0',
  nodeAbi: '140',
  napiVersion: '10',
  chromiumVersion: '140.0.0.0'
}

function inventory(profile: 'full' | 'lean', over: Partial<PackageInventoryV1> = {}): PackageInventoryV1 {
  return {
    schema: 1,
    profile,
    platform: 'darwin',
    arch: 'arm64',
    appVersion: '2.12.0',
    electronVersion: '43.6.0',
    sourceCommit: 'a'.repeat(40),
    coreFiles: [],
    identity: 'b'.repeat(64),
    ...over
  }
}

const legacyFull: PackageRuntimeContract = { status: 'legacy-full', profile: 'full', inventory: null }
const development: PackageRuntimeContract = { status: 'development', profile: 'development', inventory: null }
const lean = (over: Partial<PackageInventoryV1> = {}): PackageRuntimeContract => ({
  status: 'verified',
  profile: 'lean',
  inventory: inventory('lean', over)
})
const verifiedFull = (over: Partial<PackageInventoryV1> = {}): PackageRuntimeContract => ({
  status: 'verified',
  profile: 'full',
  inventory: inventory('full', over)
})
const invalid: PackageRuntimeContract = {
  status: 'invalid',
  reason: 'inventory-invalid',
  profile: null,
  inventory: null
}

function byId(contract: PackageRuntimeContract, installed: OptionalComponentId[] = []) {
  const rows = resolveOptionalComponents({ contract, host, installed: new Set(installed) })
  return Object.fromEntries(rows.map((row) => [row.id, row])) as Record<OptionalComponentId, (typeof rows)[number]>
}

describe('optional component descriptors (G11)', () => {
  it('describe the local LLM, Whisper and Parakeet, each on-device with provider, host, size and consent', () => {
    expect(OPTIONAL_COMPONENT_DESCRIPTORS.map((item) => item.id)).toEqual(['local-llm', 'whisper', 'parakeet'])
    for (const descriptor of OPTIONAL_COMPONENT_DESCRIPTORS) {
      expect(descriptor.privacy).toBe('on-device')
      expect(descriptor.provider.length).toBeGreaterThan(0)
      expect(descriptor.sourceHost).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/)
      expect(descriptor.downloadBytes).toBeGreaterThan(0)
      expect(descriptor.installedBytes).toBeGreaterThanOrEqual(descriptor.downloadBytes)
      expect(descriptor.offer.consent).toBe('required')
    }
  })

  it('D-12: Parakeet is offered at the first hold; the other components are offered from Settings', () => {
    expect(descriptorFor('parakeet').offer.surface).toBe('first-hold')
    expect(descriptorFor('whisper').offer.surface).toBe('settings')
    expect(descriptorFor('local-llm').offer.surface).toBe('settings')
  })

  it('takes the speech sizes from the pinned manifests so they cannot drift', () => {
    expect(descriptorFor('whisper').downloadBytes).toBe(componentDownloadBytes(WHISPER_BASE_Q8))
    expect(descriptorFor('parakeet').downloadBytes).toBe(componentDownloadBytes(PARAKEET_TDT_V3_INT8))
    expect(descriptorFor('whisper').modelComponentId).toBe(WHISPER_BASE_Q8.id)
    expect(descriptorFor('parakeet').modelComponentId).toBe(PARAKEET_TDT_V3_INT8.id)
  })

  it('pins the local LLM to the reviewed compact model and projector sizes', () => {
    const entry = LOCAL_MODELS.find((model) => model.id === descriptorFor('local-llm').localModelId)
    expect(entry).toBeDefined()
    expect(descriptorFor('local-llm').downloadBytes).toBe((entry?.gguf.bytes ?? 0) + (entry?.mmproj.bytes ?? 0))
  })

  it('is the single source for which runtimes an engine or the local LLM needs', () => {
    expect(runtimeIdsForEngine('whisper')).toEqual(descriptorFor('whisper').runtimeIds)
    expect(runtimeIdsForEngine('parakeet')).toEqual(descriptorFor('parakeet').runtimeIds)
    expect(runtimeIdsForEngine('apple')).toEqual([])
    expect(runtimeIdsForLocalLlm()).toEqual(descriptorFor('local-llm').runtimeIds)
  })
})

describe('optional component presence (G11)', () => {
  it('detects the models a 1.9.x full install already carries and keeps them usable', () => {
    for (const contract of [legacyFull, verifiedFull()]) {
      for (const row of Object.values(byId(contract))) {
        expect(row.presence).toBe('bundled')
        expect(row.blockedBy).toBeNull()
        expect(row.installable).toBe(false)
      }
    }
  })

  it('a lean package ships none of them: absent, and honest that no reviewed runtime can be installed yet', () => {
    for (const row of Object.values(byId(lean()))) {
      expect(row.presence).toBe('absent')
      expect(row.blockedBy).toBe('runtime-not-published')
      expect(row.installable).toBe(false)
    }
  })

  it('a lean package that already holds a verified speech model reports the model, not a usable component', () => {
    const rows = byId(lean(), ['whisper'])
    expect(rows.whisper.presence).toBe('model-only')
    expect(rows.whisper.installable).toBe(false)
    expect(rows.parakeet.presence).toBe('absent')
  })

  it('a development run with nothing installed can install; with a model installed it reports installed', () => {
    expect(byId(development).parakeet).toMatchObject({ presence: 'absent', blockedBy: null, installable: true })
    expect(byId(development, ['parakeet']).parakeet).toMatchObject({ presence: 'installed', installable: false })
  })

  it('reports a wrong-target package as incompatible rather than ready', () => {
    const rows = byId(verifiedFull({ arch: 'x64' }))
    for (const row of Object.values(rows)) {
      expect(row.blockedBy).toBe('package-incompatible')
      expect(row.installable).toBe(false)
    }
  })

  it('fails closed for an invalid package contract', () => {
    for (const row of Object.values(byId(invalid))) {
      expect(row.blockedBy).toBe('package-invalid')
      expect(row.installable).toBe(false)
    }
  })

  it('every row satisfies the shared IPC schema and carries size, provider and privacy', () => {
    for (const contract of [legacyFull, development, lean(), invalid]) {
      for (const row of resolveOptionalComponents({ contract, host, installed: new Set() })) {
        expect(() => OptionalComponentStatusSchema.parse(row)).not.toThrow()
        expect(row.downloadBytes).toBeGreaterThan(0)
        expect(row.provider.length).toBeGreaterThan(0)
        expect(row.privacy).toBe('on-device')
      }
    }
  })
})
