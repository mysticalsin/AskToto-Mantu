import { createHash } from 'node:crypto'
import {
  MEETING_RECORD_FIELD_MAX,
  MEETING_RECORD_MAX_ITEMS,
  MEETING_RECORD_TEXT_MAX,
  type Citation,
  type MeetingRecord,
  type RecordItem,
  type RecordKind
} from '@shared/meeting-record'
import type { TranscriptLine } from '@shared/transcript-line'
import { foldRecapLabel, parseRecapMarkdown } from '../../transcripts-recap'
import { citeItem, supportsDue, supportsOwner } from './citations'

export type SetEdit = { op: 'set'; text?: string; owner?: string | null; dueText?: string | null; at: string }
export type DeleteEdit = { op: 'delete'; at: string }
export interface AddedItem {
  id: string
  kind: RecordKind
  text: string
  owner: string | null
  dueText: string | null
  at: string
}
/** What the owner changed. Never the derived record: citations are recomputed on every read. */
export interface RecordEdits {
  v: 1
  edits: Record<string, SetEdit | DeleteEdit>
  added: AddedItem[]
}

export const emptyRecordEdits = (): RecordEdits => ({ v: 1, edits: {}, added: [] })

interface Parsed {
  kind: RecordKind
  text: string
  owner: string | null
  dueText: string | null
}

const clip = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value)

/** Stable across rebuilds: the kind plus the folded original text, with an occurrence suffix for exact repeats. */
function idFor(kind: RecordKind, text: string, seen: Map<string, number>): string {
  const base = `${kind}:${createHash('sha256')
    .update(`${kind}${foldRecapLabel(text)}`)
    .digest('hex')
    .slice(0, 16)}`
  const n = seen.get(base) ?? 0
  seen.set(base, n + 1)
  return n === 0 ? base : `${base}.${n}`
}

function parseRecap(recap: string): Parsed[] {
  const parsed = parseRecapMarkdown(recap)
  return [
    ...parsed.decisions.map((text): Parsed => ({ kind: 'decision', text, owner: null, dueText: null })),
    ...parsed.openQuestions.map((text): Parsed => ({ kind: 'question', text, owner: null, dueText: null })),
    ...parsed.actionItems.map((a): Parsed => ({ kind: 'action', text: a.text, owner: a.owner, dueText: a.dueDateText }))
  ]
}

/**
 * Derive the structured record from the saved recap and transcript, then lay the owner's edits over it.
 * Local and deterministic: no model sees the meeting. A recap-sourced owner or due phrase survives only when the cited
 * range supports it; unknown stays unknown. The owner's own values are always kept.
 */
export function buildMeetingRecord(
  recapMarkdown: string,
  lines: readonly TranscriptLine[],
  edits: RecordEdits,
  startedAt: number | null = null
): MeetingRecord {
  const recap = recapMarkdown.trim()
  const summaryOnly = lines.length === 0
  const seen = new Map<string, number>()
  const parsed = recap ? parseRecap(recap) : []
  const items: RecordItem[] = []
  const live = new Set<string>()

  const cite = (text: string): Citation | null => (summaryOnly ? null : citeItem(text, lines))

  for (const p of parsed) {
    const id = idFor(p.kind, p.text, seen)
    live.add(id)
    const edit = edits.edits[id]
    if (edit?.op === 'delete') continue
    const set = edit?.op === 'set' ? edit : null
    const text = clip(set?.text ?? p.text, MEETING_RECORD_TEXT_MAX)
    const citation = cite(text)
    let owner: string | null = null
    let dueText: string | null = null
    if (p.kind === 'action') {
      owner = set && 'owner' in set ? (set.owner ?? null) : p.owner
      dueText = set && 'dueText' in set ? (set.dueText ?? null) : p.dueText
      if (!(set && 'owner' in set) && owner && !(citation && supportsOwner(owner, lines, citation))) owner = null
      if (!(set && 'dueText' in set) && dueText && !(citation && supportsDue(dueText, lines, citation))) dueText = null
    }
    items.push({
      id,
      kind: p.kind,
      text,
      owner: owner === null ? null : clip(owner, MEETING_RECORD_FIELD_MAX),
      dueText: dueText === null ? null : clip(dueText, MEETING_RECORD_FIELD_MAX),
      citation,
      source: set ? 'user' : 'recap'
    })
  }

  for (const a of edits.added) {
    items.push({
      id: a.id,
      kind: a.kind,
      text: a.text,
      owner: a.kind === 'action' ? a.owner : null,
      dueText: a.kind === 'action' ? a.dueText : null,
      citation: cite(a.text),
      source: 'user'
    })
  }

  const orphanedEdits = Object.keys(edits.edits).filter((id) => !live.has(id)).length
  const status = recap || items.length > 0 ? 'ok' : 'no-recap'
  return {
    status,
    items: items.slice(0, MEETING_RECORD_MAX_ITEMS),
    summaryOnly,
    orphanedEdits,
    startedAt
  }
}
