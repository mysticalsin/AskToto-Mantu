import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Check, FileText, ListTree, FolderOpen, Save, RotateCcw, Play, ChevronDown, Download, Clock, Mail, Send, AlertCircle, EarOff, ArrowLeft, Pencil, X, Sparkles, Trash2, Lock, PhoneCall } from 'lucide-react'
import type { TranscriptLine, MeetingSummary, McpConnection, RecapExport } from '@shared/ipc'
import type { AnswerState } from '../state'
import { isNonSpeechLine } from '@shared/transcript-filter'
import { talkStats } from '@shared/talkstats'
import { fnv1a } from '@shared/hash'
import { Markdown } from './Markdown'
import { Chip, TextButton, Spinner } from './ui'
import { ReviewEntityStrip } from './ReviewEntityStrip'
import { useFlash } from '../lib/useFlash'
import { accelLabel } from '../lib/keys'

function clock(t: number): string {
  try {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

/** Display label for a transcript line's speaker: the resolved name once Speaker Intelligence has one
 *  (see @shared/transcript-align.ts), else the generic Them/You/Speaker side label. */
function speakerDisplay(l: TranscriptLine): string {
  return l.name || (l.speaker === 'them' ? 'Them' : l.speaker === 'you' ? 'You' : 'Speaker')
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatDurationMin(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

// Local (not UTC) calendar-day key for a timestamp, as "YYYY-MM-DD" — see the identical helper (and its
// full rationale) in RecallView.tsx, which owns this logic. Truncating the raw ISO instant to its first
// 10 characters grabs the UTC date, which is a different calendar day from the local one for roughly
// half of every 24h cycle in any timezone west of UTC, so a meeting saved moments ago could key under
// "yesterday". `toLocaleDateString('en-CA')` formats as plain YYYY-MM-DD using the LOCAL timezone.
function localDateKey(dateStr: string): string {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr.slice(0, 10)
  return d.toLocaleDateString('en-CA')
}

/** Group an array of MeetingSummary by their LOCAL calendar day. */
function groupByDate(meetings: import('@shared/ipc').MeetingSummary[]): [string, import('@shared/ipc').MeetingSummary[]][] {
  const map = new Map<string, import('@shared/ipc').MeetingSummary[]>()
  for (const m of meetings) {
    const d = localDateKey(m.date)
    if (!map.has(d)) map.set(d, [])
    map.get(d)!.push(m)
  }
  return Array.from(map.entries())
}

// `dateKey` is a LOCAL "YYYY-MM-DD" string from localDateKey/groupByDate — compared as a plain string
// against today's/yesterday's own local keys (computed the same way), so the comparison never re-enters
// ISO/UTC date parsing. The fallback display date is built from the key's numeric y/m/d via the
// `Date(y, m, d)` constructor, which — unlike `new Date("YYYY-MM-DD")` — constructs local midnight.
function friendlyDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  if (!y || !m || !d) return dateKey
  const today = new Date()
  if (dateKey === today.toLocaleDateString('en-CA')) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (dateKey === yesterday.toLocaleDateString('en-CA')) return 'Yesterday'
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

function meetingTime(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** An in-place recap edit that was saved, paired with the recap text it replaced. */
export type EditedRecap = { base: string; text: string }

/** The recap markdown every consumer reads (Markdown render, Copy Summary, Export JSON/PDF, CRM payload),
 *  so an edit reflects everywhere at once. The in-place copy of a saved edit stands only while App is
 *  still handing back the text that edit was made against: Regenerate re-runs the recap and OVERWRITES
 *  this meeting on disk, and a copy that outlived that write kept the old edited text on screen — and in
 *  every export and the CRM payload — while the file said something else, with no recovery short of
 *  leaving the screen and reopening. Comparing against `base` makes the override yield to the streaming
 *  regeneration and then to the regenerated recap the moment either arrives. */
export function displayedRecapText(edited: EditedRecap | null, incoming: string | undefined): string {
  const text = incoming ?? ''
  return edited && edited.base === text ? edited.text : text
}

/** The line under a save-failure banner. It used to be an unconditional present-tense "Retrying… attempt
 *  N / M" gated on nothing but `attempts > 0`, so once App's backoff ladder stopped scheduling attempts
 *  the screen went on promising a retry that would never come — the user's only cue said "in progress"
 *  while the meeting sat unwritten. A status line may only claim work that is actually pending; when the
 *  ladder has given up it names the Save chip instead, which is armed in exactly this state. */
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
type CrmPushPhase = 'idle' | 'sending' | 'sent' | 'error'

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

/**
 * MQA-092 — a push that landed before the meeting had a file yet.
 *
 * The push panel needs only `recapText`, not a saved path, and a LIVE meeting's `savedPath` stays null
 * until autosave lands — which can be deferred behind up to 5 retries with backoff. A push in that
 * window has nothing to stamp the marker onto, so without this it is remembered for the session and
 * forgotten at quit: the one case where the durable half would silently not apply.
 *
 * One slot, because only the live meeting can have a null savedPath and there is only ever one of those.
 * The flush below is guarded on the fingerprint matching the CURRENT payload, which makes writing it to
 * the wrong file impossible by construction: navigate to a different meeting and its payload hashes
 * differently, so nothing is written.
 */
let pendingCrmMarker: string | null = null

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
type NextStepPhase = 'idle' | 'sending' | 'sent' | 'error'
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

export const Review = memo(function Review({
  recap,
  lines,
  savedPath,
  saveError,
  saveAttempts,
  maxSaveAttempts,
  saveGaveUp,
  startedAt,
  showTranscript,
  meetingMeta,
  confidential,
  crmPushedKey,
  followupDraft,
  winsToggle,
  onOpenFolder,
  onSave,
  onDiscard,
  onDone,
  onResume,
  onGenerateFollowup,
  onRetryRecap,
  onGenerateRecap,
  mcpConnections,
  onOpenPastMeeting,
  isPastMeeting,
  onRecapSaved,
  onDirtyChange,
  recapUnavailable,
  coldCall
}: {
  recap: AnswerState | null
  lines: TranscriptLine[]
  savedPath: string | null
  saveError: string | null
  saveAttempts?: number
  maxSaveAttempts?: number
  /** True once App's auto-save ladder has stopped scheduling attempts — see saveStatusLine. */
  saveGaveUp?: boolean
  startedAt?: number
  showTranscript?: boolean // opt-in: auto-expand the full transcript; default summary-only
  meetingMeta?: { title: string; date: string }
  /** Task MI-5 — this meeting's saved `confidential` frontmatter flag, so the toggle below reflects the
   *  actual persisted state (a reopened past meeting) instead of always starting unflagged. */
  confidential?: boolean
  /** MQA-092 — this meeting's saved `crm_pushed` fingerprint, so a recap pushed to the CRM before the
   *  last relaunch does not re-arm "Push to CRM". Undefined for a live meeting and for one never pushed. */
  crmPushedKey?: string
  /** Draft follow-up email from the locked follow-up Dust agent — null until Generate is clicked. */
  followupDraft?: AnswerState | null
  onOpenFolder: () => void
  onSave?: () => void
  /** Discard this meeting instead of keeping it — deletes the saved file (main pops a native confirm)
   *  then leaves the review. Sits next to Save so "keep" vs "throw away" is one clear choice. */
  onDiscard?: () => void
  onDone?: () => void
  onResume?: () => void
  onGenerateFollowup?: () => void
  /** Spotlight Ref wins opt-in for the email recap. Present only when Spotlight Ref is connected (it holds
   *  our wins / case studies); absent otherwise so there is nothing to ground against and no dead control. */
  winsToggle?: { on: boolean; onToggle: (on: boolean) => void }
  /** Replay the recap generation after a failure (transient Dust/rate-limit blip) — without this the
   *  only recovery was "New meeting", which discards the whole saved session. */
  onRetryRecap?: () => void
  /** Retroactively generate a recap for a past meeting that was saved/imported without one. Only
   *  rendered as a button when isPastMeeting && the recap is empty. */
  onGenerateRecap?: () => void
  /** Named MCP push connections (Settings → Mantu Intelligence) — BidStack (kind 'bidstack') gates
   *  "Push to CRM" below; every other connected, non-BidStack kind (Plane today) gates "Book next steps". */
  mcpConnections?: McpConnection[]
  /** Opens a "Recent meetings" row as a read-only past-meeting Review (same handler History uses). */
  onOpenPastMeeting?: (file: string) => void
  /** True when reviewing a past meeting reopened from History, so onDone returns to History rather than starting a new meeting. */
  isPastMeeting?: boolean
  /** Called with the new recap markdown after a successful in-place edit save, so the owner (App) can keep
   *  its own copy (used by Resume + follow-up generation) consistent without a disk re-read. */
  onRecapSaved?: (recap: string) => void
  /** Mirrors recapDirty (below) up to the owner (App) so its global Escape handler can gate on the same
   *  unsaved-edit check this component's own in-panel exits already run. Called with `false` on unmount. */
  onDirtyChange?: (dirty: boolean) => void
  /** Live session only: the recap was deliberately skipped (no AI provider configured) instead of being
   *  fired and left to fail with a red error. Shown in place of the "writing detailed notes…" spinner,
   *  which would otherwise spin forever since no recap request was ever sent. */
  recapUnavailable?: { message: string; onOpenSettings?: () => void }
  /** Cold Calling Mode only (live session, see App.tsx maybeFireRecap): end-of-call coaching, fired
   *  automatically alongside the recap, plus the manual "Book meetings" action drafted from it. Session-
   *  only — not persisted, so a reopened past cold call never carries this. */
  coldCall?: {
    coaching: AnswerState | null
    onRetryCoaching?: () => void
    booking: AnswerState | null
    onBookMeetings: () => void
  }
}): JSX.Element {
  const [copied, flashCopied] = useFlash(1500)
  const [notesCopied, flashNotesCopied] = useFlash(1500)
  const [jsonCopied, flashJsonCopied] = useFlash(1500)
  const [exportError, setExportError] = useState<string | null>(null)
  const [transcriptOpen, setTranscriptOpen] = useState(!!showTranscript)
  // Task MI-5 — confidential flag: excludes this meeting from every published wiki surface. Local state
  // seeded from the `confidential` prop (the meeting's actual saved value for a reopened past meeting;
  // false for a just-ended live one) and updated optimistically on toggle.
  const [confidentialFlag, setConfidentialFlag] = useState(!!confidential)
  const [confidentialBusy, setConfidentialBusy] = useState(false)
  useEffect(() => setConfidentialFlag(!!confidential), [confidential, savedPath])
  const toggleConfidential = async (): Promise<void> => {
    if (!savedPath || confidentialBusy) return
    const file = savedPath.split('/').pop() ?? savedPath
    const next = !confidentialFlag
    setConfidentialBusy(true)
    setConfidentialFlag(next) // optimistic — reverted below on failure
    try {
      const r = await window.toto.recallSetConfidential(file, next)
      if (!r.ok) setConfidentialFlag(!next)
    } catch {
      setConfidentialFlag(!next)
    } finally {
      setConfidentialBusy(false)
    }
  }
  // 90-Second Debrief (innovation #6): the off-record layer — what was NOT said out loud.
  const [debrief, setDebrief] = useState('')
  const [debriefState, setDebriefState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const saveDebrief = async (): Promise<void> => {
    if (!savedPath || !debrief.trim() || debriefState === 'saving') return
    setDebriefState('saving')
    try {
      const file = savedPath.split('/').pop() ?? savedPath
      const r = await window.toto.debriefSave(file, debrief)
      setDebriefState(r.ok ? 'saved' : 'error')
    } catch {
      setDebriefState('error')
    }
  }
  // Frozen at mount: by the time Review shows, the meeting has ENDED, so its duration is a constant.
  // A ticking wall-clock here made the Duration chip keep growing after Stop whenever a session ended
  // with ≤1 transcript line (the wall-clock fallback below) — a stopped meeting must never keep counting.
  const endedAtRef = useRef(Date.now())
  const [recentMeetings, setRecentMeetings] = useState<MeetingSummary[]>([])
  // Focus anchor for the Summary section — Retry summary moves focus here first, since the button it's
  // clicked on unmounts the instant retry starts (recap.error clears), which would otherwise drop focus to <body>.
  const summaryRef = useRef<HTMLElement>(null)

  // ── Editable recap (past meetings only) ──────────────────────────────────
  // Past-meeting recaps are read-only by default; Edit lets the user fix a mis-heard name, tick an action
  // item, or annotate. `editedRecap` holds the post-save copy shown in place — the recap PROP is owned by
  // App and isn't re-read from disk here — so null means "follow the prop", and so does a copy whose `base`
  // no longer matches the prop (see displayedRecapText). `recapText` is the single value every consumer
  // below (Markdown render, Copy Summary, Export JSON/PDF, CRM payload) reads, so an edit reflects
  // everywhere at once.
  const [editingRecap, setEditingRecap] = useState(false)
  const [recapDraft, setRecapDraft] = useState('')
  const [recapSaving, setRecapSaving] = useState(false)
  const [recapEditError, setRecapEditError] = useState<string | null>(null)
  const [editedRecap, setEditedRecap] = useState<EditedRecap | null>(null)
  // A different meeting loaded into this reused Review instance → drop any in-progress/edited state.
  useEffect(() => {
    setEditingRecap(false)
    setEditedRecap(null)
    setRecapEditError(null)
  }, [savedPath])
  // A regeneration replaces this meeting's recap under us: the prop's id flips from 'past' to the run id
  // and back. Drop the in-place copy on that flip too, so a re-run that happens to return the exact text
  // the edit was made against can't resurrect it. Only the copy — an open editor keeps its draft.
  useEffect(() => {
    setEditedRecap(null)
  }, [recap?.id])
  // Track the latest savedPath so a save that resolves AFTER the user navigated to a different past
  // meeting (via the Recent meetings list) bails out instead of painting its result onto the wrong one.
  const savedPathRef = useRef(savedPath)
  useEffect(() => {
    savedPathRef.current = savedPath
  }, [savedPath])
  const recapText = displayedRecapText(editedRecap, recap?.text)

  // True while the recap edit panel is open AND the draft actually differs from the saved/displayed
  // text — i.e. there is something a navigation would silently throw away. Gated on editingRecap (not
  // just a draft/text mismatch) because recapDraft is left holding its last value after Cancel/Save, so
  // comparing the two alone would still read "dirty" once editingRecap is already false.
  const recapDirty = editingRecap && recapDraft !== recapText
  // Surface the dirty state to the owner (App) — its global Escape handler doesn't render inside this
  // component's own exit buttons, so it can't call confirmDiscardRecapEdit directly; this keeps App's ref
  // in sync so Escape can gate on the same check the in-panel exits below already use. Reset on unmount so
  // a stale "dirty" flag can never survive after Review closes.
  useEffect(() => {
    onDirtyChange?.(recapDirty)
    return () => onDirtyChange?.(false)
  }, [recapDirty, onDirtyChange])
  // onResume/onDone/"Recent meetings" all navigate away from this screen unconditionally; a reused Review
  // instance would then reset editingRecap/editedRecap (see the savedPath effect above) with the edit never
  // saved. Confirm once before discarding; no-op (returns true immediately) when there is nothing to lose.
  const confirmDiscardRecapEdit = (): boolean =>
    !recapDirty || window.confirm('You have unsaved changes to this recap. Discard them?')

  const startEditRecap = (): void => {
    setRecapDraft(recapText)
    setRecapEditError(null)
    setEditingRecap(true)
  }
  const cancelEditRecap = (): void => {
    setEditingRecap(false)
    setRecapEditError(null)
  }
  const saveRecap = async (): Promise<void> => {
    if (!savedPath || recapSaving) return
    const forPath = savedPath
    setRecapSaving(true)
    setRecapEditError(null)
    try {
      const file = savedPath.split('/').pop() ?? savedPath
      const r = await window.toto.recallUpdateRecap(file, recapDraft)
      // The disk write already targeted the right file, but if the user navigated to a different meeting
      // while it was in flight, drop the result rather than paint meeting A's edit onto meeting B.
      if (savedPathRef.current !== forPath) return
      if (r.ok) {
        // Store the trimmed value so the in-place copy matches exactly what a disk re-read would return
        // (updateMeetingRecap + recallRead both trim the recap section).
        const saved = recapDraft.trim()
        setEditedRecap({ base: recap?.text ?? '', text: saved })
        onRecapSaved?.(saved)
        setEditingRecap(false)
      } else {
        setRecapEditError(r.error || 'Could not save your changes.')
      }
    } catch (e) {
      if (savedPathRef.current !== forPath) return
      setRecapEditError(`Could not save your changes: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRecapSaving(false)
    }
  }

  useEffect(() => {
    // Keyed on savedPath (not just mount): the meeting's own async save lands AFTER this screen mounts,
    // so a mount-only fetch never includes the meeting you just finished. Re-fetch when the save resolves.
    window.toto.recallList().then((list) => setRecentMeetings(list.slice(0, 20))).catch(() => {})
  }, [savedPath])

  // Drop non-speech captions ("[BELL RINGS]", "(applause)"…) from the displayed/copied transcript. New
  // meetings never carry them (filtered at capture), but meetings saved by older builds still might.
  const speechLines = useMemo(() => lines.filter((l) => !isNonSpeechLine(l.text)), [lines])

  const plain = useMemo(
    () => speechLines.map((l) => `[${clock(l.t)}] ${speakerDisplay(l)}: ${l.text}`).join('\n'),
    [speechLines]
  )

  const durationSec = useMemo(() => {
    if (lines.length > 1) {
      const times = lines.map((l) => l.t)
      return Math.floor((Math.max(...times) - Math.min(...times)) / 1000)
    }
    // A saved past meeting with a single line (e.g. a short audio import that fit one transcription
    // window) has no measurable span — the wall-clock fallback below is only for a LIVE just-ended
    // session whose lines haven't landed yet. 0 hides the Duration chip below. endedAtRef (mount time)
    // is FIXED — the meeting is over, so its duration must not keep growing while the user reads this.
    if (isPastMeeting) return 0
    if (startedAt) return Math.max(0, Math.floor((endedAtRef.current - startedAt) / 1000))
    return 0
  }, [lines, startedAt, isPastMeeting])

  const participants = useMemo(() => new Set(lines.map((l) => l.speaker)).size, [lines])

  const [copyError, setCopyError] = useState<string | null>(null)

  const copy = (): void => {
    navigator.clipboard
      .writeText(plain)
      .then(() => {
        flashCopied()
        setCopyError(null)
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        setCopyError(`Copy failed: ${msg}`)
      })
  }

  const copyNotes = (): void => {
    const md = recapText
    if (!md) return
    navigator.clipboard
      .writeText(md)
      .then(() => {
        flashNotesCopied()
      })
      .catch(() => {})
  }

  // Parse the recap markdown into a structured object (decisions + action-items-with-owners) in the main
  // process, then copy it as JSON so it can be pasted straight into Jira/Asana/Notion without retyping.
  const exportJson = (): void => {
    const md = recapText
    if (!md) return
    setExportError(null)
    window.toto
      .exportRecapJson(md)
      .then((json) => navigator.clipboard.writeText(JSON.stringify(json, null, 2)))
      .then(() => {
        flashJsonCopied()
      })
      .catch((e) => setExportError(`Export failed: ${e instanceof Error ? e.message : String(e)}`))
  }

  const [pdfBusy, setPdfBusy] = useState(false)
  const exportPdf = (): void => {
    const md = recapText
    if (!md) return
    setPdfBusy(true)
    setExportError(null)
    window.toto
      .recapPdf({ markdown: md, title: meetingMeta?.title })
      .catch((e) => setExportError(`PDF export failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setPdfBusy(false))
  }

  // Editable follow-up draft: seeded from the streaming followupDraft.text until the user edits it, so
  // their edits never get clobbered by a late token — a fresh draft (new id) re-arms seeding.
  const [followupText, setFollowupText] = useState('')
  const [followupEdited, setFollowupEdited] = useState(false)
  const [followupCopied, flashFollowupCopied] = useFlash(1500)
  useEffect(() => {
    setFollowupEdited(false)
  }, [followupDraft?.id])
  useEffect(() => {
    if (followupDraft?.text != null && !followupEdited) setFollowupText(followupDraft.text)
  }, [followupDraft?.text, followupEdited])

  const [mailError, setMailError] = useState<string | null>(null)

  // "Push to CRM" — manual, review-first: shows the exact payload before it ever leaves the app, then
  // fires a single MCP tool call to BidStack. Payload is deliberately thin: title, date, and the
  // already-AI-summarized recap text — never raw transcript lines or file paths (see the confidentiality
  // note in the plan this feature was built against).
  const bidstackConn = mcpConnections?.find((c) => c.id === 'bidstack')
  const bidstackConnected = bidstackConn?.connected ?? false
  const bidstackTools = bidstackConn?.tools ?? []
  const [pushOpen, setPushOpen] = useState(false)
  const [pushTool, setPushTool] = useState('')
  const [pushState, setPushState] = useState<{ phase: CrmPushPhase; error: string | null }>({
    phase: 'idle',
    error: null
  })
  // A different meeting loaded into this reused Review instance → drop any in-progress/finished CRM push
  // state, mirroring the recap-edit reset above. Without this, navigating from a pushed meeting to an
  // unpushed one via "Recent meetings" kept showing "Pushed to Polo Pre-Sales." for the wrong meeting.
  useEffect(() => {
    setPushOpen(false)
    setPushTool('')
    setPushState({ phase: 'idle', error: null })
  }, [savedPath])
  useEffect(() => {
    if (bidstackTools && bidstackTools.length > 0 && !pushTool) setPushTool(bidstackTools[0])
  }, [bidstackTools, pushTool])

  const crmPayload: CrmPayload = useMemo(
    () => ({
      title: meetingMeta?.title || 'Untitled meeting',
      date: meetingMeta?.date || new Date(startedAt ?? Date.now()).toISOString(),
      summary: recapText
    }),
    [meetingMeta?.title, meetingMeta?.date, recapText, startedAt]
  )
  // MQA-092: fold this meeting's DURABLE marker into the session memory the moment it is known. The Set
  // alone only survives until the app quits, and the push panel has no other recollection — reopen the
  // meeting tomorrow and the chip is armed again over a record the CRM already holds.
  useEffect(() => {
    seedCrmPushed(crmPushedKey)
  }, [crmPushedKey])
  // ...and stamp a push that beat the meeting's own autosave, once the file finally exists. Guarded on
  // the fingerprint matching THIS payload, so a marker can never land on a different meeting's file.
  const crmPayloadKey = crmPushKey(crmPayload)
  useEffect(() => {
    if (!savedPath || pendingCrmMarker !== crmPayloadKey) return
    pendingCrmMarker = null
    void window.toto.recallSetCrmPushed(savedPath, crmPayloadKey).catch(() => {})
  }, [savedPath, crmPayloadKey])
  // Not just `pushState.phase === 'sent'`: that memory dies with the component, and this meeting may have
  // been pushed earlier in the session — or in an earlier session (see pushedCrmPayloads / crm_pushed).
  const crmPushed = crmPushDone(pushState.phase, crmPayload)

  const sendToCrm = async (): Promise<void> => {
    if (pushState.phase === 'sending') return
    if (!pushTool) return
    // Remember the payload that was actually sent — recapText can move on (an edit, a regeneration) while
    // the call is in flight, and the CRM holds what left here, not what the screen shows when it lands.
    const payload = crmPayload
    const file = savedPath
    setPushState({ phase: 'sending', error: null })
    const r = await window.toto.mcpPush({ connectionId: 'bidstack', toolName: pushTool, args: payload })
    if (r.ok) {
      markCrmPushed(payload)
      setPushState({ phase: 'sent', error: null })
      // Durable half. Best-effort on purpose: the push itself already succeeded, and failing to write a
      // dedupe marker must never be reported as a failed push — the session memory above still covers
      // this run. `file` is captured before the await for the same reason payload is; with no file yet
      // (a live meeting whose autosave is still retrying) the marker is parked for the effect above.
      if (file) void window.toto.recallSetCrmPushed(file, crmPushKey(payload)).catch(() => {})
      else pendingCrmMarker = crmPushKey(payload)
    } else {
      setPushState({ phase: 'error', error: r.error || 'Push failed.' })
    }
  }
  // "Book next steps" — manual, review-first, same discipline as "Push to CRM": nothing sends until the
  // user reviews the exact per-item payload and clicks Confirm. Gated on at least one connected,
  // non-BidStack mcpConnections entry (Plane today — ClickUp has no UI/IPC wiring yet, see
  // McpConnectionKindSchema in shared/ipc.ts).
  const taskConnections = useMemo(() => (mcpConnections ?? []).filter((c) => c.kind !== 'bidstack' && c.connected), [mcpConnections])
  const [nextStepsOpen, setNextStepsOpen] = useState(false)
  const [nextStepsData, setNextStepsData] = useState<RecapExport['actionItems'] | null>(null)
  const [nextStepsLoading, setNextStepsLoading] = useState(false)
  const [nextStepsFetchError, setNextStepsFetchError] = useState<string | null>(null)
  const [itemChecked, setItemChecked] = useState<Record<number, boolean>>({})
  const [itemTitle, setItemTitle] = useState<Record<number, string>>({})
  const [connChecked, setConnChecked] = useState<Record<string, boolean>>({})
  const [connTool, setConnTool] = useState<Record<string, string>>({})
  // Per-connection target container id (e.g. a Plane project id) — component state only, never persisted
  // to mcpConnections: Métis has no browse/discovery UI for these containers in v1, so the user pastes it
  // once per session rather than it becoming a stale saved default.
  const [connTarget, setConnTarget] = useState<Record<string, string>>({})
  const [stepStatus, setStepStatus] = useState<Record<string, { phase: NextStepPhase; error: string | null }>>({})
  // Synchronous double-click guard (see confirmNextSteps) + its render-visible twin for the button.
  const pushingNextStepsRef = useRef(false)
  const [pushingNextSteps, setPushingNextSteps] = useState(false)
  // The exact recap text nextStepsData was parsed from, so an edit can invalidate the cache.
  const [nextStepsSource, setNextStepsSource] = useState<string | null>(null)

  // A different meeting loaded into this reused Review instance → drop the whole panel, mirroring the CRM
  // push reset above.
  useEffect(() => {
    setNextStepsOpen(false)
    setNextStepsData(null)
    setNextStepsSource(null)
    setNextStepsFetchError(null)
    setItemChecked({})
    setItemTitle({})
    setStepStatus({})
  }, [savedPath])

  const loadNextSteps = async (): Promise<void> => {
    setNextStepsLoading(true)
    setNextStepsFetchError(null)
    try {
      const source = recapText
      const r = await window.toto.exportRecapJson(source)
      setNextStepsData(r.actionItems)
      setNextStepsSource(source) // remember WHICH recap these items came from (see the effect below)
      setItemChecked(Object.fromEntries(r.actionItems.map((_, i) => [i, true])))
      setItemTitle(Object.fromEntries(r.actionItems.map((it, i) => [i, it.text])))
      setStepStatus({}) // different items — a previous run's per-item sent/error marks no longer apply
    } catch (e) {
      setNextStepsFetchError(e instanceof Error ? e.message : 'Could not read action items from this recap.')
    } finally {
      setNextStepsLoading(false)
    }
  }

  const openNextSteps = async (): Promise<void> => {
    setNextStepsOpen(true)
    // Lazy-fetch, and re-fetch when the recap has changed since the cache was built — mirrors the CRM
    // panel's cost discipline without letting it serve items that no longer match what the user sees.
    if (nextStepsLoading || (nextStepsData && nextStepsSource === recapText)) return
    await loadNextSteps()
  }

  // The recap changed UNDER an already-open panel (the user edited it, or regenerated it). The cached
  // action items describe text that no longer exists, so pushing them would send the user's OLD wording
  // to their tracker. Re-read instead. Skipped mid-stream: a regenerating recap changes on every delta,
  // and re-parsing each one would be a fetch storm for text that is not final yet.
  useEffect(() => {
    if (!nextStepsOpen || nextStepsLoading || recap?.streaming) return
    if (nextStepsSource !== null && nextStepsSource !== recapText) void loadNextSteps()
    // loadNextSteps is re-created every render; the guard above is what makes this converge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recapText, nextStepsOpen, nextStepsLoading, nextStepsSource, recap?.streaming])

  const nextStepDescription = (item: RecapExport['actionItems'][number]): string => {
    const lines = [
      item.text,
      '',
      `From meeting: ${meetingMeta?.title || 'Untitled meeting'} (${meetingMeta?.date || new Date(startedAt ?? Date.now()).toISOString()})`
    ]
    if (item.owner) lines.push(`Owner: ${item.owner}`)
    if (item.dueDateText) lines.push(`Mentioned due: ${item.dueDateText}`)
    return lines.join('\n')
  }

  const nextStepArgs = (item: RecapExport['actionItems'][number], i: number, connId: string): NextStepArgs => {
    const title = (itemTitle[i] ?? item.text).trim().slice(0, 300) || item.text.slice(0, 300)
    const description = nextStepDescription(item)
    const target = (connTarget[connId] || '').trim()
    return target ? { title, description, project_id: target } : { title, description }
  }

  // Sequential, not Promise.all: one connection's failure must never abort another connection's push, and
  // each card's status has to update independently as its own call resolves.
  //
  // The in-flight guard is a REF, not the `sending` phase in stepStatus: a second click in the same tick
  // reads the state its own render closed over, where nothing is 'sending' yet and markNextStepPushed has
  // not run (it only runs after the await resolves) — so both passes sail through the dedupe and create
  // duplicate tasks in the user's tracker. A ref flips synchronously and is immune to that. The button is
  // disabled off the matching state so the UI says so too.
  const confirmNextSteps = async (): Promise<void> => {
    if (!nextStepsData || pushingNextStepsRef.current) return
    pushingNextStepsRef.current = true
    setPushingNextSteps(true)
    try {
      await runNextStepPushes()
    } finally {
      pushingNextStepsRef.current = false
      setPushingNextSteps(false)
    }
  }

  const runNextStepPushes = async (): Promise<void> => {
    if (!nextStepsData) return
    const items = nextStepsData.map((it, i) => ({ item: it, i })).filter(({ i }) => itemChecked[i])
    const conns = taskConnections.filter((c) => connChecked[c.id] ?? true)
    for (const { item, i } of items) {
      for (const conn of conns) {
        const tool = connTool[conn.id] || conn.tools[0]
        if (!tool) continue
        const args = nextStepArgs(item, i, conn.id)
        const key = `${i}:${conn.id}`
        if (nextStepPushed(stepStatus[key]?.phase ?? 'idle', conn.id, args)) continue
        setStepStatus((s) => ({ ...s, [key]: { phase: 'sending', error: null } }))
        const r = await window.toto.mcpPush({ connectionId: conn.id, toolName: tool, args })
        if (r.ok) {
          markNextStepPushed(conn.id, args)
          setStepStatus((s) => ({ ...s, [key]: { phase: 'sent', error: null } }))
        } else {
          setStepStatus((s) => ({ ...s, [key]: { phase: 'error', error: r.error || 'Push failed.' } }))
        }
      }
    }
  }

  const copyFollowup = (): void => {
    navigator.clipboard
      .writeText(followupText)
      .then(() => {
        flashFollowupCopied()
      })
      .catch(() => {})
  }

  // mailto: fallback (Phase 1) — opens the user's own default mail client with a prefilled draft.
  // No attachments possible via mailto; sending stays entirely manual. Real Outlook drafts with
  // attachments are a separate, later phase gated on Microsoft Graph scope consent.
  const openFollowupInMail = (): void => {
    setMailError(null)
    const subject = meetingMeta?.title ? `Follow-up: ${meetingMeta.title}` : 'Follow-up'
    window.toto
      .openMailDraft({ subject, body: followupText })
      .catch((e) => setMailError(`Couldn't open your mail app: ${e instanceof Error ? e.message : String(e)}`))
  }

  return (
    <div className="flex flex-col gap-3">
      {meetingMeta && (
        <div className="mb-0.5">
          <div className="font-ui text-[15px] font-semibold text-[color:var(--color-ink)]">{meetingMeta.title}</div>
          <div className="mt-0.5 text-[12px] text-[color:var(--color-ink-3)]">{meetingMeta.date}</div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 text-[11px] text-[color:var(--color-ink-2)]">
        <div className="flex items-center gap-2">
          {durationSec > 0 && (
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5">Duration {formatDuration(durationSec)}</span>
          )}
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5">
            {participants} participant{participants === 1 ? '' : 's'}
          </span>
          {/* Talk ratio — word share over real speech lines. Amber past 70%: in a client meeting,
              the one selling should not be the one talking. Details on hover. */}
          {(() => {
            const s = talkStats(lines.filter((l) => !isNonSpeechLine(l.text)))
            if (s.youShare === null) return null
            const pct = Math.round(s.youShare * 100)
            return (
              <span
                className="rounded-full bg-white/[0.06] px-2 py-0.5"
                title={`${s.youWords} of ${s.youWords + s.themWords} words · longest monologue ${formatDuration(s.longestMonologueSec)} · they asked ${s.themQuestions} question${s.themQuestions === 1 ? '' : 's'}`}
                style={pct >= 70 ? { color: 'var(--color-warn, #fac775)' } : undefined}
              >
                You spoke {pct}%
              </span>
            )
          })()}
        </div>
        <div className="flex items-center gap-1.5">
          {onResume && (
            <Chip
              icon={Play}
              onClick={() => {
                if (confirmDiscardRecapEdit()) onResume()
              }}
              variant="accent"
            >
              Resume session
            </Chip>
          )}
          {onSave && (
            // Mirrors manualSave's own guard (App.tsx) — `!recap || recap.streaming` — so the button can't
            // be clicked while the recap is still streaming/absent, which used to silently no-op.
            <TextButton
              icon={Save}
              onClick={onSave}
              disabled={lines.length === 0 || !!savedPath || !recap || recap.streaming}
            >
              Save
            </TextButton>
          )}
          {onDiscard && (
            <TextButton icon={Trash2} onClick={onDiscard} title="Discard this meeting without keeping it">Disregard</TextButton>
          )}
          {onDone && (
            <Chip
              icon={isPastMeeting ? ArrowLeft : RotateCcw}
              onClick={() => {
                if (confirmDiscardRecapEdit()) onDone()
              }}
              variant="accent"
            >
              {isPastMeeting ? 'Back to history' : 'New meeting'}
            </Chip>
          )}
        </div>
      </div>

      {saveError && !savedPath && (
        <div className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] text-[var(--color-danger)]">
          <div>Couldn't save the transcript: {saveError}</div>
          {(() => {
            if (saveAttempts === undefined || maxSaveAttempts === undefined) return null
            const status = saveStatusLine(saveAttempts, maxSaveAttempts, saveGaveUp ?? false)
            return status ? <div className="mt-1 text-[11px] opacity-80">{status}</div> : null
          })()}
        </div>
      )}
      {savedPath && !meetingMeta && (
        <button
          type="button"
          aria-label="Open saved transcript folder"
          onClick={onOpenFolder}
          className="no-drag focus-ring flex items-center gap-2 rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/10 px-3 py-2 text-left text-[12px] hover:bg-[var(--color-success)]/16"
        >
          <FolderOpen size={14} className="text-[var(--color-success)]" />
          <span className="flex-1 text-[color:var(--color-ink-2)]">
            Saved to your meetings folder for Dust follow-up.
          </span>
          <span className="font-medium text-[var(--color-success)]">Open</span>
        </button>
      )}

      {/* Task MI-5 — confidential flag: excludes this meeting from every published wiki page (note
          card, entity timelines/current-facts, indexes). Available for both a just-saved live meeting
          and a reopened past one — anything with a real savedPath. */}
      {savedPath && (
        <button
          type="button"
          onClick={() => void toggleConfidential()}
          disabled={confidentialBusy}
          aria-pressed={confidentialFlag}
          className={[
            'no-drag focus-ring flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-[12px] disabled:opacity-60',
            confidentialFlag
              ? 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10'
              : 'border-[var(--color-hair-soft)] bg-white/[0.02] hover:bg-white/[0.05]'
          ].join(' ')}
        >
          <Lock size={13} className={confidentialFlag ? 'text-[var(--color-danger)]' : 'text-[color:var(--color-ink-3)]'} />
          <span className="flex-1 text-[color:var(--color-ink-2)]">
            {confidentialFlag
              ? 'Confidential: excluded from published intelligence.'
              : 'Confidential: exclude from published intelligence'}
          </span>
          <span className={confidentialFlag ? 'font-medium text-[var(--color-danger)]' : 'text-[color:var(--color-ink-3)]'}>
            {confidentialFlag ? 'On' : 'Off'}
          </span>
        </button>
      )}

      {/* Entities in this meeting (Task MI-3) — the moment-of-truth correction strip. Renders nothing
          until the meeting's extraction lands (and never when the brain is off), so it can't shift the
          layout for anyone else; dismissible; blocks no other Review interaction. */}
      <ReviewEntityStrip file={savedPath} />

      {/* 90-SECOND DEBRIEF — the unsaid, captured while it's still warm. Live reviews only (a past
          meeting's moment has passed). Stored inside the saved meeting file: same encryption, same
          retention, same deletion; the brain folds it into signals on re-ingest. */}
      {savedPath && !meetingMeta && (
        <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            <EarOff size={12} /> 90-second debrief, off the record
          </div>
          {debriefState === 'saved' ? (
            <div className="flex items-center gap-2 text-[12px] text-[color:var(--color-ink-2)]">
              <Check size={13} className="text-[var(--color-success)]" />
              Saved with the meeting. It feeds your intelligence brain, never a follow-up email.
            </div>
          ) : (
            <>
              <textarea
                value={debrief}
                onChange={(e) => setDebrief(e.target.value)}
                rows={2}
                placeholder="What wasn't said out loud? Hallway remarks, hesitation, your gut read…"
                className="no-drag focus-ring w-full resize-none rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-3)]"
              />
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-[10px] text-[color:var(--color-ink-3)]">
                  {debriefState === 'error' ? 'Could not save. Try again.' : 'Impressions, not transcript. 90 seconds, then move on.'}
                </span>
                <TextButton onClick={() => void saveDebrief()} disabled={!debrief.trim() || debriefState === 'saving'}>
                  {debriefState === 'saving' ? <Spinner size={11} /> : <Save size={11} />}
                  Save debrief
                </TextButton>
              </div>
            </>
          )}
        </div>
      )}

      <section ref={summaryRef} tabIndex={-1} aria-live="polite" aria-atomic="false">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            <ListTree size={12} /> Summary
          </div>
          {editingRecap ? (
            // Edit mode toolbar: Save / Cancel. Replaces Copy/Export, which don't apply mid-edit.
            <div className="flex items-center gap-1">
              <Chip onClick={() => void saveRecap()} variant="accent" disabled={recapSaving}>
                {recapSaving ? <Spinner size={13} /> : <Check size={13} />}
                {recapSaving ? 'Saving' : 'Save'}
              </Chip>
              <TextButton onClick={cancelEditRecap} disabled={recapSaving}>
                <X size={11} /> Cancel
              </TextButton>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              {/* Retroactive recap generation — a past meeting saved/imported without one (a keyless
                  import, or one from before this button existed). Hidden once there's a recap OR an error
                  showing (the error view below already has its own Retry). Disabled mid-stream so a second
                  click can't self-cancel the in-flight generation. */}
              {isPastMeeting && !recapText && !recap?.error && onGenerateRecap && (
                <Chip onClick={onGenerateRecap} variant="accent" disabled={recap?.streaming}>
                  {recap?.streaming ? <Spinner size={13} /> : <Sparkles size={13} />}
                  {recap?.streaming ? 'Generating…' : 'Generate recap'}
                </Chip>
              )}
              {/* Edit — past meetings only (a live session's recap is still owned by the ask state, and may
                  be streaming/retryable). Available even when the recap is empty, so a meeting saved without
                  one can still be annotated. */}
              {isPastMeeting && !recap?.error && (
                <TextButton onClick={startEditRecap} title="Edit these notes">
                  <Pencil size={11} /> Edit
                </TextButton>
              )}
              {recapText && !recap?.error && (
                <>
                  {/* Accent-filled so the primary "copy the recap" action is unmissable on the review screen. */}
                  <Chip onClick={copyNotes} variant="accent">
                    {notesCopied ? <Check size={13} className="text-white" /> : <Copy size={13} />}
                    {notesCopied ? 'Copied' : 'Copy Summary'}
                  </Chip>
                  {/* Regenerate — re-run the recap from the same transcript when the generated summary is wrong
                      or thin. Same handler as the error-state Retry (onRetryRecap): a live meeting re-runs its
                      recap, a past meeting regenerates + overwrites the saved one. Focus the section first
                      because this button unmounts the instant regeneration clears recapText (mirrors Retry). */}
                  {onRetryRecap && (
                    <TextButton
                      onClick={() => {
                        summaryRef.current?.focus()
                        onRetryRecap?.()
                      }}
                      disabled={recap?.streaming}
                      title="Regenerate this summary from the transcript"
                    >
                      {recap?.streaming ? <Spinner size={11} /> : <RotateCcw size={11} />}
                      {recap?.streaming ? 'Regenerating' : 'Regenerate'}
                    </TextButton>
                  )}
                  <TextButton onClick={exportJson} title="Copy structured JSON (decisions + action items) for Jira/Asana/Notion">
                    {jsonCopied ? <Check size={11} className="text-[var(--color-success)]" /> : <Download size={11} />}
                    {jsonCopied ? 'Copied' : 'Export JSON'}
                  </TextButton>
                  <TextButton onClick={exportPdf} disabled={pdfBusy} title="Save this summary as a PDF">
                    {pdfBusy ? <Spinner size={11} /> : <FileText size={11} />}
                    Export PDF
                  </TextButton>
                </>
              )}
            </div>
          )}
        </div>
        {exportError && <div className="mb-1.5 text-[11px] text-[var(--color-danger)]">{exportError}</div>}
        {editingRecap ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={recapDraft}
              autoFocus
              onChange={(e) => setRecapDraft(e.target.value)}
              onKeyDown={(e) => {
                // Escape cancels; stopPropagation keeps it from bubbling to App's global Escape handler
                // (which would otherwise act on the whole overlay). Cmd/Ctrl+Enter saves, matching the
                // app's other commit shortcuts.
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  cancelEditRecap()
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.stopPropagation()
                  e.preventDefault()
                  void saveRecap()
                }
              }}
              rows={14}
              maxLength={20000}
              spellCheck={false}
              aria-label="Edit meeting notes"
              className="scroll-thin no-drag w-full resize-y rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3 text-[13px] leading-relaxed text-[color:var(--color-ink)] focus:outline-none"
            />
            {recapEditError && <div className="text-[11px] text-[var(--color-danger)]">{recapEditError}</div>}
            <div className="text-[11px] text-[color:var(--color-ink-3)]">
              Markdown supported. Changes are saved to this meeting. {accelLabel('CommandOrControl+Return')} to save, Esc to cancel.
            </div>
          </div>
        ) : recap?.error ? (
          <div className="flex flex-col gap-2">
            <div className="text-[13px] text-[var(--color-danger)]">{recap.error}</div>
            {/* Scoped retry — replays just the recap request. Previously the only recovery was
                "New meeting", which throws away the whole saved transcript. */}
            {onRetryRecap && (
              <div className="flex items-center gap-1.5">
                <TextButton
                  icon={RotateCcw}
                  onClick={() => {
                    summaryRef.current?.focus()
                    onRetryRecap?.()
                  }}
                >
                  Retry summary
                </TextButton>
              </div>
            )}
          </div>
        ) : recapText ? (
          <Markdown>{recapText}</Markdown>
        ) : recap?.streaming ? (
          // A past meeting's retroactive "Generate recap" (or a just-finished import) is in flight —
          // recap here is recapGen's live streaming answer, not the static (still-empty) saved recap.
          <div className="flex items-center gap-2 py-1 text-[13px] text-[color:var(--color-ink-2)]">
            <Spinner size={13} /> writing detailed notes…
          </div>
        ) : isPastMeeting ? (
          // A past meeting saved without a recap (e.g. a keyless summary failure) and nothing generating
          // right now. Not a spinner — the work is long over; offer to add notes instead.
          <div className="text-[13px] text-[color:var(--color-ink-2)]">
            No notes saved for this meeting. Select Edit to add some.
          </div>
        ) : !recap && lines.length === 0 ? (
          <div className="text-[13px] text-[color:var(--color-ink-2)]">
            No speech was captured this session.
          </div>
        ) : recapUnavailable ? (
          // No AI provider configured — the recap was never requested (see App.tsx maybeFireRecap), so
          // without this branch a transcript with no recap would fall through to the spinner below and
          // spin forever. Neutral, not an error: transcription/recording still worked.
          <div className="flex flex-col gap-2">
            <div className="text-[13px] text-[color:var(--color-ink-2)]">{recapUnavailable.message}</div>
            {recapUnavailable.onOpenSettings && (
              <div className="flex items-center gap-1.5">
                <TextButton onClick={recapUnavailable.onOpenSettings}>
                  Open Settings
                </TextButton>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 py-1 text-[13px] text-[color:var(--color-ink-2)]">
            <Spinner size={13} /> writing detailed notes…
          </div>
        )}
      </section>

      {coldCall && !editingRecap && (
        <section aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <PhoneCall size={12} /> Cold call coaching
            </div>
            {coldCall.coaching?.error && coldCall.onRetryCoaching && (
              <TextButton icon={RotateCcw} onClick={coldCall.onRetryCoaching}>Retry</TextButton>
            )}
          </div>
          {coldCall.coaching?.error ? (
            <div className="text-[13px] text-[var(--color-danger)]">{coldCall.coaching.error}</div>
          ) : coldCall.coaching?.text ? (
            <div className="flex flex-col gap-2">
              <Markdown>{coldCall.coaching.text}</Markdown>
              {!coldCall.coaching.streaming && coldCallHasPeopleToFollowUp(coldCall.coaching.text) && (
                <div className="flex flex-col gap-2">
                  {coldCall.booking?.error ? (
                    <div className="flex items-center gap-1.5">
                      <div className="text-[12px] text-[var(--color-danger)]">{coldCall.booking.error}</div>
                      <TextButton icon={RotateCcw} onClick={coldCall.onBookMeetings}>Retry</TextButton>
                    </div>
                  ) : coldCall.booking ? (
                    <div className="flex flex-col gap-2">
                      {coldCall.booking.streaming && !coldCall.booking.text ? (
                        <div className="flex items-center gap-2 py-1 text-[13px] text-[color:var(--color-ink-2)]">
                          <Spinner size={13} /> drafting outreach…
                        </div>
                      ) : (
                        <Markdown>{coldCall.booking.text}</Markdown>
                      )}
                      {!coldCall.booking.streaming && (
                        <div className="flex items-center gap-1.5">
                          <TextButton icon={RotateCcw} onClick={coldCall.onBookMeetings}>Redo</TextButton>
                        </div>
                      )}
                    </div>
                  ) : (
                    <Chip onClick={coldCall.onBookMeetings} variant="accent">
                      <Send size={13} /> Book meetings
                    </Chip>
                  )}
                </div>
              )}
            </div>
          ) : coldCall.coaching?.streaming ? (
            <div className="flex items-center gap-2 py-1 text-[13px] text-[color:var(--color-ink-2)]">
              <Spinner size={13} /> coaching notes…
            </div>
          ) : (
            // coaching === null means it was never STARTED (the call ended with nothing transcribed, so
            // generateColdCallCoaching returned early). Showing the spinner here — as this branch used to —
            // left a call that produced no audio spinning forever, with no error and no Retry, because
            // Retry only renders on an error. Offer the action instead of pretending work is in flight.
            <div className="flex items-center justify-between gap-2 py-1">
              <span className="text-[13px] text-[color:var(--color-ink-3)]">
                No coaching notes yet — nothing was transcribed from this call.
              </span>
              {coldCall.onRetryCoaching && (
                <TextButton icon={RotateCcw} onClick={coldCall.onRetryCoaching}>
                  Generate
                </TextButton>
              )}
            </div>
          )}
        </section>
      )}

      {onGenerateFollowup && recapText && !editingRecap && (
        <section aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <Mail size={12} /> Follow-up
            </div>
            {!followupDraft && (
              <div className="flex items-center gap-2">
                {winsToggle && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[color:var(--color-ink-2)]">
                    <input
                      type="checkbox"
                      checked={winsToggle.on}
                      onChange={(e) => winsToggle.onToggle(e.target.checked)}
                      className="no-drag size-3.5 cursor-pointer accent-[var(--color-accent)]"
                    />
                    Include our wins
                  </label>
                )}
                <Chip onClick={onGenerateFollowup} variant="accent">
                  <Mail size={13} /> Email recap
                </Chip>
              </div>
            )}
          </div>
          {followupDraft?.error ? (
            <div className="flex flex-col gap-2">
              <div className="text-[13px] text-[var(--color-danger)]">{followupDraft.error}</div>
              <div className="flex items-center gap-1.5">
                <TextButton icon={RotateCcw} onClick={onGenerateFollowup}>Retry</TextButton>
              </div>
            </div>
          ) : followupDraft?.streaming && !followupText ? (
            <div className="flex items-center gap-2 py-1 text-[13px] text-[color:var(--color-ink-2)]">
              <Spinner size={13} /> drafting follow-up…
            </div>
          ) : followupDraft ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={followupText}
                onChange={(e) => {
                  setFollowupEdited(true)
                  setFollowupText(e.target.value)
                }}
                rows={10}
                className="scroll-thin w-full resize-y rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3 text-[13px] leading-relaxed text-[color:var(--color-ink)] focus:outline-none"
              />
              <div className="flex items-center gap-1.5">
                <TextButton onClick={copyFollowup}>
                  {followupCopied ? <Check size={11} className="text-[var(--color-success)]" /> : <Copy size={11} />}
                  {followupCopied ? 'Copied' : 'Copy'}
                </TextButton>
                <TextButton onClick={openFollowupInMail} disabled={!followupText}>
                  <Mail size={11} /> Open in Mail
                </TextButton>
                <TextButton icon={RotateCcw} onClick={onGenerateFollowup}>
                  Regenerate
                </TextButton>
              </div>
              {mailError && <div className="text-[11px] text-[var(--color-danger)]">{mailError}</div>}
              <div className="text-[11px] text-[color:var(--color-ink-3)]">
                Review before sending, and attach anything promised manually for now.
              </div>
            </div>
          ) : null}
        </section>
      )}

      {recapText && !recap?.error && !editingRecap && (
        <section aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <Send size={12} /> CRM
            </div>
            {bidstackConnected && !pushOpen && !crmPushed && (
              <Chip onClick={() => setPushOpen(true)} variant="accent">
                <Send size={13} /> Push to CRM
              </Chip>
            )}
          </div>

          {!bidstackConnected ? (
            <div className="text-[12px] leading-snug text-[color:var(--color-ink-3)]">
              Connect Polo Pre-Sales in Settings → Mantu Intelligence to push this recap to your CRM.
            </div>
          ) : crmPushed ? (
            <div className="flex items-center gap-1.5 text-[13px] text-[var(--color-success)]">
              <Check size={13} /> Pushed to Polo Pre-Sales.
            </div>
          ) : pushOpen ? (
            <div className="flex flex-col gap-2">
              {bidstackTools && bidstackTools.length > 0 ? (
                <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-ink-3)]">
                  Polo Pre-Sales tool
                  <select
                    value={pushTool}
                    onChange={(e) => setPushTool(e.target.value)}
                    className="no-drag rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.02] px-2 py-1.5 text-[13px] text-[color:var(--color-ink)]"
                  >
                    {bidstackTools.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="text-[11px] text-[color:var(--color-danger)]">
                  Polo Pre-Sales has no tools in this key's scope, so there's nothing to push to. Check the key's
                  scopes in Settings.
                </div>
              )}

              {/* Exact payload preview — shown before anything is sent, same review-first discipline as
                  the follow-up draft above. Deliberately thin: title/date/summary only, no transcript. */}
              <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3 text-[12px]">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
                  Payload preview
                </div>
                <div className="flex flex-col gap-1 text-[color:var(--color-ink-2)]">
                  <div>
                    <span className="text-[color:var(--color-ink-3)]">Title: </span>
                    {crmPayload.title}
                  </div>
                  <div>
                    <span className="text-[color:var(--color-ink-3)]">Date: </span>
                    {crmPayload.date}
                  </div>
                  <div className="text-[color:var(--color-ink-3)]">Summary:</div>
                  <div className="scroll-thin max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/[0.03] p-2 text-[color:var(--color-ink)]">
                    {crmPayload.summary || '(empty)'}
                  </div>
                </div>
              </div>

              {pushState.phase === 'error' && pushState.error && (
                <div className="flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
                  <AlertCircle size={13} className="mt-px shrink-0" />
                  <span>{pushState.error}</span>
                </div>
              )}

              <div className="flex items-center gap-1.5">
                {/* Only render Confirm push when there is a tool to push to. With a zero-tool key scope the
                    tool picker never renders and pushTool stays '', so sendToCrm() would return at its
                    `if (!pushTool)` guard — a dead click with no feedback. Gating the Chip here leaves only
                    Cancel plus the "reported no tools" note, so the button is never a silent no-op. */}
                {pushTool && (
                  <Chip
                    onClick={() => void sendToCrm()}
                    variant="accent"
                    disabled={pushState.phase === 'sending'}
                  >
                    {pushState.phase === 'sending' ? <Spinner size={13} /> : <Send size={13} />}
                    {pushState.phase === 'sending' ? 'Pushing…' : 'Confirm push'}
                  </Chip>
                )}
                <TextButton
                  onClick={() => {
                    setPushOpen(false)
                    setPushState({ phase: 'idle', error: null })
                  }}
                  disabled={pushState.phase === 'sending'}
                >
                  Cancel
                </TextButton>
              </div>
            </div>
          ) : null}
        </section>
      )}

      {recapText && !recap?.error && !editingRecap && taskConnections.length > 0 && (
        <section aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <ListTree size={12} /> Next steps
            </div>
            {!nextStepsOpen && (
              <Chip onClick={() => void openNextSteps()} variant="accent">
                <ListTree size={13} /> Book next steps
              </Chip>
            )}
          </div>

          {nextStepsOpen && (
            <div className="flex flex-col gap-3">
              {nextStepsLoading ? (
                <div className="flex items-center gap-2 py-1 text-[13px] text-[color:var(--color-ink-2)]">
                  <Spinner size={13} /> reading action items…
                </div>
              ) : nextStepsFetchError ? (
                <div className="flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
                  <AlertCircle size={13} className="mt-px shrink-0" />
                  <span>{nextStepsFetchError}</span>
                </div>
              ) : nextStepsData && nextStepsData.length === 0 ? (
                <div className="text-[12px] leading-snug text-[color:var(--color-ink-3)]">
                  No action items found in this recap.
                </div>
              ) : nextStepsData ? (
                <>
                  {/* Item checklist — each pre-checked, title editable before it becomes a real task title. */}
                  <div className="flex flex-col gap-1.5">
                    {nextStepsData.map((item, i) => (
                      <label key={i} className="flex items-start gap-2 text-[12px]">
                        <input
                          type="checkbox"
                          checked={itemChecked[i] ?? true}
                          onChange={(e) => setItemChecked((s) => ({ ...s, [i]: e.target.checked }))}
                          className="mt-1 shrink-0"
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <input
                            value={itemTitle[i] ?? item.text}
                            onChange={(e) => setItemTitle((s) => ({ ...s, [i]: e.target.value }))}
                            disabled={!(itemChecked[i] ?? true)}
                            className="w-full rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.02] px-2 py-1 text-[12px] text-[color:var(--color-ink)] disabled:opacity-50"
                          />
                          {(item.owner || item.dueDateText) && (
                            <span className="text-[11px] text-[color:var(--color-ink-3)]">
                              {item.owner ? `Owner: ${item.owner}` : ''}
                              {item.owner && item.dueDateText ? ' · ' : ''}
                              {item.dueDateText ? `Mentioned due: ${item.dueDateText}` : ''}
                            </span>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>

                  {/* Connection picker — a next step can go to more than one connected task manager. */}
                  <div className="flex flex-col gap-2">
                    {taskConnections.map((conn) => {
                      const checked = connChecked[conn.id] ?? true
                      const tool = connTool[conn.id] || conn.tools[0] || ''
                      return (
                        <div key={conn.id} className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-2.5">
                          <label className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--color-ink)]">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => setConnChecked((s) => ({ ...s, [conn.id]: e.target.checked }))}
                            />
                            {conn.label}
                          </label>
                          {checked && (
                            <div className="flex flex-col gap-1.5 pl-6">
                              {conn.tools.length > 0 ? (
                                <select
                                  value={tool}
                                  onChange={(e) => setConnTool((s) => ({ ...s, [conn.id]: e.target.value }))}
                                  className="no-drag rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.02] px-2 py-1.5 text-[12px] text-[color:var(--color-ink)]"
                                >
                                  {conn.tools.map((t) => (
                                    <option key={t} value={t}>
                                      {t}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <div className="text-[11px] text-[var(--color-danger)]">
                                  {conn.label} has no tools in this key's scope, so there's nothing to push to.
                                </div>
                              )}
                              <input
                                value={connTarget[conn.id] || ''}
                                onChange={(e) => setConnTarget((s) => ({ ...s, [conn.id]: e.target.value }))}
                                placeholder={`${conn.label} project ID (optional)`}
                                className="w-full rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.02] px-2 py-1.5 text-[12px] text-[color:var(--color-ink)]"
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* Payload preview — one card per checked item × checked connection, exactly what will be
                      sent. Same review-first discipline as the CRM payload preview above. */}
                  <div className="flex flex-col gap-1.5">
                    {nextStepsData.map((item, i) => {
                      if (!(itemChecked[i] ?? true)) return null
                      return taskConnections
                        .filter((c) => connChecked[c.id] ?? true)
                        .map((conn) => {
                          const args = nextStepArgs(item, i, conn.id)
                          const key = `${i}:${conn.id}`
                          const status = stepStatus[key]
                          const done = nextStepPushed(status?.phase ?? 'idle', conn.id, args)
                          return (
                            <div key={key} className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-2.5 text-[12px]">
                              <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
                                <span>{conn.label}</span>
                                {done ? (
                                  <span className="flex items-center gap-1 text-[var(--color-success)]">
                                    <Check size={11} /> Sent
                                  </span>
                                ) : status?.phase === 'sending' ? (
                                  <span className="flex items-center gap-1 text-[color:var(--color-ink-3)]">
                                    <Spinner size={11} /> Sending
                                  </span>
                                ) : null}
                              </div>
                              <div className="text-[color:var(--color-ink)]">{args.title}</div>
                              <div className="mt-0.5 whitespace-pre-wrap text-[color:var(--color-ink-2)]">{args.description}</div>
                              {status?.phase === 'error' && status.error && (
                                <div className="mt-1 flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
                                  <AlertCircle size={12} className="mt-px shrink-0" />
                                  <span>{status.error}</span>
                                </div>
                              )}
                            </div>
                          )
                        })
                    })}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Chip onClick={() => void confirmNextSteps()} variant="accent" disabled={pushingNextSteps}>
                      {pushingNextSteps ? <Spinner size={13} /> : <ListTree size={13} />}
                      {pushingNextSteps ? 'Pushing…' : 'Confirm push'}
                    </Chip>
                    <TextButton onClick={() => setNextStepsOpen(false)}>Cancel</TextButton>
                  </div>
                </>
              ) : null}
            </div>
          )}
        </section>
      )}

      {lines.length === 0 ? null : !transcriptOpen ? (
        // Summary-first: the full transcript is hidden behind a one-click disclosure unless the user has
        // opted in (Settings → showFullTranscriptInReview). The notes above are the payoff.
        <button
          type="button"
          onClick={() => setTranscriptOpen(true)}
          className="no-drag focus-ring flex w-fit items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium text-[color:var(--color-ink-3)] hover:bg-white/[0.06] hover:text-[color:var(--color-ink-2)]"
        >
          <FileText size={12} />
          Show Transcript
          <span className="text-[color:var(--color-ink-3)] opacity-60">· {speechLines.length} lines</span>
          <ChevronDown size={12} className="-rotate-90" />
        </button>
      ) : (
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setTranscriptOpen(false)}
            className="no-drag focus-ring flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
          >
            <FileText size={12} /> Full transcript · {speechLines.length} lines <ChevronDown size={12} />
          </button>
          <TextButton onClick={copy}>
            {copied ? <Check size={11} className="text-[var(--color-success)]" /> : <Copy size={11} />}
            {copied ? 'Copied' : 'Copy'}
          </TextButton>
        </div>
        {copyError && (
          <div className="mb-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2 py-1 text-[11px] text-[var(--color-danger)]">
            {copyError}
          </div>
        )}
        {/* No inner scroll: the transcript flows in full and the single review panel scrolls as one, so the
            whole Overview + transcript is visible without fighting a nested 300px scroll box. */}
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3">
          {speechLines.length === 0 ? (
            <div className="text-[13px] text-[color:var(--color-ink-2)]">No transcript captured.</div>
          ) : (
            speechLines.map((l, i) => (
              <div key={i} className="flex gap-2 text-[13px] leading-snug">
                <span className="shrink-0 font-mono text-[10px] text-[color:var(--color-ink-3)]">
                  {clock(l.t)}
                </span>
                <span
                  className={
                    'shrink-0 text-[10px] font-semibold uppercase ' +
                    (l.speaker === 'them'
                      ? 'text-[color:var(--color-ink-2)]'
                      : 'text-[color:var(--color-ink-3)]')
                  }
                >
                  {speakerDisplay(l)}
                </span>
                <span className="min-w-0 flex-1 break-words text-[color:var(--color-ink)]">{l.text}</span>
              </div>
            ))
          )}
        </div>
      </section>
      )}

      {/* Recent meetings list */}
      {recentMeetings.length > 0 && (
        <section className="mt-1">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            <Clock size={11} /> Recent meetings
          </div>
          <div className="scroll-thin flex max-h-[220px] flex-col gap-0.5 overflow-y-auto rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-1.5">
            {groupByDate(recentMeetings).map(([date, items]) => (
              <div key={date}>
                <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-ink-3)]">
                  {friendlyDate(date)}
                </div>
                {items.map((item) => (
                  <button
                    key={item.file}
                    type="button"
                    onClick={() => {
                      if (confirmDiscardRecapEdit()) onOpenPastMeeting?.(item.file)
                    }}
                    className="no-drag focus-ring flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06]"
                  >
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--color-ink)]">
                      {item.title}
                    </span>
                    <span className="shrink-0 text-[11px] text-[color:var(--color-ink-3)]">
                      {meetingTime(item.date)}
                    </span>
                    <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-[color:var(--color-ink-3)]">
                      {formatDurationMin(item.durationMin)}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
})
