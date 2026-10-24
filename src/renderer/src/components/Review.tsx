import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Copy,
  Check,
  ListTree,
  FolderOpen,
  RotateCcw,
  Save,
  Play,
  Download,
  Clock,
  Mail,
  Send,
  AlertCircle,
  ArrowLeft,
  Pencil,
  X,
  Sparkles,
  Trash2,
  Lock,
  PhoneCall
} from 'lucide-react'
import type { TranscriptLine, MeetingSummary, McpConnection, RecapExport } from '@shared/ipc'
import type { RecapStatus } from '@shared/recap-status'
import type { AnswerState } from '../state'
import type { NavigationGuardService } from '../lib/navigation-guard'
import { isNonSpeechLine } from '@shared/transcript-filter'
import { reviewDurationSeconds } from '@shared/meeting-duration'
import { reviewSpeakerLabel } from '@shared/speaker-summary'
import { talkStats } from '@shared/talkstats'
import { Markdown } from './Markdown'
import { Chip, TextButton, Spinner } from './ui'
import { AgentStatus, InlineOrb } from './AgentStatus'
import { RecapPdfExportButton } from '../features/export/RecapPdfExportButton'
import { ReviewEntityStrip } from './ReviewEntityStrip'
import { useFlash } from '../lib/useFlash'
import { accelLabel } from '../lib/keys'
import { OutlookDraftLifecycle, outlookDraftIntent } from './outlook-draft-lifecycle'
import {
  clock,
  speakerDisplay,
  formatDuration,
  formatDurationMin,
  groupByDate,
  friendlyDate,
  meetingTime
} from './review/review-format'
import { ReviewTranscript } from './review/ReviewTranscript'
import {
  crmPushDone,
  crmPushKey,
  markCrmPushed,
  markNextStepPushed,
  nextStepPushKey,
  nextStepPushed,
  seedCrmPushed,
  seedNextStepsPushed,
  type CrmPayload,
  type CrmPushPhase,
  type NextStepArgs,
  type NextStepPhase
} from '../lib/review-push-memory'
import { PUSH_FAILED_COPY, REPLACE_EDITED_NOTES_CONFIRMATION } from './review/review-confirmations'
import { ReviewClickupSection } from './review/ReviewClickupSection'
import { ReviewDebrief } from './review/ReviewDebrief'
import { useClickupPush } from './review/useClickupPush'
import { useConfirm } from '../ui/confirm-context'
export {
  crmPushDone,
  crmPushKey,
  markCrmPushed,
  markNextStepPushed,
  nextStepPushed,
  seedCrmPushed,
  type CrmPayload,
  type NextStepArgs
} from '../lib/review-push-memory'

import {
  INCOMPLETE_RECAP_COPY,
  RecapBody,
  coldCallHasPeopleToFollowUp,
  displayedRecapText,
  saveStatusLine
} from './review/review-recap'
import type { EditedRecap } from './review/review-recap'
export {
  INCOMPLETE_RECAP_COPY,
  coldCallHasPeopleToFollowUp,
  displayedRecapText,
  saveStatusLine
} from './review/review-recap'
export type { EditedRecap } from './review/review-recap'

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

export const Review = memo(function Review({
  mode = 'general',
  recap,
  recapStatus,
  lines,
  savedPath,
  saveError,
  saveAttempts,
  maxSaveAttempts,
  saveGaveUp,
  startedAt,
  durationMs,
  showTranscript,
  meetingMeta,
  recovered,
  confidential,
  crmPushedKey,
  clickupPushedKey,
  nextStepsPushedKeys,
  recapEdited,
  summaryOnly,
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
  onUpdateRecap,
  navigationGuard,
  onDirtyChange,
  recapUnavailable,
  finishingTranscript,
  coldCall
}: {
  /** Built-in or custom mode: picks the recap section layout (sales vs recruiting vs meeting, etc.). */
  mode?: string
  recap: AnswerState | null
  /** Durable generation outcome read from the meeting file. Absent means legacy/unspecified. */
  recapStatus?: RecapStatus
  lines: TranscriptLine[]
  savedPath: string | null
  saveError: string | null
  saveAttempts?: number
  maxSaveAttempts?: number
  /** True once App's auto-save ladder has stopped scheduling attempts — see saveStatusLine. */
  saveGaveUp?: boolean
  startedAt?: number
  durationMs?: number
  showTranscript?: boolean // opt-in: auto-expand the full transcript; default summary-only
  meetingMeta?: { title: string; date: string }
  /** True only for a saved meeting marked `status: recovered` in its frontmatter. */
  recovered?: boolean
  /** Task MI-5 — this meeting's saved `confidential` frontmatter flag, so the toggle below reflects the
   *  actual persisted state (a reopened past meeting) instead of always starting unflagged. */
  confidential?: boolean
  /** MQA-092 — this meeting's saved `crm_pushed` fingerprint, so a recap pushed to the CRM before the
   *  last relaunch does not re-arm "Push to CRM". Undefined for a live meeting and for one never pushed. */
  crmPushedKey?: string
  /** Q07 (D4-6) — this meeting's saved `clickup_pushed` fingerprint and `next_steps_pushed` list, so a task that
   *  already landed in the tracker is not offered again after a remount or relaunch. */
  clickupPushedKey?: string
  nextStepsPushedKeys?: string[]
  /** Q07 (D4-3) — the saved notes carry `recap_edited: true`: a person wrote them, so Regenerate asks first. */
  recapEdited?: boolean
  /** Q07 (D4-4) — a managed summary-only meeting keeps no transcript to attach a debrief to, so the panel is hidden. */
  summaryOnly?: boolean
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
   *  "Push to CRM"; ClickUp gates "Push to ClickUp"; other connected kinds (Plane) gate "Book next steps". */
  mcpConnections?: McpConnection[]
  /** Opens a "Recent meetings" row as a read-only past-meeting Review (same handler History uses). */
  onOpenPastMeeting?: (file: string) => void
  /** True when reviewing a past meeting reopened from History, so onDone returns to History rather than starting a new meeting. */
  isPastMeeting?: boolean
  /** Called with the new recap markdown after a successful in-place edit save, so the owner (App) can keep
   *  its own copy (used by Resume + follow-up generation) consistent without a disk re-read. */
  onRecapSaved?: (recap: string) => void
  /** App-owned same-file ordering boundary. Status is intentionally omitted for manual edits. */
  onUpdateRecap?: (file: string, recap: string) => Promise<{ ok: boolean; error?: string }>
  navigationGuard: NavigationGuardService
  /** Mirrors recapDirty (below) up to the owner (App) so its global Escape handler can gate on the same
   *  unsaved-edit check this component's own in-panel exits already run. Called with `false` on unmount. */
  onDirtyChange?: (dirty: boolean, save?: () => Promise<boolean>) => void
  /** Live session only: the recap was deliberately skipped (no AI provider configured) instead of being
   *  fired and left to fail with a red error. Shown in place of the "writing detailed notes…" spinner,
   *  which would otherwise spin forever since no recap request was ever sent. */
  recapUnavailable?: { message: string; onOpenSettings?: () => void }
  /** Live stop is still draining the last ASR windows — show "Finishing transcript…" instead of
   *  pretending the LLM is already writing notes. */
  finishingTranscript?: boolean
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
  const askToConfirm = useConfirm()
  const [copied, flashCopied] = useFlash(1500)
  const [notesCopied, flashNotesCopied] = useFlash(1500)
  const [jsonCopied, flashJsonCopied] = useFlash(1500)
  const [exportError, setExportError] = useState<string | null>(null)
  const [transcriptOpen, setTranscriptOpen] = useState(!!showTranscript)
  useEffect(() => setTranscriptOpen(!!showTranscript), [showTranscript])
  // Task MI-5 — confidential flag: excludes this meeting from every published wiki surface. Local state
  // seeded from the `confidential` prop (the meeting's actual saved value for a reopened past meeting;
  // false for a just-ended live one) and updated optimistically on toggle.
  const [confidentialFlag, setConfidentialFlag] = useState(!!confidential)
  const [confidentialBusy, setConfidentialBusy] = useState(false)
  // Q07 (D4-1): why the last change did not fully take, and the value a retry should aim for.
  const [confidentialError, setConfidentialError] = useState<{ message: string; target: boolean } | null>(null)
  useEffect(() => {
    setConfidentialFlag(!!confidential)
    setConfidentialError(null)
  }, [confidential, savedPath])
  const changeConfidential = async (next: boolean): Promise<void> => {
    if (!savedPath || confidentialBusy) return
    const file = savedPath.split('/').pop() ?? savedPath
    setConfidentialBusy(true)
    setConfidentialFlag(next) // optimistic — reverted below only when main did not save it
    setConfidentialError(null)
    try {
      const r = await window.toto.recallSetConfidential(file, next)
      if (!r.ok) {
        // `flagSaved`: the frontmatter write is durable and only the republish failed, so the toggle keeps the
        // value the file really has and the reason says what is still wrong. Anything else did not save.
        if (!r.flagSaved) setConfidentialFlag(!next)
        setConfidentialError({ message: r.error || "Couldn't change the confidential flag. Try again.", target: next })
      }
    } catch {
      setConfidentialFlag(!next)
      setConfidentialError({ message: "Couldn't change the confidential flag. Try again.", target: next })
    } finally {
      setConfidentialBusy(false)
    }
  }
  const toggleConfidential = (): Promise<void> => changeConfidential(!confidentialFlag)
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
  const recapEditIdentityRef = useRef({ session: 0, draftRevision: 0 })
  // A different meeting loaded into this reused Review instance → drop any in-progress/edited state.
  useEffect(() => {
    recapEditIdentityRef.current.session += 1
    recapEditIdentityRef.current.draftRevision = 0
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
  const startEditRecap = (): void => {
    recapEditIdentityRef.current.session += 1
    recapEditIdentityRef.current.draftRevision = 0
    setRecapDraft(recapText)
    setRecapEditError(null)
    setEditingRecap(true)
  }
  const cancelEditRecap = (): void => {
    recapEditIdentityRef.current.session += 1
    recapEditIdentityRef.current.draftRevision = 0
    setEditingRecap(false)
    setRecapEditError(null)
  }
  // Esc with unsaved changes asks first (Q07, D4-22), through the same "Save recap changes?" sheet as leaving
  // the screen. The Cancel button stays a deliberate discard: pressing it already says "throw this away".
  const requestCancelEditRecap = async (): Promise<void> => {
    if (!recapDirty) {
      cancelEditRecap()
      return
    }
    if (await guardRecapEditNavigation()) cancelEditRecap()
  }
  const handleRecapDraftChange = (draft: string): void => {
    recapEditIdentityRef.current.draftRevision += 1
    setRecapDraft(draft)
  }
  // The dialog may retain this render's save callback while the user edits or reopens the editor.
  // Keep its draft and identity together; an older callback must not borrow the new edit's identity.
  const recapEditSnapshot = { ...recapEditIdentityRef.current }
  const saveRecap = async (): Promise<boolean> => {
    if (
      !savedPath ||
      recapSaving ||
      savedPathRef.current !== savedPath ||
      recapEditIdentityRef.current.session !== recapEditSnapshot.session ||
      recapEditIdentityRef.current.draftRevision !== recapEditSnapshot.draftRevision
    )
      return false
    const forPath = savedPath
    const submittedSession = recapEditSnapshot.session
    const submittedDraftRevision = recapEditSnapshot.draftRevision
    const submittedDraft = recapDraft
    const submittedText = submittedDraft.trim()
    setRecapSaving(true)
    setRecapEditError(null)
    try {
      const file = savedPath.split('/').pop() ?? savedPath
      const r = await (onUpdateRecap
        ? onUpdateRecap(file, submittedDraft)
        : window.toto.recallUpdateRecap(file, submittedDraft))
      // The disk write already targeted the right file, but if the user navigated to a different meeting
      // while it was in flight, drop the result rather than paint meeting A's edit onto meeting B.
      if (savedPathRef.current !== forPath) return false
      if (r.ok) {
        // Store the trimmed value so the in-place copy matches exactly what a disk re-read would return
        // (updateMeetingRecap + recallRead both trim the recap section).
        setEditedRecap({ base: recap?.text ?? '', text: submittedText })
        onRecapSaved?.(submittedText)
        const editIsUnchanged =
          recapEditIdentityRef.current.session === submittedSession &&
          recapEditIdentityRef.current.draftRevision === submittedDraftRevision
        if (editIsUnchanged) setEditingRecap(false)
        return editIsUnchanged
      } else {
        if (recapEditIdentityRef.current.session !== submittedSession) return false
        setRecapEditError(r.error || 'Could not save your changes.')
        return false
      }
    } catch (e) {
      if (savedPathRef.current !== forPath || recapEditIdentityRef.current.session !== submittedSession) return false
      setRecapEditError(`Could not save your changes: ${e instanceof Error ? e.message : String(e)}`)
      return false
    } finally {
      setRecapSaving(false)
    }
  }
  // Surface the dirty state to the owner (App) — its global Escape handler doesn't render inside this
  // component's own exit buttons, so it needs the same async save boundary used below. Reset on unmount so
  // a stale "dirty" flag can never survive after Review closes.
  useEffect(() => {
    onDirtyChange?.(recapDirty, saveRecap)
    return () => onDirtyChange?.(false)
  }, [recapDirty, onDirtyChange, saveRecap])
  // onResume/onDone/"Recent meetings" all navigate away from this screen unconditionally; a reused Review
  // instance would then reset editingRecap/editedRecap (see the savedPath effect above) with the edit never
  // saved. Ask once before leaving; no-op when there is nothing to lose.
  const guardRecapEditNavigation = async (): Promise<boolean> => {
    if (!recapDirty) return true
    const choice = await navigationGuard.request({
      title: 'Save recap changes?',
      message:
        'You have unsaved edits in this recap. Save them before leaving, discard them, or cancel to keep editing.',
      saveLabel: 'Save',
      discardLabel: 'Discard',
      cancelLabel: 'Cancel',
      destructive: true
    })
    if (choice === 'cancel') return false
    if (choice === 'save') return saveRecap()
    return true
  }

  useEffect(() => {
    // Keyed on savedPath (not just mount): the meeting's own async save lands AFTER this screen mounts,
    // so a mount-only fetch never includes the meeting you just finished. Re-fetch when the save resolves.
    window.toto
      .recallList()
      .then((list) => setRecentMeetings(list.slice(0, 20)))
      .catch(() => {})
  }, [savedPath])

  // Drop non-speech captions ("[BELL RINGS]", "(applause)"…) from the displayed/copied transcript. New
  // meetings never carry them (filtered at capture), but meetings saved by older builds still might.
  const speechLines = useMemo(() => lines.filter((l) => !isNonSpeechLine(l.text)), [lines])

  const plain = useMemo(
    () => speechLines.map((l) => `[${clock(l.t)}] ${speakerDisplay(l)}: ${l.text}`).join('\n'),
    [speechLines]
  )

  const durationSec = useMemo(
    () =>
      reviewDurationSeconds({
        durationMs,
        lines,
        startedAt,
        isPastMeeting,
        endedAt: endedAtRef.current
      }),
    [durationMs, lines, startedAt, isPastMeeting]
  )

  const speakerCountLabel = useMemo(() => reviewSpeakerLabel(speechLines), [speechLines])

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

  // Editable follow-up draft: seeded from the streaming followupDraft.text until the user edits it, so
  // their edits never get clobbered by a late token — a fresh draft (new id) re-arms seeding.
  const outlookDraftSubject = meetingMeta?.title ? `Follow-up: ${meetingMeta.title}` : 'Follow-up'
  // startedAt is stable when a live meeting's savedPath arrives later; a regeneration id is not identity.
  const outlookDraftMeeting = startedAt
    ? `started:${startedAt}`
    : savedPath || followupDraft?.id || meetingMeta?.date || ''
  const outlookDraftLifecycleRef = useRef<OutlookDraftLifecycle | null>(null)
  if (!outlookDraftLifecycleRef.current) outlookDraftLifecycleRef.current = new OutlookDraftLifecycle()
  const outlookDraftLifecycle = outlookDraftLifecycleRef.current
  const [followupText, setFollowupText] = useState('')
  const [followupEdited, setFollowupEdited] = useState(false)
  const [followupCopied, flashFollowupCopied] = useFlash(1500)
  const [outlookDraftLocalError, setOutlookDraftLocalError] = useState<string | null>(null)
  const outlookDraftIntentSnapshot = useMemo(
    () => outlookDraftIntent(outlookDraftMeeting, { subject: outlookDraftSubject, body: followupText }),
    [outlookDraftMeeting, outlookDraftSubject, followupText]
  )
  const outlookDraftSession = useSyncExternalStore(
    (listener) => outlookDraftLifecycle.subscribe(outlookDraftIntentSnapshot, listener),
    () => outlookDraftLifecycle.status(outlookDraftIntentSnapshot)
  )
  // Prop-driven meeting/generation replacement must invalidate an older completion before passive effects.
  useLayoutEffect(() => {
    if (outlookDraftLifecycle.select(outlookDraftIntentSnapshot)) {
      setOutlookDraftLocalError(null)
    }
  }, [outlookDraftIntentSnapshot.key, outlookDraftLifecycle])
  useEffect(() => {
    setFollowupEdited(false)
  }, [followupDraft?.id])
  useEffect(() => {
    if (followupDraft?.text != null && !followupEdited) {
      const next = followupDraft.text
      const nextIntent = outlookDraftIntent(outlookDraftMeeting, { subject: outlookDraftSubject, body: next })
      if (outlookDraftLifecycle.select(nextIntent)) setOutlookDraftLocalError(null)
      setFollowupText(next)
    }
  }, [followupDraft?.text, followupEdited, outlookDraftMeeting, outlookDraftSubject, outlookDraftLifecycle])

  const [mailError, setMailError] = useState<string | null>(null)
  const [outlook, setOutlook] = useState<{ signedIn: boolean; canDraft: boolean } | null>(null)
  const recordedEmailIds = useRef(new Set<string>())

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
  // Q07 (D4-6): the same durable memory for ClickUp and next-step tasks.
  useEffect(() => {
    seedNextStepsPushed(nextStepsPushedKeys)
  }, [nextStepsPushedKeys])
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
    // Wave 4 / QA: confidential meetings never leave the device via MCP — same contract as wiki publish.
    if (confidentialFlag) {
      setPushState({ phase: 'error', error: 'This meeting is marked confidential. CRM push is blocked.' })
      return
    }
    // Remember the payload that was actually sent — recapText can move on (an edit, a regeneration) while
    // the call is in flight, and the CRM holds what left here, not what the screen shows when it lands.
    const payload = crmPayload
    const file = savedPath
    setPushState({ phase: 'sending', error: null })
    let r: Awaited<ReturnType<typeof window.toto.mcpPush>>
    try {
      r = await window.toto.mcpPush({
        connectionId: 'bidstack',
        toolName: pushTool,
        args: { ...payload, confidential: confidentialFlag },
        ...(file ? { meetingFile: file.split(/[/\\]/).pop() || file } : {})
      })
    } catch {
      // A rejected IPC must not leave the card on "Pushing…" with its in-flight guard blocking every retry.
      setPushState({ phase: 'error', error: PUSH_FAILED_COPY })
      return
    }
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
  // user reviews the exact per-item payload and clicks Confirm. Plane stays here. ClickUp recap push is
  // the dedicated "Push to ClickUp" panel (create-task, named list) — next steps still allow per-item
  // tasks into that same list.
  const taskConnections = useMemo(
    () => (mcpConnections ?? []).filter((c) => c.kind !== 'bidstack' && c.connected),
    [mcpConnections]
  )
  const clickupConn = mcpConnections?.find((c) => c.kind === 'clickup' && c.connected)
  const clickup = useClickupPush({
    clickupConn,
    savedPath,
    confidentialFlag,
    payload: crmPayload,
    clickupPushedKey
  })
  const { destName: clickupDestName, resolving: clickupResolving, ensureDest: ensureClickupDest } = clickup
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
    void ensureClickupDest()
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
    const target = connId === 'clickup' ? '' : (connTarget[connId] || '').trim()
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
    if (confidentialFlag) {
      // Same gate as sendToCrm — never enqueue Plane/ClickUp tasks for a confidential meeting.
      setNextStepsFetchError('This meeting is marked confidential. Task push is blocked.')
      return
    }
    const items = nextStepsData.map((it, i) => ({ item: it, i })).filter(({ i }) => itemChecked[i])
    const conns = taskConnections.filter((c) => connChecked[c.id] ?? true)
    for (const { item, i } of items) {
      for (const conn of conns) {
        const tool = conn.kind === 'clickup' ? 'clickup_create_task' : connTool[conn.id] || conn.tools[0]
        if (!tool) continue
        const args = nextStepArgs(item, i, conn.id)
        const key = `${i}:${conn.id}`
        if (nextStepPushed(stepStatus[key]?.phase ?? 'idle', conn.id, args)) continue
        setStepStatus((s) => ({ ...s, [key]: { phase: 'sending', error: null } }))
        let r: Awaited<ReturnType<typeof window.toto.mcpPush>>
        try {
          r = await window.toto.mcpPush({
            connectionId: conn.id,
            toolName: tool,
            args: { ...args, confidential: confidentialFlag },
            ...(savedPath ? { meetingFile: savedPath.split(/[/\\]/).pop() || savedPath } : {})
          })
        } catch {
          // One rejected push must not strand this card on "Sending" or abort the rest of the batch.
          setStepStatus((s) => ({ ...s, [key]: { phase: 'error', error: PUSH_FAILED_COPY } }))
          continue
        }
        if (r.ok) {
          markNextStepPushed(conn.id, args)
          // Durable half (Q07, D4-6): the task exists, so recording it is best-effort and never a push failure.
          if (savedPath) {
            void window.toto
              .recallSetPushMarker(
                savedPath.split(/[/\\]/).pop() || savedPath,
                'next_steps_pushed',
                nextStepPushKey(conn.id, args)
              )
              .catch(() => {})
          }
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

  useEffect(() => {
    let alive = true
    void window.toto
      .outlookWriteStatus()
      .then((s) => {
        if (alive) setOutlook({ signedIn: s.signedIn, canDraft: s.canDraft })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const id = followupDraft?.id
    if (!id || followupDraft.streaming || followupDraft.error || !followupDraft.text?.trim()) return
    if (recordedEmailIds.current.has(id)) return
    recordedEmailIds.current.add(id)
    void window.toto.timeSavedRecord({ kind: 'email-summary' }).catch(() => {})
  }, [followupDraft?.id, followupDraft?.streaming, followupDraft?.error, followupDraft?.text])

  const createOutlookDraft = async (): Promise<void> => {
    if (!followupText.trim()) return
    if (!outlook?.signedIn || !outlook.canDraft) {
      setOutlookDraftLocalError(
        outlook?.signedIn
          ? 'Outlook draft permission is not granted. Métis will not send mail. Use Open in Mail.'
          : 'Connect Outlook in Settings → Calendar. Métis will not send mail.'
      )
      return
    }
    const attempt = outlookDraftLifecycle.start(outlookDraftIntentSnapshot, (payload) =>
      window.toto.outlookCreateDraft(payload)
    )
    // The lifecycle flips its in-flight guard synchronously, before React commits `saving`.
    if (!attempt) return
    setOutlookDraftLocalError(null)
    await attempt
  }

  return (
    <div className="flex flex-col gap-3">
      {isPastMeeting && recovered === true && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-amber-400/25 bg-amber-400/[0.08] px-3 py-2 text-[12px] text-[color:var(--color-ink-2)]"
        >
          This meeting was recovered after an interruption. Review the transcript and notes.
        </div>
      )}
      {meetingMeta && (
        <div className="mb-0.5">
          <div
            className="font-ui text-[15px] font-semibold text-[color:var(--color-ink)]"
            aria-label="Review meeting title"
          >
            {meetingMeta.title}
          </div>
          <div className="mt-0.5 text-[12px] text-[color:var(--color-ink-3)]">{meetingMeta.date}</div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 text-[11px] text-[color:var(--color-ink-2)]">
        <div className="flex items-center gap-2">
          {durationSec > 0 && (
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5">Duration {formatDuration(durationSec)}</span>
          )}
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5">{speakerCountLabel}</span>
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
                style={pct >= 70 ? { color: 'var(--color-warn)' } : undefined}
              >
                You spoke {pct}%
              </span>
            )
          })()}
        </div>
        <div className="flex items-center gap-1.5">
          {onResume && (
            <span data-metis-meeting-start>
              <Chip
                icon={Play}
                onClick={() => {
                  void (async () => {
                    if (await guardRecapEditNavigation()) onResume()
                  })()
                }}
                variant="accent"
              >
                Resume session
              </Chip>
            </span>
          )}
          {onSave && (
            // A missing recap must not block saving captured speech: keyless, cancelled-before-token and
            // hollow-summary sessions still have an ASR transcript worth keeping.
            <TextButton icon={Save} onClick={onSave} disabled={lines.length === 0 || !!savedPath || !!recap?.streaming}>
              Save
            </TextButton>
          )}
          {onDiscard && (
            <TextButton icon={Trash2} onClick={onDiscard} title="Discard this meeting without keeping it">
              Disregard
            </TextButton>
          )}
          {onDone && (
            <Chip
              icon={isPastMeeting ? ArrowLeft : RotateCcw}
              onClick={() => {
                void (async () => {
                  if (await guardRecapEditNavigation()) onDone()
                })()
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
        <>
          <button
            type="button"
            onClick={() => void toggleConfidential()}
            disabled={confidentialBusy}
            aria-pressed={confidentialFlag}
            aria-describedby={confidentialError ? 'review-confidential-error' : undefined}
            className={[
              'no-drag focus-ring flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-[12px] disabled:opacity-60',
              confidentialFlag
                ? 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10'
                : 'border-[var(--color-hair-soft)] bg-white/[0.02] hover:bg-white/[0.05]'
            ].join(' ')}
          >
            <Lock
              size={13}
              className={confidentialFlag ? 'text-[var(--color-danger)]' : 'text-[color:var(--color-ink-3)]'}
            />
            <span className="flex-1 text-[color:var(--color-ink-2)]">
              {confidentialFlag
                ? 'Confidential: excluded from published intelligence.'
                : 'Confidential: exclude from published intelligence'}
            </span>
            <span
              className={
                confidentialFlag ? 'font-medium text-[var(--color-danger)]' : 'text-[color:var(--color-ink-3)]'
              }
            >
              {confidentialFlag ? 'On' : 'Off'}
            </span>
          </button>
          {confidentialError && (
            <div
              id="review-confidential-error"
              role="alert"
              className="flex items-start gap-1.5 px-1 text-[11px] text-[var(--color-danger)]"
            >
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span className="flex-1">{confidentialError.message}</span>
              <TextButton onClick={() => void changeConfidential(confidentialError.target)} disabled={confidentialBusy}>
                Try Again
              </TextButton>
            </div>
          )}
        </>
      )}

      {/* Entities in this meeting (Task MI-3) — the moment-of-truth correction strip. Renders nothing
          until the meeting's extraction lands (and never when the brain is off), so it can't shift the
          layout for anyone else; dismissible; blocks no other Review interaction. */}
      <ReviewEntityStrip file={savedPath} />

      {/* 90-SECOND DEBRIEF: live reviews only, and never for a summary-only meeting (it keeps no transcript to
          attach it to). */}
      {savedPath && !meetingMeta && !summaryOnly && <ReviewDebrief key={savedPath} savedPath={savedPath} />}

      <section ref={summaryRef} tabIndex={-1} aria-live="polite" aria-atomic="false">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            <ListTree size={12} /> Summary
          </div>
          {editingRecap ? (
            // Edit mode toolbar: Save / Cancel. Replaces Copy/Export, which don't apply mid-edit.
            <div className="flex items-center gap-1">
              <Chip onClick={() => void saveRecap()} variant="accent" disabled={recapSaving}>
                {recapSaving ? <InlineOrb kind="writing" /> : <Check size={13} />}
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
                  {recap?.streaming ? <AgentStatus kind="writing" size="inline" caption /> : <Sparkles size={13} />}
                  {recap?.streaming ? null : 'Generate recap'}
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
                      onClick={async () => {
                        // Q07 (D4-3): notes a person edited are not the generation's to replace without asking.
                        if (recapEdited || editedRecap !== null) {
                          if (!(await askToConfirm(REPLACE_EDITED_NOTES_CONFIRMATION))) return
                        }
                        summaryRef.current?.focus()
                        onRetryRecap?.()
                      }}
                      disabled={recap?.streaming}
                      title="Regenerate this summary from the transcript"
                    >
                      {recap?.streaming ? <InlineOrb kind="writing" /> : <RotateCcw size={11} />}
                      {recap?.streaming
                        ? 'Regenerating'
                        : recapStatus === 'incomplete'
                          ? 'Retry summary'
                          : 'Regenerate'}
                    </TextButton>
                  )}
                  <TextButton
                    onClick={exportJson}
                    title="Copy structured JSON (decisions + action items) for Jira/Asana/Notion"
                  >
                    {jsonCopied ? <Check size={11} className="text-[var(--color-success)]" /> : <Download size={11} />}
                    {jsonCopied ? 'Copied' : 'Export JSON'}
                  </TextButton>
                  <RecapPdfExportButton markdown={recapText} title={meetingMeta?.title} />
                </>
              )}
            </div>
          )}
        </div>
        {exportError && <div className="mb-1.5 text-[11px] text-[var(--color-danger)]">{exportError}</div>}
        {recapStatus === 'incomplete' && (
          <div className="mb-2 rounded-lg border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-2.5 py-2 text-[12px] text-[color:var(--color-ink-2)]">
            {INCOMPLETE_RECAP_COPY}
          </div>
        )}
        {editingRecap ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={recapDraft}
              autoFocus
              onChange={(e) => handleRecapDraftChange(e.target.value)}
              onKeyDown={(e) => {
                // Escape cancels; stopPropagation keeps it from bubbling to App's global Escape handler
                // (which would otherwise act on the whole overlay). Cmd/Ctrl+Enter saves, matching the
                // app's other commit shortcuts.
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  void requestCancelEditRecap()
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
              Markdown supported. Changes are saved to this meeting. {accelLabel('CommandOrControl+Return')} to save,
              Esc to cancel.
            </div>
          </div>
        ) : recap?.error ? (
          <div className="flex flex-col gap-2">
            {/* Substantial streamed notes stay visible — a trailing idle-timeout used to hide them
                behind the error alone and autosave used to wipe them. Show what we have + Retry. */}
            {!!recapText.trim() && (
              <div className="opacity-90">
                <RecapBody text={recapText} mode={mode} />
              </div>
            )}
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
          <RecapBody text={recapText} mode={mode} />
        ) : recap?.streaming ? (
          // A past meeting's retroactive "Generate recap" (or a just-finished import) is in flight —
          // recap here is recapGen's live streaming answer, not the static (still-empty) saved recap.
          <AgentStatus kind="writing" size="hero" />
        ) : recapStatus === 'incomplete' ? (
          <div className="flex flex-col gap-2">
            <div className="text-[13px] text-[color:var(--color-ink-2)]">No summary text was generated.</div>
            {onRetryRecap && (
              <div className="flex items-center gap-1.5">
                <TextButton icon={RotateCcw} onClick={onRetryRecap}>
                  Retry summary
                </TextButton>
              </div>
            )}
          </div>
        ) : isPastMeeting ? (
          // A past meeting saved without a recap (e.g. a keyless summary failure) and nothing generating
          // right now. Not a spinner — the work is long over; offer to add notes instead.
          <div className="text-[13px] text-[color:var(--color-ink-2)]">
            No notes saved for this meeting. Select Edit to add some.
          </div>
        ) : !recap && lines.length === 0 ? (
          <div className="text-[13px] text-[color:var(--color-ink-2)]">No speech was captured this session.</div>
        ) : recapUnavailable ? (
          // No AI provider configured — the recap was never requested (see App.tsx maybeFireRecap), so
          // without this branch a transcript with no recap would fall through to the spinner below and
          // spin forever. Neutral, not an error: transcription/recording still worked.
          <div className="flex flex-col gap-2">
            <div className="text-[13px] text-[color:var(--color-ink-2)]">{recapUnavailable.message}</div>
            {recapUnavailable.onOpenSettings && (
              <div className="flex items-center gap-1.5">
                <TextButton onClick={recapUnavailable.onOpenSettings}>Open Settings</TextButton>
              </div>
            )}
          </div>
        ) : finishingTranscript ? (
          <div className="flex items-center gap-2 py-1 text-[13px] text-[color:var(--color-ink-2)]">
            <Spinner size={13} /> finishing transcript…
          </div>
        ) : (
          <AgentStatus kind="writing" size="hero" />
        )}
      </section>

      {coldCall && !editingRecap && (
        <section aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <PhoneCall size={12} /> Cold call coaching
            </div>
            {coldCall.coaching?.error && coldCall.onRetryCoaching && (
              <TextButton icon={RotateCcw} onClick={coldCall.onRetryCoaching}>
                Retry
              </TextButton>
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
                      <TextButton icon={RotateCcw} onClick={coldCall.onBookMeetings}>
                        Retry
                      </TextButton>
                    </div>
                  ) : coldCall.booking ? (
                    <div className="flex flex-col gap-2">
                      {coldCall.booking.streaming && !coldCall.booking.text ? (
                        <AgentStatus kind="writing" size="inline" caption />
                      ) : (
                        <Markdown>{coldCall.booking.text}</Markdown>
                      )}
                      {!coldCall.booking.streaming && (
                        <div className="flex items-center gap-1.5">
                          <TextButton icon={RotateCcw} onClick={coldCall.onBookMeetings}>
                            Redo
                          </TextButton>
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
            <AgentStatus kind="writing" size="hero" />
          ) : (
            // coaching === null means it was never STARTED (the call ended with nothing transcribed, so
            // generateColdCallCoaching returned early). Showing the spinner here — as this branch used to —
            // left a call that produced no audio spinning forever, with no error and no Retry, because
            // Retry only renders on an error. Offer the action instead of pretending work is in flight.
            <div className="flex items-center justify-between gap-2 py-1">
              <span className="text-[13px] text-[color:var(--color-ink-3)]">
                No coaching notes yet. Nothing was transcribed from this call.
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
                <TextButton icon={RotateCcw} onClick={onGenerateFollowup}>
                  Retry
                </TextButton>
              </div>
            </div>
          ) : followupDraft?.streaming && !followupText ? (
            <AgentStatus kind="writing" size="hero" />
          ) : followupDraft ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={followupText}
                onChange={(e) => {
                  const next = e.target.value
                  const nextIntent = outlookDraftIntent(outlookDraftMeeting, {
                    subject: outlookDraftSubject,
                    body: next
                  })
                  if (outlookDraftLifecycle.select(nextIntent)) setOutlookDraftLocalError(null)
                  setFollowupEdited(true)
                  setFollowupText(next)
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
                {outlook?.signedIn && outlook.canDraft ? (
                  <TextButton
                    onClick={() => void createOutlookDraft()}
                    disabled={
                      !followupText || outlookDraftSession.phase === 'saving' || outlookDraftSession.phase === 'saved'
                    }
                  >
                    <Mail size={11} />{' '}
                    {outlookDraftSession.phase === 'saved'
                      ? 'Draft created'
                      : outlookDraftSession.phase === 'saving'
                        ? 'Creating draft…'
                        : 'Create Outlook draft'}
                  </TextButton>
                ) : (
                  <TextButton
                    onClick={() =>
                      setOutlookDraftLocalError('Connect Outlook in Settings → Calendar. Métis will not send mail.')
                    }
                  >
                    <Mail size={11} /> Connect Outlook
                  </TextButton>
                )}
                <TextButton icon={RotateCcw} onClick={onGenerateFollowup}>
                  Regenerate
                </TextButton>
              </div>
              {mailError && <div className="text-[11px] text-[var(--color-danger)]">{mailError}</div>}
              {(outlookDraftLocalError || outlookDraftSession.error) && (
                <div className="text-[11px] text-[var(--color-danger)]">
                  {outlookDraftLocalError || outlookDraftSession.error}
                </div>
              )}
              <div className="text-[11px] text-[color:var(--color-ink-3)]">
                Review before sending. Outlook creates a draft only. Nothing sends itself.
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
            {bidstackConnected && !pushOpen && !crmPushed && !confidentialFlag && (
              <Chip onClick={() => setPushOpen(true)} variant="accent">
                <Send size={13} /> Push to CRM
              </Chip>
            )}
            {confidentialFlag && bidstackConnected && (
              <span className="text-[11px] text-[color:var(--color-ink-3)]">CRM push blocked (confidential)</span>
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
                  Polo Pre-Sales has no tools in this key's scope, so there's nothing to push to. Check the key's scopes
                  in Settings.
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
                  <Chip onClick={() => void sendToCrm()} variant="accent" disabled={pushState.phase === 'sending'}>
                    {pushState.phase === 'sending' ? <InlineOrb kind="connecting" /> : <Send size={13} />}
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

      {recapText && !recap?.error && !editingRecap && clickupConn && (
        <ReviewClickupSection push={clickup} payload={crmPayload} confidentialFlag={confidentialFlag} />
      )}

      {recapText && !recap?.error && !editingRecap && taskConnections.length > 0 && (
        <section aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <ListTree size={12} /> Next steps
            </div>
            {!nextStepsOpen && !confidentialFlag && (
              <Chip onClick={() => void openNextSteps()} variant="accent">
                <ListTree size={13} /> Book next steps
              </Chip>
            )}
            {confidentialFlag && (
              <span className="text-[11px] text-[color:var(--color-ink-3)]">Task push blocked (confidential)</span>
            )}
          </div>

          {nextStepsOpen && (
            <div className="flex flex-col gap-3">
              {nextStepsLoading ? (
                <AgentStatus kind="searching" size="inline" caption />
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
                        <div
                          key={conn.id}
                          className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-2.5"
                        >
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
                              {conn.kind === 'clickup' ? (
                                <div className="text-[11px] text-[color:var(--color-ink-2)]">
                                  {clickupResolving
                                    ? 'Finding the ClickUp list…'
                                    : clickupDestName
                                      ? `Task in ${clickupDestName}`
                                      : 'ClickUp could not name the destination.'}
                                </div>
                              ) : (
                                <>
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
                                </>
                              )}
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
                            <div
                              key={key}
                              className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-2.5 text-[12px]"
                            >
                              <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
                                <span>{conn.label}</span>
                                {done ? (
                                  <span className="flex items-center gap-1 text-[var(--color-success)]">
                                    <Check size={11} /> Sent
                                  </span>
                                ) : status?.phase === 'sending' ? (
                                  <span className="flex items-center gap-1 text-[color:var(--color-ink-3)]">
                                    <InlineOrb kind="connecting" /> Sending
                                  </span>
                                ) : null}
                              </div>
                              <div className="text-[color:var(--color-ink)]">{args.title}</div>
                              {conn.kind === 'clickup' && clickupDestName ? (
                                <div className="mt-0.5 text-[11px] text-[color:var(--color-ink-3)]">
                                  Task in {clickupDestName}
                                </div>
                              ) : null}
                              <div className="mt-0.5 whitespace-pre-wrap text-[color:var(--color-ink-2)]">
                                {args.description}
                              </div>
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
                      {pushingNextSteps ? <InlineOrb kind="connecting" /> : <ListTree size={13} />}
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

      {lines.length === 0 ? null : (
        <ReviewTranscript
          savedFile={isPastMeeting ? savedPath?.split('/').pop() : null}
          speechLines={speechLines}
          open={transcriptOpen}
          onOpenChange={setTranscriptOpen}
          copied={copied}
          copyError={copyError}
          onCopy={copy}
        />
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
                      void (async () => {
                        if (await guardRecapEditNavigation()) onOpenPastMeeting?.(item.file)
                      })()
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
