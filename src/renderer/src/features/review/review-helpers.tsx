import { memo } from 'react'
import { transcriptDisplayName } from '@shared/speaker-names'
import type { TranscriptLine } from '@shared/ipc'
import { fnv1a } from '@shared/hash'
import { Markdown } from '../../components/Markdown'
import { ModeRecapView, modeRecapSections } from '../../components/ModeRecap'

export const INCOMPLETE_RECAP_COPY = 'This summary may be incomplete. Review it before using it, or retry.'

export function clock(t: number): string {
  try {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

/** Display label for a transcript line's speaker: confirmed/cluster name wins; mic side uses
 *  profile youLabel when provided; else honest You/Them/Unknown (never invent people). */
export function speakerDisplay(l: TranscriptLine, youLabel?: string | null): string {
  return transcriptDisplayName(l, { youLabel })
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatDurationMin(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

// Local, not UTC, calendar-day key for a timestamp as "YYYY-MM-DD".
export function localDateKey(dateStr: string): string {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr.slice(0, 10)
  return d.toLocaleDateString('en-CA')
}

/** Group an array of MeetingSummary by their LOCAL calendar day. */
export function groupByDate(meetings: import('@shared/ipc').MeetingSummary[]): [string, import('@shared/ipc').MeetingSummary[]][] {
  const map = new Map<string, import('@shared/ipc').MeetingSummary[]>()
  for (const m of meetings) {
    const d = localDateKey(m.date)
    if (!map.has(d)) map.set(d, [])
    map.get(d)!.push(m)
  }
  return Array.from(map.entries())
}

// Compare LOCAL date keys as strings; construct fallback display dates at local midnight.
export function friendlyDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  if (!y || !m || !d) return dateKey
  const today = new Date()
  if (dateKey === today.toLocaleDateString('en-CA')) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (dateKey === yesterday.toLocaleDateString('en-CA')) return 'Yesterday'
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

export function meetingTime(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** An in-place recap edit that was saved, paired with the recap text it replaced. */
export type EditedRecap = { base: string; text: string }

/** A saved recap edit applies only while App is still passing back the same base text. */
export function displayedRecapText(edited: EditedRecap | null, incoming: string | undefined): string {
  const text = incoming ?? ''
  return edited && edited.base === text ? edited.text : text
}

export function RecapBody({ text, mode }: { text: string; mode: string }): JSX.Element {
  const sections = modeRecapSections(text, mode)
  if (sections.length >= 2) return <ModeRecapView mode={mode} sections={sections} />
  return <Markdown>{text}</Markdown>
}

export const TranscriptRow = memo(function TranscriptRow({ line }: { line: TranscriptLine }): JSX.Element {
  return (
    <div className="flex gap-2 text-[13px] leading-snug">
      <span className="shrink-0 font-mono text-[10px] text-[color:var(--color-ink-3)]">
        {clock(line.t)}
      </span>
      <span
        className={
          'shrink-0 text-[10px] font-semibold uppercase ' +
          (line.speaker === 'them'
            ? 'text-[color:var(--color-ink-2)]'
            : 'text-[color:var(--color-ink-3)]')
        }
      >
        {speakerDisplay(line)}
      </span>
      <span className="min-w-0 flex-1 break-words text-[color:var(--color-ink)]">{line.text}</span>
    </div>
  )
})

/** A save-failure status line may only claim a retry while a retry is still pending. */
export function saveStatusLine(attempts: number, max: number, gaveUp: boolean): string | null {
  if (gaveUp) return 'Automatic retries have stopped. Press Save to try again.'
  if (attempts > 0) return `Retrying… attempt ${Math.min(attempts, max)} / ${max}`
  return null
}

/** Cold Calling Mode — whether the coaching notes' "People to invite or send to" section actually names
 *  anyone, so the "Book meetings" action is never offered against an empty section or a "None." verdict.
 *  Line-based (not a single regex): a blank line separating the heading from the next "## " section is
 *  itself whitespace, so a naive `\s*` boundary swallows it and misreads the FOLLOWING section as this
 *  one's body. */
export function coldCallHasPeopleToFollowUp(coachingText: string): boolean {
  const lines = coachingText.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s*People to invite or send to\s*:?\s*$/i.test(l.trim()))
  if (start === -1) return false
  const body: string[] = []
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) body.push(lines[i])
  const text = body.join('\n').trim()
  return text.length > 0 && !/^none\.?$/i.test(text)
}

/** The exact payload "Push to CRM" sends — deliberately thin (see the note on the push panel below). */
export type CrmPayload = { title: string; date: string; summary: string }
export type CrmPushPhase = 'idle' | 'sending' | 'sent' | 'error'

// Session memory of the CRM pushes that already landed. `pushState` below is plain component state:
// leaving for History unmounts Review entirely, and re-opening a meeting resets it, so on its own an
// already-pushed meeting re-arms "Push to CRM" and a second Confirm push files a byte-identical duplicate
// record. Keyed on the payload rather than the meeting file because the payload is what the CRM actually
// receives — and because savedPath is still null while a live meeting's autosave is retrying, so a file
// key would miss a push made in that window. Module scope, not a ref: it has to outlive the component.
const pushedCrmPayloads = new Set<string>()

/**
 * MQA-092 — the payload's fingerprint, and the single identity both memories agree on: this in-session
 * Set and the durable `crm_pushed` frontmatter marker main writes (recall.ts's setMeetingCrmPushed).
 * A hash rather than the payload itself because it has to survive into a YAML scalar; base-36 FNV-1a
 * because it already exists in shared/hash.ts and this is dedupe, not security. An edited recap hashes
 * differently and correctly re-arms the chip — that is a different record, not a duplicate.
 */
export function crmPushKey(p: CrmPayload): string {
  return fnv1a(JSON.stringify([p.title, p.date, p.summary])).toString(36)
}

/** Remember a push the CRM accepted, so re-opening this meeting doesn't offer to send it again. */
export function markCrmPushed(p: CrmPayload): void {
  pushedCrmPayloads.add(crmPushKey(p))
}

/** Seed the session memory from a meeting's durable marker, so a push made before the last relaunch is
 *  still known. Takes the raw fingerprint (not a payload) because that is what the frontmatter holds. */
export function seedCrmPushed(key: string | undefined): void {
  if (key) pushedCrmPayloads.add(key)
}

/** Whether THIS payload already reached the CRM — drives both the "Pushed to Polo Pre-Sales." line and
 *  the hiding of the "Push to CRM" chip, so neither depends on Review still being mounted. A changed
 *  recap is a different payload and re-arms the chip, which is correct: it is no longer the same record. */
export function crmPushDone(phase: CrmPushPhase, p: CrmPayload): boolean {
  return phase === 'sent' || pushedCrmPayloads.has(crmPushKey(p))
}

// ── "Book next steps" — push recap action items to a connected task manager (Plane today) ──────────────
// One MCP task per (action item × connection) — see the design note on NextStepArgs below for the exact
// wire shape. Per-card push status; a card that already succeeded this session is remembered the same
// way pushedCrmPayloads remembers a CRM push, so leaving Review and coming back never re-arms it.
export type NextStepPhase = 'idle' | 'sending' | 'sent' | 'error'
/** The exact args a single "Book next steps" push sends. `containerId` (when the user filled in a target,
 *  e.g. a Plane project id) rides in as `project_id` — the one container-scoping key name the design this
 *  feature was built against calls out as known (unlike the due-date argument name, which is NOT sent
 *  structured — see dueDateText's own doc comment in shared/ipc.ts). */
export type NextStepArgs = { title: string; description: string; project_id?: string }
const pushedNextSteps = new Set<string>()
const nextStepKey = (connectionId: string, args: NextStepArgs): string =>
  JSON.stringify([connectionId, args.title, args.description, args.project_id ?? ''])

/** Remember a next-step push that succeeded, so re-opening this meeting doesn't re-offer it. */
export function markNextStepPushed(connectionId: string, args: NextStepArgs): void {
  pushedNextSteps.add(nextStepKey(connectionId, args))
}

/** Whether THIS (connectionId, args) pair already landed — mirrors crmPushDone above. */
export function nextStepPushed(phase: NextStepPhase, connectionId: string, args: NextStepArgs): boolean {
  return phase === 'sent' || pushedNextSteps.has(nextStepKey(connectionId, args))
}
