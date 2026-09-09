/**
 * Speaker-name remapping helpers for multi-speaker transcripts.
 *
 * Live diarization labels unknown voices as "Speaker N" (session clusters). At meeting end a merge
 * pass may collapse over-split clusters (Speaker 3 → Speaker 1). Users can also rename a cluster to
 * a real person. Both paths produce a from→to map applied to TranscriptLine.name without touching
 * the channel enum (you / them / unknown).
 */
import type { TranscriptLine } from './ipc'

/** Session cluster labels look like "Speaker 1", "Speaker 12". Enrolled names do not. */
export function isSessionSpeakerLabel(name: string | undefined | null): boolean {
  if (!name) return false
  return /^Speaker \d+$/i.test(name.trim())
}

/**
 * Apply a from→to speaker-name map to transcript lines. Lines without a name, or whose name is not
 * a key in the map, are unchanged. Empty / identity maps are a no-op (same array reference).
 */
export function remapTranscriptSpeakerNames<T extends Pick<TranscriptLine, 'name'>>(
  lines: readonly T[],
  mapping: ReadonlyMap<string, string> | Record<string, string>
): T[] {
  const map =
    mapping instanceof Map
      ? mapping
      : new Map(Object.entries(mapping).filter(([from, to]) => from && to && from !== to))
  if (map.size === 0) return lines as T[]
  let changed = false
  const out = lines.map((line) => {
    const from = line.name?.trim()
    if (!from) return line
    const to = map.get(from)
    if (!to || to === from) return line
    changed = true
    return { ...line, name: to }
  })
  return changed ? out : (lines as T[])
}

/** Collect distinct session cluster labels currently present on a transcript. */
export function sessionSpeakerLabels(lines: readonly Pick<TranscriptLine, 'name'>[]): string[] {
  const seen = new Set<string>()
  for (const line of lines) {
    const n = line.name?.trim()
    if (n && isSessionSpeakerLabel(n)) seen.add(n)
  }
  return [...seen].sort((a, b) => {
    const na = Number(a.replace(/\D/g, '')) || 0
    const nb = Number(b.replace(/\D/g, '')) || 0
    return na - nb || a.localeCompare(b)
  })
}
