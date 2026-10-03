import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Search,
  FolderOpen,
  FileDown,
  FileText,
  Network,
  ExternalLink,
  ChevronLeft,
  Trash2,
  Pencil,
  Brain,
  Upload,
  Lock
} from 'lucide-react'
import { TextButton } from '../../components/ui'
import { AgentStatus, InlineOrb } from '../../components/AgentStatus'
import { WorkProgressMeter } from '../../components/WorkProgressMeter'
import { describeMeetingIndexProgress } from '../../components/work-progress'
import { IntelligenceUpdateButton } from '../../components/IntelligenceUpdateButton'
import { runIntelligenceUpdateClick } from '../../lib/intelligence-update'
import { beginHistoryRequest, type HistoryRequest } from '../../lib/history-trace'
import { brainStatusError, brainStatusIsWorking } from '../../components/brain-status-refresh'
import { INTELLIGENCE_STATUS_UNAVAILABLE } from '@shared/intelligence-pass'
import { accelLabel } from '../../lib/keys'
import { ImportQueue } from '../../components/ImportQueue'
import { UpcomingSection } from '../../components/UpcomingSection'
import { isImportDropFile, pickedFiles, skippedImportMessage } from '../../components/import-queue'
import { RowDownloadButton, RowIcon, RowStatusChip, useRecallHydration } from '../../components/history/RowStatusChip'
import { openOnRow, type RowHydration } from '../../components/history/hydration'
import { DegradedBanner } from '../../components/history/DegradedBanner'
import { armSlowNotice, degradedBanner, listBody, nextListPhase, type ListPhase } from '../../components/history/list-status'
import { VirtualList } from '../../ui/VirtualList'
import type {
  MeetingSummary,
  RecallHit,
  GraphStatus,
  GraphRelated,
  ImportAudioPickResult,
  ImportAssetsProgress,
  ImportJobView
} from '@shared/ipc'

// ---------------------------------------------------------------------------
import {
  GraphBar,
  MeetingRow,
  friendlyDate,
  groupByLocalDate,
  meetingIndexStatus,
  type HistoryListItem
} from './recall-components'

export { MeetingRow, friendlyDate, groupByLocalDate, localDateKey, meetingIndexStatus } from './recall-components'

export function RecallView({
  onOpenFolder,
  onBack,
  onConnectCalendar,
  activeFile,
  onNewChat,
  onOpenMeeting,
  onIntelligence,
  onOpenSettings,
  onDashboardOpen
}: {
  onOpenFolder: () => void
  /** Optional: ← back button in the header. */
  onBack?: () => void
  /** Optional: called when the user clicks "Connect your calendar". */
  onConnectCalendar?: () => void
  /** Optional: any row whose file === activeFile shows a purple "Just saved" badge. */
  activeFile?: string
  /** Optional: called by the "New chat ⌘R" footer button. */
  onNewChat?: () => void
  /** Optional: open a meeting's recap in-app (Cluely recap detail). Falls back to OS-open when absent.
   *  `reportError`, when given, receives the failure instead of the app's window-wide notice. */
  onOpenMeeting?: (file: string, reportError?: (message: string) => void) => void
  /** Optional: opens the Mantu Intelligence dashboard (brain view). */
  onIntelligence?: () => void
  /** Optional: opens Settings → AI — GraphBar's no-provider message needs a real way out, and this view
   *  lives in the same window as Settings (just a `setView` swap in App.tsx). */
  onOpenSettings?: () => void
  /** Optional: called once the full Mantu Intelligence dashboard window actually opened successfully —
   *  App.tsx uses this to minimize the History section so it isn't fighting the new window for screen
   *  space. Never called on failure (the error stays visible in THIS panel for the user to read). */
  onDashboardOpen?: () => void
}): JSX.Element {
  const [q, setQ] = useState('')
  // Always the LATEST typed query, readable from a stable (empty-deps) callback — refreshList (below)
  // reads this instead of closing over `q` directly, so a call issued from an already-in-flight async
  // import always searches by what's currently in the box, not whatever was typed when import started.
  const qRef = useRef(q)
  qRef.current = q
  // Monotonic id shared by every recallList/recallSearch fetch (the debounced search effect below AND
  // refreshList's post-import refresh) — whichever request was issued LAST wins when it resolves, so a
  // slow earlier response (or an import's refresh landing well after the user kept typing/searching) can
  // never clobber a fresher result already on screen.
  const fetchSeqRef = useRef(0)
  // The traced list request whose response is waiting to be painted.
  const unpaintedRequestRef = useRef<HistoryRequest | null>(null)
  // The value actually sent to the IPC search / used for grouping — updates 250ms after `q` settles (same
  // delay the search IPC call itself already waited for below), so every keystroke's re-render groups
  // against this stable value instead of re-running groupByLocalDate synchronously on each keystroke.
  const [debouncedQ, setDebouncedQ] = useState('')
  const [items, setItems] = useState<(MeetingSummary | RecallHit)[]>([])
  /** The list request's phase (list-status.ts): bounded loading, slow, failed or answered. */
  const [phase, setPhase] = useState<ListPhase>('loading')
  /** Bumped by the degraded banner's Retry to re-run the fetch effect below for the same query. */
  const [reloadKey, setReloadKey] = useState(0)
  /** File whose knowledge-graph Related panel is expanded. */
  const [open, setOpen] = useState<string | null>(null)
  /** Single-click selection for the "Open ↵" footer action. */
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  /** Files mid-delete — disables each row's OWN trash button so a slow confirm dialog can't be
   *  double-clicked. A Set (not a single file) because starting a delete on row B must not re-enable row
   *  A's Trash while A's delete — whose blocking native confirm dialog can stay open a long time — is
   *  still pending: a single slot let a second delete start on A mid-confirm, whose second call then hit
   *  ENOENT and showed nothing. */
  const [deletingFiles, setDeletingFiles] = useState<Set<string>>(() => new Set())
  /** File whose inline rename input is open (null = no row is being renamed). */
  const [editingFile, setEditingFile] = useState<string | null>(null)
  /** The open rename input's current value. */
  const [editingValue, setEditingValue] = useState('')
  /** File mid-rename-save — disables its pencil button while the IPC call is in flight. */
  const [renaming, setRenaming] = useState<string | null>(null)
  /** Most recent rename/delete failure PER FILE, shown as an inline error under that row. Keyed by file
   *  (not a single {file,message}) so two rows failing close together don't clobber each other's error. */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  /** The scrollable meeting-list container — focused before a row unmounts (e.g. on delete) so a
   *  keyboard user's focus doesn't fall through to <body> when the focused Delete button is removed. */
  const listRef = useRef<HTMLDivElement>(null)
  /** Main-owned jobs survive navigation and overlay closure; this component only renders their live state. */
  const [importJobs, setImportJobs] = useState<ImportJobView[]>([])
  const [importError, setImportError] = useState<string | null>(null)
  const [importAssets, setImportAssets] = useState<ImportAssetsProgress | null>(null)
  const [importDragOver, setImportDragOver] = useState(false)
  /** T6 6d: per-meeting Mantu Intelligence status feed — indexed/failed filename sets plus whether a
   *  backfill is currently requested, everything meetingIndexStatus needs for the row dot. A separate
   *  poll from GraphBar's own brainStatus fetch below (that bar's busy/error/backfill-run state is local
   *  to it and needs a tighter cadence while a batch is running); this one only needs the plain sets.
   *  FIX 4: `errors` mirrors the bounded failedDetails payload (main never ships the whole ledger) — file
   *  → the same error string powering BrainView's expandable failure detail, so a failed row's tooltip
   *  can name the actual reason instead of a generic "extraction failed". */
  const [ingestStatus, setIngestStatus] = useState<{
    indexed: ReadonlySet<string>
    failed: ReadonlySet<string>
    errors: ReadonlyMap<string, string>
    backfillRequested: boolean
  } | null>(null)
  useEffect(() => {
    let stale = false
    const poll = (): void => {
      void window.toto
        .brainStatus()
        .then((b) => {
          if (stale || !b) return
          setIngestStatus({
            indexed: new Set(b.ingestedFiles ?? []),
            failed: new Set(b.failedFiles ?? []),
            errors: new Map(
              (b.failedDetails ?? []).map((d) => [d.file, d.exhausted ? `Exhausted: ${d.error}` : d.error])
            ),
            backfillRequested: !!b.backfillRequested
          })
        })
        .catch(() => {})
    }
    poll()
    const iv = setInterval(poll, 5000)
    return () => {
      stale = true
      clearInterval(iv)
    }
  }, [])

  // Clear/set one row's rename-or-delete error without touching any other row's — see rowErrors above.
  const clearRowError = useCallback((file: string): void => {
    setRowErrors((prev) => {
      if (!(file in prev)) return prev // bail without a new object identity when there's nothing to clear
      const next = { ...prev }
      delete next[file]
      return next
    })
  }, [])
  const flagRowError = useCallback((file: string, message: string): void => {
    setRowErrors((prev) => ({ ...prev, [file]: message }))
  }, [])

  // Meetings are always saved; deletion is the user's to undo that. The main process pops a native,
  // unmissable confirm dialog before actually deleting (single click here is unambiguous — no "did that
  // register?" two-click pattern), then removes the .md + its index row.
  const onTrash = useCallback(async (file: string, title: string): Promise<void> => {
    setDeletingFiles((s) => (s.has(file) ? s : new Set(s).add(file)))
    const r = await window.toto
      .recallDelete(file, title)
      .catch((e): { ok: boolean; error?: string } => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      }))
    setDeletingFiles((s) => {
      if (!s.has(file)) return s
      const next = new Set(s)
      next.delete(file)
      return next
    })
    if (r.ok) {
      listRef.current?.focus()
      setItems((xs) => xs.filter((x) => x.file !== file))
      setSelectedFile((s) => (s === file ? null : s))
      setOpen((o) => (o === file ? null : o))
    } else if (r.error !== 'cancelled') {
      flagRowError(file, r.error || 'Could not delete meeting.')
    }
  }, [flagRowError])
  // Fire-and-forget wrapper matching MeetingRow's sync onTrash prop — kept stable via useCallback so the
  // memoized row doesn't re-render just because this component re-rendered.
  const trashMeeting = useCallback((file: string, title: string): void => {
    void onTrash(file, title)
  }, [onTrash])
  // Export a decrypted .md copy: the save dialog in main IS the interaction — only a real failure needs
  // inline surfacing here (a cancelled dialog is a non-event, same contract as recallDelete's confirm).
  const exportMeeting = useCallback((file: string): void => {
    void window.toto
      .recallExportPlain(file)
      .then((r) => {
        if (!r.ok && !r.cancelled) flagRowError(file, r.error || 'Could not export the meeting.')
      })
      .catch((e) => flagRowError(file, e instanceof Error ? e.message : String(e)))
  }, [flagRowError])
  const selectFile = useCallback((file: string): void => setSelectedFile(file), [])
  const toggleConnections = useCallback(
    (file: string): void => setOpen((o) => (o === file ? null : file)),
    []
  )

  // Rename: fix an auto-generated title after the fact. Opens an inline input pre-filled with the
  // current title; Enter/blur commits, Escape cancels (mirrors Settings.tsx's mode-rename idiom).
  // editingRef mirrors the editingFile/editingValue state so commitEdit/cancelEdit can read the latest
  // values with a STABLE (empty-deps) callback identity — every MeetingRow receives the same function
  // reference for these props, so a keystroke in one row's rename input only re-renders that row (the
  // memoized rows compare props shallowly; a changing callback identity would defeat that for all of them).
  const editingRef = useRef<{ file: string | null; value: string }>({ file: null, value: '' })
  const startEdit = useCallback((file: string, title: string): void => {
    editingRef.current = { file, value: title }
    setEditingFile(file)
    setEditingValue(title)
    clearRowError(file)
  }, [clearRowError])
  const changeEditValue = useCallback((value: string): void => {
    editingRef.current.value = value
    setEditingValue(value)
  }, [])
  const cancelEdit = useCallback((): void => {
    const { file } = editingRef.current
    editingRef.current = { file: null, value: '' }
    setEditingFile(null)
    if (file) clearRowError(file)
  }, [clearRowError])
  const commitEdit = useCallback((): void => {
    const { file, value } = editingRef.current
    editingRef.current = { file: null, value: '' }
    setEditingFile(null)
    if (!file) return
    const title = value.trim()
    if (!title) return // empty after trim — nothing to save, just close the input
    setRenaming(file)
    window.toto
      .recallRename(file, title)
      .then((r) => {
        if (r.ok) {
          setItems((xs) => xs.map((x) => (x.file === file ? { ...x, title } : x)))
          clearRowError(file)
        } else {
          // Reopen the input with the attempted title so the user can retry — unless they've since
          // started renaming another row, in which case only surface the error, don't steal the editor.
          if (editingRef.current.file === null) {
            editingRef.current = { file, value: title }
            setEditingFile(file)
            setEditingValue(title)
          }
          flagRowError(file, r.error || 'Could not rename meeting.')
        }
      })
      .catch((e) => {
        if (editingRef.current.file === null) {
          editingRef.current = { file, value: title }
          setEditingFile(file)
          setEditingValue(title)
        }
        flagRowError(file, e instanceof Error ? e.message : 'Could not rename meeting.')
      })
      .finally(() => setRenaming(null))
  }, [clearRowError, flagRowError])

  // Re-runs the same list/search fetch the mount effect below uses, so a freshly imported meeting shows
  // up immediately — mirrors how onTrash/commitEdit update `items` after their own mutation. Reads the
  // LIVE query via qRef (not a closed-over `q`) and shares fetchSeqRef's ordering guard with the debounced
  // search effect below, so an import that finishes well after the user changed/kept typing a search can
  // neither search on a stale click-time query nor clobber a fresher, already-displayed result.
  const refreshList = useCallback((): void => {
    const query = qRef.current.trim()
    const seq = ++fetchSeqRef.current
    const p = query ? window.toto.recallSearch(query) : window.toto.recallList()
    p.then((l) => {
      if (seq !== fetchSeqRef.current) return
      setItems(l)
      // This answer superseded whatever request was still out, so it also ends that request's spinner.
      setPhase((current) => nextListPhase(current, 'answered'))
    }).catch(() => {})
  }, [])
  const hydrations = useRecallHydration(refreshList) // a finished download re-lists, so its row shows the meeting

  const upsertImportJob = useCallback((job: ImportJobView): void => {
    setImportJobs((jobs) => [job, ...jobs.filter((existing) => existing.jobId !== job.jobId)])
  }, [])

  useEffect(() => {
    let stale = false
    window.toto.importJobsList().then((jobs) => {
      if (!stale) setImportJobs(jobs)
    }).catch(() => {})
    const unsub = window.toto.onImportAudioProgress(({ job }) => {
      if (stale) return
      upsertImportJob(job)
      if (job.state === 'done') refreshList()
    })
    const unsubAssets = window.toto.onImportAssetsProgress((progress) => {
      if (!stale) setImportAssets(progress)
    })
    return () => {
      stale = true
      unsub()
      unsubAssets()
    }
  }, [refreshList, upsertImportJob])

  const startPickedImports = useCallback(
    async (picked: ImportAudioPickResult): Promise<void> => {
      const files = pickedFiles(picked)
      const skip = skippedImportMessage(picked)
      if (skip) setImportError(skip)
      if (!files.length) {
        if (!skip) setImportError(picked.error || 'Could not prepare the selected recordings.')
        return
      }
      try {
        const started = await window.toto.importAudioStartBatch(files.map((file) => file.token))
        for (const job of started) upsertImportJob(job)
      } catch (e) {
        setImportError(e instanceof Error ? e.message : 'Could not start the imports.')
      }
    },
    [upsertImportJob]
  )

  // Pick only creates single-use capabilities. The main process owns decoding, transcription,
  // checkpointing, saving, and recap generation after this call returns.
  const importAudio = useCallback(async (): Promise<void> => {
    setImportError(null)
    let picked: ImportAudioPickResult
    try {
      picked = await window.toto.importAudioPick()
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Could not open the file picker.')
      return
    }
    if (picked.cancelled) return
    await startPickedImports(picked)
  }, [startPickedImports])

  const onImportDragOver = useCallback((e: DragEvent): void => {
    if (![...e.dataTransfer.types].includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setImportDragOver(true)
  }, [])

  const onImportDragLeave = useCallback((e: DragEvent): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setImportDragOver(false)
  }, [])

  const onImportDrop = useCallback(
    async (e: DragEvent): Promise<void> => {
      e.preventDefault()
      setImportDragOver(false)
      const files = [...e.dataTransfer.files].filter(isImportDropFile)
      if (!files.length) {
        setImportError('Drop audio or video recordings to import them.')
        return
      }
      setImportError(null)
      try {
        await startPickedImports(await window.toto.importAudioDrop(files))
      } catch (err) {
        setImportError(err instanceof Error ? err.message : 'Could not import the dropped recordings.')
      }
    },
    [startPickedImports]
  )

  const cancelImport = useCallback((jobId: string): void => {
    void window.toto.importJobCancel(jobId).catch((error) => {
      setImportError(error instanceof Error ? error.message : 'Could not cancel the import.')
    })
  }, [])

  const resumeImport = useCallback((jobId: string): void => {
    void window.toto.importJobResume(jobId).then(upsertImportJob).catch((error) => {
      setImportError(error instanceof Error ? error.message : 'Could not resume the import.')
    })
  }, [upsertImportJob])

  // Permanently dismisses a failed import. Unlike cancel/resume, there is no further job state to push
  // back from main (the job is gone), so this is the one action here that updates `importJobs` itself
  // instead of waiting on onImportAudioProgress.
  const dismissImport = useCallback((jobId: string): void => {
    void window.toto.importJobRemove(jobId).then(() => {
      setImportJobs((jobs) => jobs.filter((job) => job.jobId !== jobId))
    }).catch((error) => {
      setImportError(error instanceof Error ? error.message : 'Could not dismiss the import.')
    })
  }, [])

  // Single fetch owner: immediate on mount / empty query, debounced for typed searches.
  // A stale-guard drops out-of-order resolutions so a slow earlier response can't overwrite a newer one.
  useEffect(() => {
    let stale = false
    let cancelSlow = (): void => {}
    const run = (): void => {
      setPhase((current) => nextListPhase(current, 'request'))
      // A source that has not answered within HISTORY_DEGRADED_MS turns the spinner into the degraded
      // banner, keeping the rows already shown; the answer, whenever it lands, still replaces them.
      cancelSlow = armSlowNotice(() => {
        if (!stale) setPhase((current) => nextListPhase(current, 'slow'))
      })
      const seq = ++fetchSeqRef.current
      const query = q.trim()
      const request = query ? null : beginHistoryRequest()
      const p = query ? window.toto.recallSearch(query) : window.toto.recallList(request?.trace)
      p.then((l) => {
        request?.resolved()
        // fetchSeqRef guards against refreshList's post-import fetch (or another run of this same effect)
        // resolving out of order; `stale` additionally covers this effect's own cleanup (q changed again
        // before this particular run resolved).
        if (!stale && seq === fetchSeqRef.current) {
          setItems(l)
          setDebouncedQ(q)
          if (request) {
            unpaintedRequestRef.current?.discarded()
            unpaintedRequestRef.current = request
          }
        } else request?.discarded()
        if (!stale) setPhase((current) => nextListPhase(current, 'answered'))
      })
        .catch(() => {
          request?.failed()
          // A failure superseded by refreshList's newer answer is not a failed list.
          if (!stale) setPhase((current) => nextListPhase(current, seq === fetchSeqRef.current ? 'failed' : 'answered'))
        })
        .finally(() => cancelSlow())
    }
    if (!q.trim()) {
      run()
      return () => {
        stale = true
        cancelSlow()
      }
    }
    const t = setTimeout(run, 250)
    return () => {
      stale = true
      clearTimeout(t)
      cancelSlow()
    }
  }, [q, reloadKey])

  const retryList = useCallback((): void => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    unpaintedRequestRef.current?.painted()
    unpaintedRequestRef.current = null
  }, [items])

  useEffect(() => () => unpaintedRequestRef.current?.discarded(), [])

  /** Open the selected file (or the first item as a fallback) — in-app recap when wired, else OS-open. */
  const openMeeting = useCallback(
    (f: string, reportError?: (message: string) => void): void => {
      if (onOpenMeeting) {
        onOpenMeeting(f, reportError)
        return
      }
      // shell.openPath (behind recallOpen) resolves to an empty string on success, or an error message
      // on failure — that was the only signal a caller could get, and it went un-awaited, so a failure
      // (missing file, no default handler for .md, etc.) was a silent no-op. Surface it on the row, same
      // as a rename/delete failure.
      void window.toto.recallOpen(f).then((err) => {
        if (err) flagRowError(f, err)
      })
    },
    [onOpenMeeting, flagRowError]
  )
  const downloadMeeting = useCallback(
    (f: string): void => openOnRow(f, { clear: clearRowError, flag: flagRowError }, openMeeting),
    [clearRowError, flagRowError, openMeeting]
  )
  const openSelected = (): void => {
    // While a debounced search is still in flight, `items` still holds the PREVIOUS query's results —
    // don't fall back to items[0] until it actually reflects the current query text. An explicit
    // selectedFile (the user clicked/arrowed onto a row) is still honored regardless.
    if (!selectedFile && q.trim() !== debouncedQ) return
    const f = selectedFile ?? items[0]?.file
    if (f) openMeeting(f)
  }

  // Keyed on [items, debouncedQ] rather than the raw per-keystroke `q` — items only changes when the
  // debounced search actually resolves, so this recomputes once per real result instead of once per
  // keystroke. debouncedQ is included only so the memo is legibly tied to "the query these items answer",
  // not because grouping itself reads it.
  const allGroups = useMemo(() => groupByLocalDate(items), [items, debouncedQ])

  const totalCount = items.length
  const virtualItems = useMemo<HistoryListItem[]>(() => {
    const rows: HistoryListItem[] = []
    for (const [date, meetingsForDate] of allGroups) {
      rows.push({ kind: 'date', date })
      for (const meeting of meetingsForDate) rows.push({ kind: 'meeting', meeting })
    }
    return rows
  }, [allGroups])

  const body = listBody(phase, totalCount)
  const banner = useMemo(() => degradedBanner(phase, items), [phase, items])

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={onImportDragOver}
      onDragLeave={onImportDragLeave}
      onDrop={(e) => void onImportDrop(e)}
    >
      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div className="mb-2 flex items-center gap-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="no-drag focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-full text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <div className="flex flex-1 items-center gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.05] px-3 py-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Ignore Enter while a debounced search (250ms) is still pending — q !== debouncedQ means
              // `items` (and therefore selectedFile/items[0] below) still reflects the PREVIOUS query, so
              // resolving "which file to open" now could open a stale-list result instead of what's
              // actually being typed. debouncedQ is set to the exact `q` a fetch resolved for (see the
              // search effect above), so this comparison is exact, not just "search settled".
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && q === debouncedQ) openSelected()
            }}
            placeholder="Ask or search anything"
            spellCheck={false}
            aria-label="Search past meetings"
            className="no-drag font-body flex-1 bg-transparent text-[13px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-3)]"
          />
          <Search size={14} className="shrink-0 text-[color:var(--color-ink-3)]" />
        </div>
        <TextButton
          icon={Upload}
          onClick={() => void importAudio()}
          title="Import one or more recordings. They keep processing in the background while you navigate."
        >
          Import meetings
        </TextButton>
      </div>
      <ImportQueue
        jobs={importJobs}
        assets={importAssets}
        dragOver={importDragOver}
        error={importError}
        onCancel={cancelImport}
        onResume={resumeImport}
        onDismiss={dismissImport}
        onOpenMeeting={openMeeting}
      />

      {/* ── UPCOMING CALENDAR SECTION ───────────────────────────────────── */}
      <UpcomingSection onConnectCalendar={onConnectCalendar} />

      {/* ── KNOWLEDGE GRAPH STATUS ──────────────────────────────────────── */}
      <div className="mb-2">
        <GraphBar onOpenSettings={onOpenSettings} onDashboardOpen={onDashboardOpen} />
      </div>

      {banner && <DegradedBanner banner={banner} onRetry={retryList} />}

      {/* ── DATE-GROUPED MEETING LIST ───────────────────────────────────── */}
      <div ref={listRef} tabIndex={-1} className="min-h-0 flex-1">
        {body === 'spinner' ? (
          <div className="py-2">
            <AgentStatus kind="searching" size="inline" caption />
          </div>
        ) : body === 'blank' ? null : body === 'empty' ? (
          <div className="py-2 text-[13px] text-[color:var(--color-ink-2)]">
            {q.trim()
              ? 'No matching meetings.'
              : 'No meetings saved yet. Finish one with End & review.'}
          </div>
        ) : (
          <VirtualList
            items={virtualItems}
            getKey={(item) => (item.kind === 'date' ? `date:${item.date}` : `meeting:${item.meeting.file}`)}
            estimateSize={(item) =>
              item.kind === 'date' ? 28 : open === item.meeting.file ? 150 : item.meeting.topics?.length ? 72 : 48
            }
            className="scroll-thin h-full overflow-y-auto pr-1"
            ariaLabel="Past meetings"
            renderItem={({ item, style, measureRef }) => (
              <div
                key={item.kind === 'date' ? `date:${item.date}` : item.meeting.file}
                ref={measureRef}
                style={style}
              >
                {item.kind === 'date' ? (
                  <div className="cl-eyebrow px-1 pb-1 pt-2 text-[color:var(--color-ink-3)]">
                    {friendlyDate(item.date)}
                  </div>
                ) : (
                  <MeetingRow
                    meeting={item.meeting}
                    isSelected={selectedFile === item.meeting.file}
                    isActive={activeFile === item.meeting.file}
                    isDeleting={deletingFiles.has(item.meeting.file)}
                    isEditing={editingFile === item.meeting.file}
                    editingValue={editingFile === item.meeting.file ? editingValue : ''}
                    isRenaming={renaming === item.meeting.file}
                    isOpen={open === item.meeting.file}
                    error={rowErrors[item.meeting.file] ?? null}
                    indexStatus={meetingIndexStatus(item.meeting.file, ingestStatus)}
                    indexError={ingestStatus?.errors.get(item.meeting.file) ?? null}
                    hydration={hydrations[item.meeting.file]}
                    onSelect={selectFile}
                    onOpen={openMeeting}
                    onDownload={downloadMeeting}
                    onToggleConnections={toggleConnections}
                    onTrash={trashMeeting}
                    onExport={exportMeeting}
                    onStartEdit={startEdit}
                    onEditingChange={changeEditValue}
                    onCommitEdit={commitEdit}
                    onCancelEdit={cancelEdit}
                  />
                )}
              </div>
            )}
          />
        )}
      </div>

      {/* ── BOTTOM ACTION BAR ───────────────────────────────────────────── */}
      <div className="mt-2 flex items-center justify-between border-t border-[var(--color-hair-soft)] pt-2">
        <div className="flex items-center gap-1.5">
          <TextButton onClick={openSelected} disabled={items.length === 0}>
            Open
            <kbd className="rounded bg-white/[0.06] px-1 py-0.5 text-[10px] text-[color:var(--color-ink-3)]">{accelLabel('Return')}</kbd>
          </TextButton>
          <TextButton icon={FolderOpen} onClick={onOpenFolder}>Open folder</TextButton>
          {onIntelligence && (
            <button
              type="button"
              onClick={onIntelligence}
              title="Mantu Intelligence: your meeting knowledge dashboard"
              className="no-drag focus-ring flex items-center gap-1.5 rounded-full bg-[var(--color-accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-text)] ring-1 ring-inset ring-[var(--color-accent)]/30 transition-colors hover:bg-[var(--color-accent)]/25"
            >
              <Brain size={12} strokeWidth={2.2} /> Intelligence
            </button>
          )}
        </div>

        {onNewChat && (
          <TextButton onClick={onNewChat}>
            New chat
            <kbd className="rounded bg-white/[0.06] px-1 py-0.5 text-[10px] text-[color:var(--color-ink-3)]">{accelLabel('CommandOrControl+R')}</kbd>
          </TextButton>
        )}
      </div>
    </div>
  )
}
