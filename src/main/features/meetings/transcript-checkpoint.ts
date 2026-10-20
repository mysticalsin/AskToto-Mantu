import type { TranscriptRevision } from '@shared/contracts/speech/transcript-revision'
import { parse, readMeetingFields, serialize, setMeetingField } from './meeting-document'

export const REVISION_SCHEMA = 1 as const

export interface LanguageRun {
  language: string
  /** Inclusive first seq of the run. */
  from: number
  /** Inclusive last seq of the run. */
  to: number
}

export interface RevisionCheckpoint {
  revision: number
  schema: number
  languages: LanguageRun[] | null
}

const LANGUAGE_TOKEN = /^[A-Za-z0-9-]{2,35}$/
const RUN_TOKEN = /^([A-Za-z0-9-]{2,35})@(\d+)(?:-(\d+))?$/
const DIGITS = /^\d+$/

/** Encodes per-segment languages as seq runs. Merging ignores gaps in seq, so a run such as `en@0-5` may
 *  cover seqs that no segment has; readers must map languages by seq range, never by count. */
export function encodeSegmentLanguages(rev: Pick<TranscriptRevision, 'segments'>): string {
  const sorted = [...rev.segments].sort((a, b) => a.seq - b.seq)
  const runs: LanguageRun[] = []
  for (const segment of sorted) {
    const language = LANGUAGE_TOKEN.test(segment.language) ? segment.language : 'und'
    const last = runs[runs.length - 1]
    if (last && last.language === language) last.to = segment.seq
    else runs.push({ language, from: segment.seq, to: segment.seq })
  }
  return runs
    .map((run) => (run.from === run.to ? `${run.language}@${run.from}` : `${run.language}@${run.from}-${run.to}`))
    .join(' ')
}

export function decodeSegmentLanguages(value: string): LanguageRun[] | null {
  const trimmed = value.trim()
  if (trimmed === '') return []
  const runs: LanguageRun[] = []
  let previousTo = -1
  for (const token of trimmed.split(/\s+/)) {
    const match = RUN_TOKEN.exec(token)
    if (!match) return null
    const from = Number(match[2])
    const to = match[3] === undefined ? from : Number(match[3])
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null
    if (to < from || from <= previousTo) return null
    runs.push({ language: match[1], from, to })
    previousTo = to
  }
  return runs
}

/** The checkpoint's frontmatter `key: value` pairs, values already serialized. `languages: false` leaves out
 *  the per-segment language map (a summary-only save keeps no speech segments). */
export function revisionCheckpointFields(
  rev: Pick<TranscriptRevision, 'revision' | 'segments'>,
  opts: { languages?: boolean } = {}
): Array<[key: string, value: string]> {
  const fields: Array<[string, string]> = [
    ['transcriptRevision', String(rev.revision)],
    ['revisionSchema', String(REVISION_SCHEMA)]
  ]
  if (opts.languages !== false) fields.push(['segmentLanguages', `"${encodeSegmentLanguages(rev)}"`])
  return fields
}

/** Stamps the revision fields into the frontmatter through the codec. Null when there is no frontmatter. */
export function applyRevisionCheckpoint(
  text: string,
  rev: Pick<TranscriptRevision, 'revision' | 'segments'>,
  opts: { languages?: boolean } = {}
): string | null {
  const parsed = parse(text)
  if (parsed === null) return null
  let doc = parsed
  for (const [key, value] of revisionCheckpointFields(rev, opts)) doc = setMeetingField(doc, key, value)
  if (opts.languages === false) doc = setMeetingField(doc, 'segmentLanguages', null)
  return serialize(doc)
}

/** Null for a legacy file (no transcriptRevision): callers treat it as revision 0, finalized. */
export function readRevisionCheckpoint(text: string): RevisionCheckpoint | null {
  const fields = readMeetingFields(text)
  const raw = fields.transcriptRevision
  if (raw === undefined || !DIGITS.test(raw)) return null
  const revision = Number(raw)
  if (!Number.isSafeInteger(revision)) return null
  const schemaRaw = fields.revisionSchema
  const schema = schemaRaw !== undefined && DIGITS.test(schemaRaw) ? Number(schemaRaw) : 1
  const languages = fields.segmentLanguages === undefined ? null : decodeSegmentLanguages(fields.segmentLanguages)
  return { revision, schema, languages }
}
