/**
 * Map cloud STT normalizer finals → Listen transcript line fields.
 * Pure helpers (no Electron / no network) so vitest can pin speaker labels without a WS.
 *
 * Contract (enterprise-live / Tony lock):
 * - mic ("you") → profile name via micSpeakerLabel; never invent a person
 * - remote ("them") → sessionLabelFromCloudCluster (Speaker N / Unknown); never invent names
 */
import { micSpeakerLabel, sessionLabelFromCloudCluster } from './speaker-names'

/** Minimal final shape shared with main/cloud-stt normalizers. */
export type CloudSttFinalLike = {
  id: string
  text: string
  startMs: number
  endMs: number
  cluster: string
  language?: string
}

export type CloudSttLineSpeaker = 'you' | 'them'

export type CloudSttMappedLine = {
  speaker: CloudSttLineSpeaker
  text: string
  name: string
  /** Provider cluster id when remote; undefined for mic. */
  cluster?: string
  language?: string
  startMs: number
  endMs: number
  id: string
}

/**
 * One final segment → one Listen line. Channel decides label strategy.
 */
export function mapCloudFinalToLine(
  final: CloudSttFinalLike,
  channel: CloudSttLineSpeaker,
  opts?: { profile?: { name?: string | null } | null }
): CloudSttMappedLine | null {
  const text = (final.text || '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  if (channel === 'you') {
    return {
      speaker: 'you',
      text,
      name: micSpeakerLabel(opts?.profile),
      language: final.language && final.language !== 'und' ? final.language : undefined,
      startMs: final.startMs,
      endMs: final.endMs,
      id: final.id
    }
  }
  return {
    speaker: 'them',
    text,
    name: sessionLabelFromCloudCluster(final.cluster),
    cluster: final.cluster,
    language: final.language && final.language !== 'und' ? final.language : undefined,
    startMs: final.startMs,
    endMs: final.endMs,
    id: final.id
  }
}

/** Map a full normalizer result's finals for one capture channel. */
export function mapCloudFinalsToLines(
  finals: readonly CloudSttFinalLike[],
  channel: CloudSttLineSpeaker,
  opts?: { profile?: { name?: string | null } | null }
): CloudSttMappedLine[] {
  const out: CloudSttMappedLine[] = []
  for (const f of finals) {
    const line = mapCloudFinalToLine(f, channel, opts)
    if (line) out.push(line)
  }
  return out
}
