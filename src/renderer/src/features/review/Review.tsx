import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { transcriptDisplayName } from '@shared/speaker-names'
import { Copy, Check, FileText, ListTree, FolderOpen, Save, RotateCcw, Play, ChevronDown, Download, Clock, Mail, Send, AlertCircle, EarOff, ArrowLeft, Pencil, X, Sparkles, Trash2, Lock, PhoneCall } from 'lucide-react'
import type { TranscriptLine, MeetingSummary, McpConnection, RecapExport } from '@shared/ipc'
import type { RecapStatus } from '@shared/recap-status'
import type { AnswerState } from '../../state'
import type { NavigationGuardService } from '../../lib/navigation-guard'
import { isNonSpeechLine } from '@shared/transcript-filter'
import { reviewDurationSeconds } from '@shared/meeting-duration'
import { reviewSpeakerLabel } from '@shared/speaker-summary'
import { talkStats } from '@shared/talkstats'
import { fnv1a } from '@shared/hash'
import { Markdown } from '../../components/Markdown'
import { ModeRecapView, modeRecapSections } from '../../components/ModeRecap'
import { Chip, TextButton, Spinner } from '../../components/ui'
import { AgentStatus, InlineOrb } from '../../components/AgentStatus'
import { ReviewEntityStrip } from '../../components/ReviewEntityStrip'
import { useFlash } from '../../lib/useFlash'
import { accelLabel } from '../../lib/keys'
import { OutlookDraftLifecycle, outlookDraftIntent } from '../../components/outlook-draft-lifecycle'
import { VirtualList } from '../../ui/VirtualList'
import { ReviewLayout } from './ReviewLayout'
import {
  INCOMPLETE_RECAP_COPY,
  clock,
  speakerDisplay,
  crmPushDone,
  crmPushKey,
  displayedRecapText,
  markCrmPushed,
  markNextStepPushed,
  nextStepPushed,
  saveStatusLine,
  seedCrmPushed,
  type CrmPayload,
  type EditedRecap,
  type CrmPushPhase,
  type NextStepArgs,
  type NextStepPhase
} from './review-helpers'
export {
  INCOMPLETE_RECAP_COPY,
  TranscriptRow,
  coldCallHasPeopleToFollowUp,
  crmPushDone,
  crmPushKey,
  displayedRecapText,
  markCrmPushed,
  markNextStepPushed,
  nextStepPushed,
  saveStatusLine,
  seedCrmPushed,
  type CrmPayload,
  type EditedRecap,
  type NextStepArgs
} from './review-helpers'
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
  const [copied, flashCopied] = useFlash(1500)
  const [notesCopied, flashNotesCopied] = useFlash(1500)
  const [jsonCopied, flashJsonCopied] = useFlash(1500)
  const [exportError, setExportError] = useState<string | null>(null)
  const [transcriptOpen, setTranscriptOpen] = useState(!!showTranscript)
  useEffect(() => setTranscriptOpen(!!showTranscript), [showTranscript])
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
  const endedAtRef = useRef(Date.now())
  const [recentMeetings, setRecentMeetings] = useState<MeetingSummary[]>([])
  const summaryRef = useRef<HTMLElement>(null)
  const [editingRecap, setEditingRecap] = useState(false)
  const [recapDraft, setRecapDraft] = useState('')
  const [recapSaving, setRecapSaving] = useState(false)
  const [recapEditError, setRecapEditError] = useState<string | null>(null)
  const [editedRecap, setEditedRecap] = useState<EditedRecap | null>(null)
  useEffect(() => {
    setEditingRecap(false)
    setEditedRecap(null)
    setRecapEditError(null)
  }, [savedPath])
  useEffect(() => {
    setEditedRecap(null)
  }, [recap?.id])
  const savedPathRef = useRef(savedPath)
  useEffect(() => {
    savedPathRef.current = savedPath
  }, [savedPath])
  const recapText = displayedRecapText(editedRecap, recap?.text)
  const recapDirty = editingRecap && recapDraft !== recapText
  const startEditRecap = (): void => {
    setRecapDraft(recapText)
    setRecapEditError(null)
    setEditingRecap(true)
  }
  const cancelEditRecap = (): void => {
    setEditingRecap(false)
    setRecapEditError(null)
  }
  const saveRecap = async (): Promise<boolean> => {
    if (!savedPath || recapSaving) return false
    const forPath = savedPath
    setRecapSaving(true)
    setRecapEditError(null)
    try {
      const file = savedPath.split('/').pop() ?? savedPath
      const r = await (onUpdateRecap
        ? onUpdateRecap(file, recapDraft)
        : window.toto.recallUpdateRecap(file, recapDraft))
      if (savedPathRef.current !== forPath) return false
      if (r.ok) {
        const saved = recapDraft.trim()
        setEditedRecap({ base: recap?.text ?? '', text: saved })
        onRecapSaved?.(saved)
        setEditingRecap(false)
        return true
      } else {
        setRecapEditError(r.error || 'Could not save your changes.')
        return false
      }
    } catch (e) {
      if (savedPathRef.current !== forPath) return false
      setRecapEditError(`Could not save your changes: ${e instanceof Error ? e.message : String(e)}`)
      return false
    } finally {
      setRecapSaving(false)
    }
  }
  useEffect(() => {
    onDirtyChange?.(recapDirty, saveRecap)
    return () => onDirtyChange?.(false)
  }, [recapDirty, onDirtyChange, saveRecap])
  const guardRecapEditNavigation = async (): Promise<boolean> => {
    if (!recapDirty) return true
    const choice = await navigationGuard.request({
      title: 'Save recap changes?',
      message: 'You have unsaved edits in this recap. Save them before leaving, discard them, or cancel to keep editing.',
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
    window.toto.recallList().then((list) => setRecentMeetings(list.slice(0, 20))).catch(() => {})
  }, [savedPath])
  const speechLines = useMemo(() => lines.filter((l) => !isNonSpeechLine(l.text)), [lines])
  const plain = useMemo(
    () => speechLines.map((l) => `[${clock(l.t)}] ${speakerDisplay(l)}: ${l.text}`).join('\n'),
    [speechLines]
  )
  const durationSec = useMemo(() => reviewDurationSeconds({
    durationMs, lines, startedAt, isPastMeeting, endedAt: endedAtRef.current
  }), [durationMs, lines, startedAt, isPastMeeting])
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
  const outlookDraftSubject = meetingMeta?.title ? `Follow-up: ${meetingMeta.title}` : 'Follow-up'
  const outlookDraftMeeting = startedAt ? `started:${startedAt}` : savedPath || followupDraft?.id || meetingMeta?.date || ''
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
  const bidstackConn = mcpConnections?.find((c) => c.id === 'bidstack')
  const bidstackConnected = bidstackConn?.connected ?? false
  const bidstackTools = bidstackConn?.tools ?? []
  const [pushOpen, setPushOpen] = useState(false)
  const [pushTool, setPushTool] = useState('')
  const [pushState, setPushState] = useState<{ phase: CrmPushPhase; error: string | null }>({
    phase: 'idle',
    error: null
  })
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
  useEffect(() => {
    seedCrmPushed(crmPushedKey)
  }, [crmPushedKey])
  const crmPayloadKey = crmPushKey(crmPayload)
  useEffect(() => {
    if (!savedPath || pendingCrmMarker !== crmPayloadKey) return
    pendingCrmMarker = null
    void window.toto.recallSetCrmPushed(savedPath, crmPayloadKey).catch(() => {})
  }, [savedPath, crmPayloadKey])
  const crmPushed = crmPushDone(pushState.phase, crmPayload)
  const sendToCrm = async (): Promise<void> => {
    if (pushState.phase === 'sending') return
    if (!pushTool) return
    if (confidentialFlag) {
      setPushState({ phase: 'error', error: 'This meeting is marked confidential. CRM push is blocked.' })
      return
    }
    const payload = crmPayload
    const file = savedPath
    setPushState({ phase: 'sending', error: null })
    const r = await window.toto.mcpPush({
      connectionId: 'bidstack',
      toolName: pushTool,
      args: { ...payload, confidential: confidentialFlag },
      ...(file ? { meetingFile: file.split(/[/\\]/).pop() || file } : {})
    })
    if (r.ok) {
      markCrmPushed(payload)
      setPushState({ phase: 'sent', error: null })
      if (file) void window.toto.recallSetCrmPushed(file, crmPushKey(payload)).catch(() => {})
      else pendingCrmMarker = crmPushKey(payload)
    } else {
      setPushState({ phase: 'error', error: r.error || 'Push failed.' })
    }
  }
  const taskConnections = useMemo(
    () => (mcpConnections ?? []).filter((c) => c.kind !== 'bidstack' && c.connected),
    [mcpConnections]
  )
  const clickupConn = mcpConnections?.find((c) => c.kind === 'clickup' && c.connected)
  const [clickupResolvedDest, setClickupResolvedDest] = useState('')
  const [clickupResolving, setClickupResolving] = useState(false)
  const clickupDiscoveringRef = useRef(false)
  const clickupDestName = (clickupResolvedDest || clickupConn?.clickupListName || clickupConn?.clickupListId || '').trim()
  const [clickupOpen, setClickupOpen] = useState(false)
  const [clickupState, setClickupState] = useState<{ phase: CrmPushPhase; error: string | null; destinationName?: string; taskUrl?: string }>({
    phase: 'idle',
    error: null
  })
  useEffect(() => {
    setClickupOpen(false)
    setClickupState({ phase: 'idle', error: null })
    setClickupResolvedDest('')
    setClickupResolving(false)
    clickupDiscoveringRef.current = false
  }, [savedPath])
  const ensureClickupDest = async (): Promise<void> => {
    if (!clickupConn) return
    if (clickupDestName || clickupDiscoveringRef.current) return
    clickupDiscoveringRef.current = true
    setClickupResolving(true)
    try {
      const r = await window.toto.mcpClickupDiscoverDestination()
      const named = (r.clickupListName || r.clickupListId || '').trim()
      if (r.ok && named) {
        setClickupResolvedDest(named)
        setClickupState((s) =>
          s.phase === 'error' && /could not name the destination/i.test(s.error || '')
            ? { phase: 'idle', error: null }
            : s
        )
      } else {
        setClickupState({ phase: 'error', error: r.error || 'ClickUp could not name the destination.' })
      }
    } finally {
      clickupDiscoveringRef.current = false
      setClickupResolving(false)
    }
  }
  const sendToClickup = async (): Promise<void> => {
    if (clickupState.phase === 'sending' || !clickupConn) return
    if (confidentialFlag) {
      setClickupState({ phase: 'error', error: 'This meeting is marked confidential. ClickUp push is blocked.' })
      return
    }
    if (!clickupDestName) {
      setClickupState({ phase: 'error', error: 'ClickUp could not name the destination.' })
      return
    }
    const file = savedPath
    setClickupState({ phase: 'sending', error: null })
    const r = await window.toto.mcpPush({
      connectionId: 'clickup',
      toolName: 'clickup_create_task',
      args: {
        name: crmPayload.title,
        title: crmPayload.title,
        description: crmPayload.summary,
        confidential: confidentialFlag
      },
      ...(file ? { meetingFile: file.split(/[/\\]/).pop() || file } : {})
    })
    if (r.ok) {
      setClickupState({
        phase: 'sent',
        error: null,
        destinationName: r.destinationName || clickupDestName,
        taskUrl: r.taskUrl
      })
    } else {
      setClickupState({ phase: 'error', error: r.error || 'ClickUp rejected the task.' })
    }
  }
  const [nextStepsOpen, setNextStepsOpen] = useState(false)
  const [nextStepsData, setNextStepsData] = useState<RecapExport['actionItems'] | null>(null)
  const [nextStepsLoading, setNextStepsLoading] = useState(false)
  const [nextStepsFetchError, setNextStepsFetchError] = useState<string | null>(null)
  const [itemChecked, setItemChecked] = useState<Record<number, boolean>>({})
  const [itemTitle, setItemTitle] = useState<Record<number, string>>({})
  const [connChecked, setConnChecked] = useState<Record<string, boolean>>({})
  const [connTool, setConnTool] = useState<Record<string, string>>({})
  const [connTarget, setConnTarget] = useState<Record<string, string>>({})
  const [stepStatus, setStepStatus] = useState<Record<string, { phase: NextStepPhase; error: string | null }>>({})
  const pushingNextStepsRef = useRef(false)
  const [pushingNextSteps, setPushingNextSteps] = useState(false)
  const [nextStepsSource, setNextStepsSource] = useState<string | null>(null)
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
    if (nextStepsLoading || (nextStepsData && nextStepsSource === recapText)) return
    await loadNextSteps()
  }
  useEffect(() => {
    if (!nextStepsOpen || nextStepsLoading || recap?.streaming) return
    if (nextStepsSource !== null && nextStepsSource !== recapText) void loadNextSteps()
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
        const r = await window.toto.mcpPush({
          connectionId: conn.id,
          toolName: tool,
          args: { ...args, confidential: confidentialFlag },
          ...(savedPath ? { meetingFile: savedPath.split(/[/\\]/).pop() || savedPath } : {})
        })
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
        outlook?.signedIn ? 'Outlook draft permission is not granted. Métis will not send mail. Use Open in Mail.' : 'Connect Outlook in Settings → Calendar. Métis will not send mail.'
      )
      return
    }
    const attempt = outlookDraftLifecycle.start(outlookDraftIntentSnapshot, (payload) =>
      window.toto.outlookCreateDraft(payload)
    )
    if (!attempt) return
    setOutlookDraftLocalError(null)
    await attempt
  }
  return (
    <ReviewLayout
      {...{
        mode, recap, recapStatus, lines, savedPath, saveError, saveAttempts, maxSaveAttempts, saveGaveUp, meetingMeta, onOpenFolder, onSave, onDiscard, onDone, onResume, onRetryRecap, onGenerateRecap, onOpenPastMeeting, isPastMeeting, recapUnavailable, finishingTranscript, coldCall, copied, notesCopied, jsonCopied, exportError, transcriptOpen, setTranscriptOpen, confidentialFlag, confidentialBusy, toggleConfidential, debrief, setDebrief, debriefState, saveDebrief, recentMeetings, summaryRef, editingRecap, recapDraft, setRecapDraft, recapSaving, recapEditError, recapText, startEditRecap, cancelEditRecap, saveRecap, guardRecapEditNavigation, speechLines, durationSec, speakerCountLabel, copyError, copy, copyNotes, exportJson, exportPdf, pdfBusy, followupDraft, onGenerateFollowup, winsToggle, followupText, setFollowupText, followupEdited, setFollowupEdited, followupCopied, copyFollowup, openFollowupInMail, createOutlookDraft, outlookDraftSession, outlookDraftLocalError, mailError, outlook, outlookDraftIntentSnapshot, outlookDraftLifecycle, outlookDraftMeeting, outlookDraftSubject, setOutlookDraftLocalError, bidstackConnected, bidstackTools, pushOpen, setPushOpen, pushTool, setPushTool, pushState, setPushState, crmPayload, crmPushed, sendToCrm, clickupConn, clickupDestName, clickupOpen, setClickupOpen, clickupState, setClickupState, clickupResolving, ensureClickupDest, sendToClickup, taskConnections, nextStepsOpen, setNextStepsOpen, nextStepsData, nextStepsLoading, nextStepsFetchError, itemChecked, setItemChecked, itemTitle, setItemTitle, connChecked, setConnChecked, connTool, setConnTool, connTarget, setConnTarget, stepStatus, pushingNextSteps, openNextSteps, nextStepArgs, confirmNextSteps
      }}
    />
  )
})
