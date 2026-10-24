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

describe('optional component failures and removal (G87)', () => {
  type Facts = Parameters<typeof resolveOptionalComponents>[0]
  const resolved = (contract: PackageRuntimeContract, over: Partial<Facts> = {}) => {
    const rows = resolveOptionalComponents({ contract, host, installed: new Set(), ...over })
    return Object.fromEntries(rows.map((row) => [row.id, row])) as Record<OptionalComponentId, (typeof rows)[number]>
  }
  const localModel = (over: Partial<NonNullable<Facts['localModel']>> = {}): NonNullable<Facts['localModel']> => ({
    downloaded: true,
    source: 'download',
    reason: null,
    runtimeState: 'stopped',
    ...over
  })

  it('insufficient disk, digest repair, incompatible target and startup failure are distinct failures', () => {
    const disk = resolved(development, {
      speechRows: [{ componentId: WHISPER_BASE_Q8.id, state: 'error', requiredBytes: 900, freeBytes: 100 }]
    })
    const repair = resolved(development, { speechRows: [{ componentId: WHISPER_BASE_Q8.id, state: 'repair-needed' }] })
    const failed = resolved(development, { speechRows: [{ componentId: WHISPER_BASE_Q8.id, state: 'error' }] })
    const incompatible = resolved(verifiedFull({ arch: 'x64' }))
    const startup = resolved(development, { localModel: localModel({ runtimeState: 'unavailable' }) })
    expect(disk.whisper.failure).toBe('insufficient-disk')
    expect(repair.whisper.failure).toBe('repair-needed')
    expect(failed.whisper.failure).toBe('download-failed')
    expect(incompatible.whisper.failure).toBe('incompatible-target')
    expect(startup['local-llm'].failure).toBe('startup-failed')
    expect(resolved(invalid).whisper.failure).toBe('package-invalid')
    expect(resolved(lean()).whisper.failure).toBe('runtime-not-published')
    expect(resolved(development).whisper.failure).toBeNull()
  })

  it('maps local model unavailable reasons to their own failure modes', () => {
    const modeFor = (reason: NonNullable<Facts['localModel']>['reason']) =>
      resolved(development, { localModel: localModel({ downloaded: false, reason }) })['local-llm'].failure
    expect(modeFor('insufficient-ram')).toBe('insufficient-ram')
    expect(modeFor('insufficient-disk')).toBe('insufficient-disk')
    expect(modeFor('download-failed')).toBe('download-failed')
    expect(modeFor('invalid-bundle')).toBe('repair-needed')
    expect(modeFor('downloading')).toBeNull()
    expect(modeFor('not-downloaded')).toBeNull()
  })

  it('a downloaded local model reports installed and removable', () => {
    const row = resolved(development, { localModel: localModel() })['local-llm']
    expect(row.presence).toBe('installed')
    expect(row.removable).toBe(true)
    expect(row.removableBytes).toBe(descriptorFor('local-llm').installedBytes)
    expect(OptionalComponentStatusSchema.safeParse(row).success).toBe(true)
    const modelOnly = resolved(lean(), { localModel: localModel() })['local-llm']
    expect(modelOnly.presence).toBe('model-only')
    expect(modelOnly.removable).toBe(true)
  })

  it('a bundled component is never removable', () => {
    for (const contract of [legacyFull, verifiedFull()]) {
      for (const row of Object.values(resolved(contract, { installed: new Set(['whisper', 'parakeet']) }))) {
        expect(row.removable).toBe(false)
      }
    }
    const packaged = resolved(development, { localModel: localModel({ source: 'bundled' }) })['local-llm']
    expect(packaged.removable).toBe(false)
    expect(resolved(development).whisper.removable).toBe(false)
  })

  it('model-only speech is removable', () => {
    const rows = resolved(lean(), { installed: new Set(['whisper']) })
    expect(rows.whisper.presence).toBe('model-only')
    expect(rows.whisper.removable).toBe(true)
    expect(rows.whisper.removableBytes).toBe(descriptorFor('whisper').installedBytes)
    expect(rows.parakeet.removable).toBe(false)
  })
})
