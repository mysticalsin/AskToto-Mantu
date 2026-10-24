import { randomUUID } from 'node:crypto'
import { lstat, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpeechPackComponentId } from '../speech-pack/manifest'
import type { SpeechPackService } from '../speech-pack/service'
import { pathPresent, realInside, sweepAside, treeBytes } from './fs-evict'
import type { OffloadTarget } from './service'

/** A speech model pack: the engine owns the layout, the queue fence and the delete (engine.evict). */
export function createSpeechPackTarget(options: {
  service: Pick<SpeechPackService, 'evictSpeechComponent'>
  rootDir: string
  componentId: SpeechPackComponentId
}): OffloadTarget {
  return {
    // The engine reports busy itself, inside the same fence that guards installs.
    busy: () => false,
    evict: () => options.service.evictSpeechComponent(options.componentId),
    async verifyAbsent() {
      return !(await pathPresent(join(options.rootDir, options.componentId)))
    },
    // Cold: no engine is built; this heals an offload that crashed between its rename and its delete.
    sweep: () => sweepAside(join(options.rootDir, '.staging', options.componentId), 'evict-')
  }
}

/**
 * The downloaded local LLM weights under `modelsRoot()/<modelId>`. The path comes from the closed model id and the
 * main-process root, never from the renderer. The runtime is stopped first so no process holds the files open.
 */
export function createLocalModelTarget(options: {
  modelsRoot: () => string
  modelId: string
  downloading: () => boolean
  stopRuntime: () => void
}): OffloadTarget {
  const dir = (): string => join(options.modelsRoot(), options.modelId)
  return {
    busy: () => options.downloading(),
    async evict() {
      if (options.downloading()) return { ok: false, reason: 'busy' }
      const target = dir()
      let info
      try {
        info = await lstat(target)
      } catch (error) {
        return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'failed' }
      }
      if (!info.isDirectory() || info.isSymbolicLink() || !(await realInside(options.modelsRoot(), target)))
        return { ok: false, reason: 'failed' }
      try {
        if ((await readdir(target)).length === 0) return { ok: false, reason: 'absent' }
        options.stopRuntime()
        const bytesFreed = await treeBytes(target)
        const aside = join(options.modelsRoot(), `.evict-${randomUUID()}`)
        await rename(target, aside)
        await rm(aside, { recursive: true, force: true })
        return { ok: true, bytesFreed }
      } catch {
        return { ok: false, reason: 'failed' }
      }
    },
    async verifyAbsent() {
      return !(await pathPresent(dir()))
    },
    sweep: () => sweepAside(options.modelsRoot(), '.evict-')
  }
}
