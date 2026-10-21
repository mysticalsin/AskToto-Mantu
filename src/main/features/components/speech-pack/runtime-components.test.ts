import { describe, expect, it } from 'vitest'
import type { PackageInventoryV1, PackageRuntimeContract } from './package-contract'
import {
  OPTIONAL_RUNTIME_COMPONENTS,
  resolveOptionalRuntimeReadiness,
  type OptionalRuntimeComponentId,
  type OptionalRuntimeHostFacts
} from './runtime-components'

const host: OptionalRuntimeHostFacts = {
  platform: 'darwin',
  arch: 'arm64',
  electronVersion: '43.6.0',
  nodeAbi: '140',
  napiVersion: '10',
  chromiumVersion: '140.0.0.0'
}

function verified(over: Partial<PackageInventoryV1> = {}, profile: 'full' | 'lean' = 'full'): PackageRuntimeContract {
  return {
    status: 'verified',
    profile,
    inventory: {
      schema: 1,
      profile,
      platform: 'darwin',
      arch: 'arm64',
      appVersion: '2.1.0',
      electronVersion: '43.6.0',
      sourceCommit: 'a'.repeat(40),
      coreFiles: [],
      identity: 'b'.repeat(64),
      ...over
    }
  }
}

const IDS = OPTIONAL_RUNTIME_COMPONENTS.map((item) => item.id) as OptionalRuntimeComponentId[]

describe('optional runtime readiness against the running target', () => {
  it.each(IDS)('%s is ready only when platform, architecture and Electron ABI match the host', (id) => {
    expect(resolveOptionalRuntimeReadiness(id, verified(), host)).toBe('ready')
  })

  it.each(IDS)('%s is incompatible for a wrong-architecture package', (id) => {
    expect(resolveOptionalRuntimeReadiness(id, verified({ arch: 'x64' }), host)).toBe('incompatible')
  })

  it.each(IDS)('%s is incompatible for a wrong-platform package', (id) => {
    expect(resolveOptionalRuntimeReadiness(id, verified({ platform: 'win32' }), host)).toBe('incompatible')
  })

  it.each(IDS)('%s is incompatible for a package built against another Electron ABI', (id) => {
    expect(resolveOptionalRuntimeReadiness(id, verified({ electronVersion: '42.0.0' }), host)).toBe('incompatible')
  })

  it('accepts a universal package on either architecture', () => {
    const universal = verified({ arch: 'universal' })
    expect(resolveOptionalRuntimeReadiness('runtime.llama-server', universal, host)).toBe('ready')
    expect(
      resolveOptionalRuntimeReadiness('runtime.llama-server', universal, {
        ...host,
        arch: 'x64'
      })
    ).toBe('ready')
  })

  it('treats an invalid package contract, including a target mismatch, as incompatible', () => {
    const invalid: PackageRuntimeContract = {
      status: 'invalid',
      reason: 'target-mismatch',
      profile: null,
      inventory: null
    }
    expect(resolveOptionalRuntimeReadiness('runtime.asr-sherpa-onnx', invalid, host)).toBe('incompatible')
  })

  it('never lets a lean package or a downloaded file make a runtime ready, even on a matching target', () => {
    expect(resolveOptionalRuntimeReadiness('runtime.asr-sherpa-onnx', verified({}, 'lean'), host)).toBe(
      'not-configured'
    )
    expect(OPTIONAL_RUNTIME_COMPONENTS.every((item) => item.artifact === null)).toBe(true)
  })
})
