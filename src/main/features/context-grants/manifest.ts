import type { ContextManifest, ContextManifestEntry } from '@shared/context-manifest'

/** Bytes a piece of text takes on the wire; the manifest records sizes, never the text. */
export const utf8Bytes = (text: string | undefined | null): number => (text ? Buffer.byteLength(text, 'utf8') : 0)

export interface ManifestLogDeps {
  /** The owner in force (the memory partition id), or null when nobody is. A manifest is shown only to its owner. */
  owner(): string | null
  now(): number
  /** Turns remembered. Oldest are forgotten first. */
  limit?: number
}

export interface ManifestLog {
  record(turnId: string, entries: readonly ContextManifestEntry[]): ContextManifest
  /**
   * The memory slice (past-meeting knowledge) is applied at provider dispatch, after the manifest was recorded, and again
   * on a retry or a failover. This keeps the turn's one `memory` record in step with what was really sent.
   */
  setMemory(turnId: string, brainContext: string | undefined, sources?: readonly ContextManifestEntry[]): void
  /** The manifest of a turn the current owner ran, or null. */
  get(turnId: string): ContextManifest | null
  clear(): void
}

const DEFAULT_LIMIT = 50

/**
 * The per-turn context manifests (G46): what each Ask or voice turn used, stored beside the turn so the renderer can
 * answer "what did Métis use". In memory only, bounded, content-free, and visible only to the owner that ran the turn.
 */
export function createManifestLog(deps: ManifestLogDeps): ManifestLog {
  const limit = deps.limit ?? DEFAULT_LIMIT
  const turns = new Map<string, { owner: string | null; manifest: ContextManifest }>()
  return {
    record(turnId, entries) {
      const manifest: ContextManifest = {
        turnId,
        createdAt: deps.now(),
        entries: entries.map((e) => ({ ...e })).slice(0, 32)
      }
      turns.delete(turnId)
      turns.set(turnId, { owner: deps.owner(), manifest })
      while (turns.size > limit) {
        const oldest = turns.keys().next().value
        if (oldest === undefined) break
        turns.delete(oldest)
      }
      return manifest
    },
    setMemory(turnId, brainContext, sources) {
      const held = turns.get(turnId)
      if (!held) return
      const rest = held.manifest.entries.filter((e) => e.sourceId !== 'memory' && !e.sourceId.startsWith('memory-'))
      const memory: ContextManifestEntry[] = brainContext
        ? sources?.length
          ? sources.map((entry) => ({ ...entry }))
          : [{ origin: 'document', authority: 'data', sourceId: 'memory', bytes: utf8Bytes(brainContext), via: 'ask' }]
        : []
      held.manifest = { ...held.manifest, entries: [...memory, ...rest].slice(0, 32) }
    },
    get(turnId) {
      const held = turns.get(turnId)
      const owner = deps.owner()
      if (!held || owner === null || held.owner !== owner) return null
      return held.manifest
    },
    clear: () => turns.clear()
  }
}

/** Collects the records one part of the ask path put in the prompt (the meeting transcript tail), for the manifest. */
export interface ManifestCollector {
  add(entry: ContextManifestEntry): void
  entries(): readonly ContextManifestEntry[]
}

export function createManifestCollector(): ManifestCollector {
  const list: ContextManifestEntry[] = []
  return { add: (entry) => void list.push(entry), entries: () => list }
}
