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

/** Honest visible labels when identity is unresolved or overlapping. */
export const UNKNOWN_SPEAKER_PREFIX = 'Unknown speaker'
export const OVERLAP_SPEAKER_LABEL = 'Overlapping speakers'

export function unknownSpeakerLabel(ordinal: number): string {
  const n = Number.isFinite(ordinal) && ordinal >= 1 ? Math.floor(ordinal) : 1
  return `${UNKNOWN_SPEAKER_PREFIX} ${n}`
}

export function isUnknownSpeakerLabel(name: string | undefined | null): boolean {
  if (!name) return false
  return new RegExp(`^${UNKNOWN_SPEAKER_PREFIX} \\d+$`, 'i').test(name.trim())
}

export function isOverlapSpeakerLabel(name: string | undefined | null): boolean {
  if (!name) return false
  return name.trim().toLowerCase() === OVERLAP_SPEAKER_LABEL.toLowerCase()
}

/**
 * Primary visible label for a transcript line.
 * Confirmed name wins; session cluster stays "Speaker N"; unknown/overlap stay honest;
 * bare you/them roles are never invented as person names.
 */
export function transcriptDisplayName(
  line: Pick<{ name?: string; speaker: string; overlap?: boolean }, 'name' | 'speaker'> & {
    overlap?: boolean
  }
): string {
  if (line.overlap || isOverlapSpeakerLabel(line.name)) return OVERLAP_SPEAKER_LABEL
  const name = line.name?.trim()
  if (name) {
    if (isSessionSpeakerLabel(name) || isUnknownSpeakerLabel(name) || isOverlapSpeakerLabel(name)) {
      return name
    }
    return name
  }
  if (line.speaker === 'you') return 'You'
  if (line.speaker === 'them') return 'Them'
  return unknownSpeakerLabel(1)
}

/**
 * Apply confirmed participant names onto lines. Unmapped clusters become Unknown speaker N
 * (stable by cluster ordinal) rather than inventing a person. Overlap lines stay overlapping.
 */
export function applyConfirmedSpeakerNames<
  T extends { name?: string; speaker: string; overlap?: boolean }
>(
  lines: readonly T[],
  confirmed: ReadonlyMap<string, string> | Record<string, string>
): T[] {
  const map =
    confirmed instanceof Map
      ? confirmed
      : new Map(Object.entries(confirmed).filter(([from, to]) => from && to && from !== to))
  let unknownOrdinal = 0
  const clusterToUnknown = new Map<string, string>()
  return lines.map((line) => {
    if (line.overlap) return { ...line, name: OVERLAP_SPEAKER_LABEL }
    const from = line.name?.trim()
    if (from && map.has(from)) {
      const to = map.get(from)!
      return to === from ? line : { ...line, name: to }
    }
    if (from && !isSessionSpeakerLabel(from) && !isUnknownSpeakerLabel(from)) {
      return line // already a confirmed/enrolled-looking name
    }
    const key = from || `∅:${line.speaker}`
    let label = clusterToUnknown.get(key)
    if (!label) {
      unknownOrdinal += 1
      label = unknownSpeakerLabel(unknownOrdinal)
      clusterToUnknown.set(key, label)
    }
    if (line.name === label) return line
    return { ...line, name: label }
  })
}
