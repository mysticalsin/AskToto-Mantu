import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpeechPackProfileRead } from './features/components'

export interface AsrMetadataReadinessOptions {
  profile: SpeechPackProfileRead
  packaged: boolean
  selectedEngine: 'whisper' | 'parakeet' | 'apple'
  bundledRoot: string
  bundledParakeetDir: string
  userDataParakeetDir: string
  bundledModelsRoot: string
  userDataModelsRoot: string
  parakeetFiles: readonly string[]
  whisperFloorId: string
  whisperFloorFiles: readonly string[]
  manifestComplete: (root: string) => boolean
  resolveLeanComponent: (engine: 'whisper' | 'parakeet') => Promise<boolean>
}

async function metadataFilesPresent(paths: readonly string[]): Promise<boolean> {
  return (
    await Promise.all(
      paths.map(async (path) => {
        try {
          const info = await lstat(path)
          return info.isFile() && info.nlink === 1 && info.size > 0
        } catch {
          return false
        }
      })
    )
  ).every(Boolean)
}

async function parakeetReady(options: AsrMetadataReadinessOptions, dir: string): Promise<boolean> {
  if (options.profile.profile === 'lean') {
    return options.selectedEngine === 'parakeet' ? options.resolveLeanComponent('parakeet') : false
  }
  return metadataFilesPresent(options.parakeetFiles.map((name) => join(dir, name)))
}

async function whisperFloorReady(options: AsrMetadataReadinessOptions, root: string): Promise<boolean> {
  if (options.profile.profile === 'lean') {
    return options.selectedEngine === 'whisper' ? options.resolveLeanComponent('whisper') : false
  }
  const dir = join(root, ...options.whisperFloorId.split('/'))
  return metadataFilesPresent(options.whisperFloorFiles.map((name) => join(dir, name)))
}

/** Cheap selected-engine Whisper readiness; metadata presence is not model integrity evidence. */
export async function whisperMetadataStatusReady(options: AsrMetadataReadinessOptions): Promise<boolean> {
  if (options.profile.profile === null) return false
  if (options.profile.profile === 'lean') {
    return options.selectedEngine === 'whisper' ? options.resolveLeanComponent('whisper') : false
  }
  if (options.packaged) return whisperFloorReady(options, options.bundledModelsRoot)
  if (await whisperFloorReady(options, options.bundledModelsRoot)) return true
  return whisperFloorReady(options, options.userDataModelsRoot)
}

/** Cheap status-only metadata checks. Operational model gates keep their content validation separately. */
export async function parakeetMetadataStatusReady(options: AsrMetadataReadinessOptions): Promise<boolean> {
  if (options.profile.profile === null) return false
  if (options.profile.profile === 'lean') return parakeetReady(options, '')
  if (options.packaged) return parakeetReady(options, options.bundledParakeetDir)
  if (await parakeetReady(options, options.bundledParakeetDir)) return true
  return parakeetReady(options, options.userDataParakeetDir)
}

/** Cheap bundled-ASR status without opening model files or treating that status as integrity evidence. */
export async function asrMetadataStatusReady(options: AsrMetadataReadinessOptions): Promise<boolean> {
  if (options.profile.profile === null) return false
  if (options.profile.profile === 'lean') {
    if (options.selectedEngine === 'apple') return true
    return options.resolveLeanComponent(options.selectedEngine)
  }
  if (options.packaged) {
    return (await parakeetReady(options, options.bundledParakeetDir)) && options.manifestComplete(options.bundledRoot)
  }
  const bundledParakeet = await parakeetReady(options, options.bundledParakeetDir)
  const parakeetDir = bundledParakeet ? options.bundledParakeetDir : options.userDataParakeetDir
  const bundledWhisper = await whisperFloorReady(options, options.bundledModelsRoot)
  const whisperRoot = bundledWhisper ? options.bundledModelsRoot : options.userDataModelsRoot
  return (await parakeetReady(options, parakeetDir)) && whisperFloorReady(options, whisperRoot)
}
