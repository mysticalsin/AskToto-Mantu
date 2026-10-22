import { descriptorFor } from './optional-component-descriptors'
import type { PackageRuntimeContract } from './package-contract'

export type OptionalRuntimeComponentId =
  | 'runtime.asr-whisper-worker'
  | 'runtime.asr-sherpa-onnx'
  | 'runtime.speaker-embedding'
  | 'runtime.llama-server'

export type OptionalRuntimeFeature = 'whisper' | 'parakeet' | 'speaker-embedding' | 'local-llm'
export type OptionalRuntimeHost = 'renderer-worker' | 'utility-process' | 'child-process'
export type OptionalRuntimeAbiKind = 'renderer-chromium' | 'electron-native-addon' | 'platform-executable'

export interface OptionalRuntimeComponent {
  readonly id: OptionalRuntimeComponentId
  readonly feature: OptionalRuntimeFeature
  readonly host: OptionalRuntimeHost
  readonly abiKind: OptionalRuntimeAbiKind
  readonly dependencies: readonly OptionalRuntimeComponentId[]
  readonly license: null
  /** No upstream executable artifact has passed inventory, license, and signature-provenance review. */
  readonly artifact: null
}

/**
 * Narrow closed registry. Runtime payloads are deliberately unavailable until a reviewed artifact records
 * its exact files, license, target ABI, and signing provenance. Model manifests cannot satisfy these rows.
 */
export const OPTIONAL_RUNTIME_COMPONENTS: readonly OptionalRuntimeComponent[] = [
  {
    id: 'runtime.asr-whisper-worker',
    feature: 'whisper',
    host: 'renderer-worker',
    abiKind: 'renderer-chromium',
    dependencies: [],
    license: null,
    artifact: null
  },
  {
    id: 'runtime.asr-sherpa-onnx',
    feature: 'parakeet',
    host: 'utility-process',
    abiKind: 'electron-native-addon',
    dependencies: [],
    license: null,
    artifact: null
  },
  {
    id: 'runtime.speaker-embedding',
    feature: 'speaker-embedding',
    host: 'utility-process',
    abiKind: 'electron-native-addon',
    dependencies: ['runtime.asr-sherpa-onnx'],
    license: null,
    artifact: null
  },
  {
    id: 'runtime.llama-server',
    feature: 'local-llm',
    host: 'child-process',
    abiKind: 'platform-executable',
    dependencies: [],
    license: null,
    artifact: null
  }
]

export type OptionalRuntimeReadiness = 'ready' | 'not-configured' | 'incompatible'

export interface OptionalRuntimeHostFacts {
  platform: NodeJS.Platform
  arch: string
  electronVersion: string | undefined
  nodeAbi: string | undefined
  napiVersion: string | undefined
  chromiumVersion: string | undefined
}

export interface OptionalRuntimeTarget {
  packageProfileIdentity: string | null
  packagePlatform: 'darwin' | 'win32' | null
  packageArch: 'arm64' | 'x64' | 'universal' | null
  runningPlatform: NodeJS.Platform
  runningArch: string
  appVersion: string | null
  electronVersion: string | undefined
  nodeAbi: string | undefined
  napiVersion: string | undefined
  chromiumVersion: string | undefined
}

export function runtimeHostFacts(): OptionalRuntimeHostFacts {
  return {
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeAbi: process.versions.modules,
    napiVersion: process.versions.napi,
    chromiumVersion: process.versions.chrome
  }
}

/** The runtimes an engine needs, read from the optional component descriptors (Apple Speech has none). */
export function runtimeIdsForEngine(engine: 'whisper' | 'parakeet' | 'apple'): OptionalRuntimeComponentId[] {
  if (engine === 'apple') return []
  return [...descriptorFor(engine).runtimeIds]
}

export function runtimeIdsForLocalLlm(): readonly OptionalRuntimeComponentId[] {
  return descriptorFor('local-llm').runtimeIds
}

export function runtimeTargetFor(
  contract: PackageRuntimeContract,
  appVersion: string,
  host: OptionalRuntimeHostFacts = runtimeHostFacts()
): OptionalRuntimeTarget {
  const inventory = contract.status === 'verified' ? contract.inventory : null
  return {
    packageProfileIdentity: inventory?.identity ?? null,
    packagePlatform: inventory?.platform ?? null,
    packageArch: inventory?.arch ?? null,
    runningPlatform: host.platform,
    runningArch: host.arch,
    appVersion: inventory?.appVersion ?? (contract.status === 'legacy-full' ? appVersion : null),
    electronVersion: host.electronVersion,
    nodeAbi: host.nodeAbi,
    napiVersion: host.napiVersion,
    chromiumVersion: host.chromiumVersion
  }
}

/** Full/development installations keep their established runtime closure. Lean runtime artifacts stay closed. */
export function resolveOptionalRuntimeReadiness(
  componentId: OptionalRuntimeComponentId,
  contract: PackageRuntimeContract,
  host: OptionalRuntimeHostFacts = runtimeHostFacts()
): OptionalRuntimeReadiness {
  if (contract.status === 'invalid') return 'incompatible'
  if (contract.status === 'verified' && contract.profile === 'lean') {
    // No `artifact` entry exists, so a userData file can never make this runtime ready.
    return 'not-configured'
  }
  const inventory = contract.status === 'verified' ? contract.inventory : null
  if (inventory) {
    if (
      inventory.platform !== host.platform ||
      (inventory.arch !== host.arch && inventory.arch !== 'universal') ||
      inventory.electronVersion !== host.electronVersion
    ) {
      return 'incompatible'
    }
  }
  // Full package closure remains governed by the existing packaging and runtime checks.
  return 'ready'
}
