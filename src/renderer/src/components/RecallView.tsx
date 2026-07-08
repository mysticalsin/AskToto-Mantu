import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search,
  FolderOpen,
  FileText,
  Network,
  RefreshCw,
  ExternalLink,
  ChevronLeft,
  Calendar,
  Trash2,
  Pencil,
  Brain,
  Upload
} from 'lucide-react'
import { TextButton } from './ui'
import { accelLabel } from '../lib/keys'
import { uid } from '../state'
import { chunkAudio, decodeAndResampleToMono16k } from '../lib/import-audio'
import type {
  MeetingSummary,
  RecallHit,
  GraphStatus,
  GraphRelated,
  CalendarTodayResult,
  CalendarEvent,
  ImportAudioPickResult,
  ImportAudioChunkResult
} from '@shared/ipc'

// ---------------------------------------------------------------------------
// Helpers duplicated from Review.tsx — DO NOT edit Review.tsx; it owns these.
// Exception: the local-date-grouping helpers below (localDateKey / groupByLocalDate / friendlyDate)
// had a same-shaped UTC/local mismatch bug in both copies, so both were fixed in lockstep — see the
// identical (unexported) copy in Review.tsx's "Recent meetings" panel.
// ---------------------------------------------------------------------------

function formatDurationMin(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function meetingTime(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Local (not UTC) calendar-day key for a timestamp, as "YYYY-MM-DD". Meetings are saved with a full
 * ISO instant (e.g. "2026-07-02T17:50:34.312Z"); truncating that string to its first 10 characters
 * grabs the UTC date, which is a different calendar day from the local one for roughly half of every
 * 24h cycle in any timezone west of UTC — so a meeting saved moments ago could key under "yesterday".
 * `toLocaleDateString('en-CA')` formats as plain YYYY-MM-DD using the LOCAL timezone, which keeps the
 * key anchored to the same wall-clock day the user actually sees. Exported for unit testing.
 */
export function localDateKey(dateStr: string): string {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr.slice(0, 10)
  return d.toLocaleDateString('en-CA')
}

/** Group meetings by their LOCAL calendar day. Exported for unit testing. */
export function groupByLocalDate(
  meetings: (MeetingSummary | RecallHit)[]
): [string, (MeetingSummary | RecallHit)[]][] {
  const map = new Map<string, (MeetingSummary | RecallHit)[]>()
  for (const m of meetings) {
    const d = localDateKey(m.date)
    if (!map.has(d)) map.set(d, [])
    map.get(d)!.push(m)
  }
  return Array.from(map.entries())
}

/**
 * `dateKey` is a LOCAL "YYYY-MM-DD" string from `localDateKey`/`groupByLocalDate` — compared as a
 * plain string against today's/yesterday's own local keys (computed the same way), so the comparison
 * never re-enters ISO/UTC date parsing. The fallback display date is built from the key's numeric
 * y/m/d via the `Date(y, m, d)` constructor, which — unlike `new Date("YYYY-MM-DD")` — is specified to
 * construct local midnight, not UTC midnight. Exported for unit testing.
 */
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

/** Format a calendar event start/end time for the upcoming row. */
function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// Knowledge-graph status bar — unchanged from original
// ---------------------------------------------------------------------------

function GraphBar(): JSX.Element | null {
  // Mantu Intelligence — the meeting brain (people, accounts, deals, win/loss reasons, graph).
  // Replaces the old graphify note-graph as the "open graph" surface in History.
  const [brain, setBrain] = useState<import('@shared/brain').BrainStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void window.toto.brainStatus().then(setBrain).catch(() => {})
  }, [])

  // Backfill runs in the main process over minutes (one Dust call per meeting) — a single post-click
  // fetch froze this bar on "Building your brain… 0/X" forever, since nothing ever asked again. Poll
  // while a backfill is actually running; stop as soon as it isn't (self-clears via the effect re-run
  // when brain.backfill.running flips false — same pattern as the dashboard's own auto-refresh).
  const backfillRunning = !!brain?.backfill?.running
  useEffect(() => {
    if (!backfillRunning) return
    const iv = setInterval(() => {
      void window.toto.brainStatus().then(setBrain).catch(() => {})
    }, 3000)
    return () => clearInterval(iv)
  }, [backfillRunning])

  const backfill = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.toto.brainBackfill()
      setBrain(await window.toto.brainStatus())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openDashboard = async (): Promise<void> => {
    const r = await window.toto.brainOpenDashboard().catch((e) => ({ ok: false, error: String(e) }))
    if (!r.ok) setError(r.error || 'Could not open Mantu Intelligence.')
  }

  const backfilling = !!brain?.backfill?.running
  return (
    <div className="flex items-center justify-between rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-ink-2)]">
        <Network size={12} className="text-[var(--color-accent-2)]" />
        {error ? (
          <span className="text-[var(--color-danger)]">{error}</span>
        ) : backfilling ? (
          <>Building your brain… {brain?.backfill?.done ?? 0}/{brain?.backfill?.total ?? 0} meetings</>
        ) : brain && brain.meetings > 0 ? (
          <>
            Intelligence · {brain.meetings} meetings · {brain.people} people · {brain.accounts} accounts
            {brain.deals > 0 ? ` · ${brain.deals} deals` : ''}
          </>
        ) : (
          'Mantu Intelligence: build a brain from your meetings.'
        )}
      </div>
      <div className="flex items-center gap-1">
        <TextButton
          onClick={() => void backfill()}
          disabled={busy || backfilling}
          title="Index every meeting (past + vault) into the brain"
        >
          <RefreshCw size={11} className={busy || backfilling ? 'animate-spin' : ''} /> Index meetings
        </TextButton>
        <TextButton onClick={() => void openDashboard()} title="Open the Mantu Intelligence dashboard">
          <ExternalLink size={11} /> Mantu Intelligence
        </TextButton>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline connections panel — unchanged from original
// ---------------------------------------------------------------------------

function Related({
  file,
  onOpen
}: {
  file: string
  onOpen: (file: string) => void
}): JSX.Element {
  const [data, setData] = useState<GraphRelated | null>(null)
  useEffect(() => {
    let alive = true
    window.toto
      .graphifyRelated(file)
      .then((r) => alive && setData(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [file])

  if (!data)
    return (
      <div className="px-2 py-1 text-[11px] text-[color:var(--color-ink-3)]">
        Loading connections…
      </div>
    )
  if (!data.ok)
    return (
      <div className="px-2 py-1 text-[11px] text-[color:var(--color-ink-3)]">
        {data.error || 'No graph yet.'}
      </div>
    )
  if (data.topics.length === 0 && data.notes.length === 0)
    return (
      <div className="px-2 py-1 text-[11px] text-[color:var(--color-ink-3)]">
        No connections found yet.
      </div>
    )

  return (
    <div className="flex flex-col gap-1.5 px-2 py-1.5">
      {data.topics.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {data.topics.map((t) => (
            <span
              key={t}
              className="truncate max-w-full rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent-2)]"
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {data.notes.map((n) => (
        <button
          key={n.file}
          type="button"
          onClick={() => onOpen(n.file)}
          className="no-drag focus-ring flex flex-col gap-0.5 rounded-lg px-2 py-1 text-left hover:bg-white/[0.06]"
        >
          <span className="truncate text-[12px] text-[color:var(--color-ink)]">{n.title}</span>
          {n.via.length > 0 && (
            <span className="truncate text-[10px] text-[color:var(--color-ink-3)]">
              via {n.via.join(', ')}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Upcoming calendar section
// ---------------------------------------------------------------------------

function CompactEventRow({ ev }: { ev: CalendarEvent }): JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.06]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-[color:var(--color-ink)]">
          {ev.subject}
        </div>
        {ev.location && (
          <div className="truncate text-[10px] text-[color:var(--color-ink-3)]">
            {ev.location}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right text-[11px] tabular-nums text-[color:var(--color-ink-3)]">
        {ev.allDay ? 'All day' : fmtTime(ev.start)}
      </div>
    </div>
  )
}

function UpcomingSection({
  onConnectCalendar
}: {
  onConnectCalendar?: () => void
}): JSX.Element {
  const [res, setRes] = useState<CalendarTodayResult | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    try {
      setRes(await window.toto.calendarToday(tz))
    } catch {
      setRes({ ok: false, error: 'Calendar unavailable.' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const showConnect = !loading && (!res?.ok || res?.needsConsent)
  const events = res?.ok && res.events ? res.events.slice(0, 3) : []

  return (
    <div className="mb-1.5">
      <div className="mb-1 flex items-center justify-between px-1">
        <div className="cl-eyebrow flex items-center gap-1.5 text-[color:var(--color-ink-3)]">
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
          Upcoming
        </div>
        {!loading && res?.ok && (
          <button
            type="button"
            onClick={() => void load()}
            aria-label="Refresh calendar"
            className="no-drag focus-ring grid h-5 w-5 place-items-center rounded-full text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
          >
            <RefreshCw size={9} />
          </button>
        )}
      </div>
      {showConnect ? (
        <button
          type="button"
          onClick={onConnectCalendar}
          className="no-drag focus-ring flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06]"
        >
          <Calendar size={13} className="shrink-0 text-[color:var(--color-ink-3)]" />
          <span className="text-[12px] text-[color:var(--color-ink-2)]">Connect your calendar</span>
        </button>
      ) : events.length === 0 && !loading ? (
        <div className="px-2 py-1 text-[12px] text-[color:var(--color-ink-3)]">
          No upcoming events today.
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {events.map((ev, i) => (
            <CompactEventRow key={i} ev={ev} />
          ))}
        </div>
      )}
    </div>
  )
}

// Cap the first paint of the meeting list to the most recent N — a daily user can accumulate hundreds of
// saved meetings, and rendering all of them (grouped, per-row) on every keystroke in the search box (which
// re-renders before the debounced IPC search even replaces `items`) visibly stutters. The "Show all"
// button below opts into the full list once the user actually wants it.
const INITIAL_RENDER_CAP = 100

// ---------------------------------------------------------------------------
// One meeting row — memoized so re-renders of RecallView (e.g. a keystroke in the search box before the
// debounced search resolves) don't re-render every already-rendered row, only ones whose props changed.
// ---------------------------------------------------------------------------

const MeetingRow = memo(function MeetingRow({
  meeting,
  isSelected,
  isActive,
  isDeleting,
  isEditing,
  editingValue,
  isRenaming,
  isOpen,
  error,
  onSelect,
  onOpen,
  onToggleConnections,
  onTrash,
  onStartEdit,
  onEditingChange,
  onCommitEdit,
  onCancelEdit
}: {
  meeting: MeetingSummary | RecallHit
  isSelected: boolean
  isActive: boolean
  isDeleting: boolean
  /** This row's inline rename input is open. */
  isEditing: boolean
  /** The rename input's current value — only meaningful while isEditing (constant '' otherwise, so
   *  this memoized row never re-renders from keystrokes typed into a DIFFERENT row's rename input). */
  editingValue: string
  /** A rename request for this row is in flight — disables the pencil button (mirrors isDeleting). */
  isRenaming: boolean
  isOpen: boolean
  /** Most recent rename/delete failure for this row, or null — see onTrash/commitEdit. */
  error: string | null
  onSelect: (file: string) => void
  onOpen: (file: string) => void
  onToggleConnections: (file: string) => void
  onTrash: (file: string, title: string) => void
  onStartEdit: (file: string, title: string) => void
  onEditingChange: (value: string) => void
  onCommitEdit: () => void
  onCancelEdit: () => void
}): JSX.Element {
  const m = meeting
  const hit = 'snippet' in m ? (m as RecallHit) : null

  return (
    <div className={`rounded-lg transition-colors${isSelected ? ' bg-white/[0.08]' : ''}`}>
      {/* Row */}
      <div className="flex items-center gap-1">
        {isEditing ? (
          <div className="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5">
            <FileText size={12} className="shrink-0 text-[color:var(--color-ink-3)]" />
            <input
              autoFocus
              value={editingValue}
              onChange={(e) => onEditingChange(e.target.value)}
              onKeyDown={(e) => {
                // Keep Enter/Escape self-contained: without stopPropagation the keydown bubbles to App's
                // global Escape handler, which would close the whole History panel instead of just the
                // rename field.
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  onCommitEdit()
                }
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  onCancelEdit()
                }
              }}
              onBlur={onCommitEdit}
              maxLength={120}
              spellCheck={false}
              aria-label="Meeting title"
              className="no-drag focus-ring min-w-0 flex-1 rounded-md bg-white/[0.08] px-2 py-1 text-[12px] font-medium text-[color:var(--color-ink)] outline-none"
            />
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onSelect(m.file)}
              onDoubleClick={() => onOpen(m.file)}
              className="no-drag focus-ring flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06]"
            >
              <FileText size={12} className="shrink-0 text-[color:var(--color-ink-3)]" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[color:var(--color-ink)]">
                {m.title}
              </span>

              {/* Analyzing badge */}
              {isActive && (
                <span className="shrink-0 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] text-[color:var(--color-accent-2)]">
                  Just saved
                </span>
              )}

              {/* Duration badge + time. durationMin rounds to 0 both for a genuinely empty capture (no
                  speech at all, participants: []) and for an older saved meeting whose real duration
                  was under a minute. participants.length > 0 means at least one line was captured
                  (see saveMeeting's participants derivation), so it distinguishes the two: show "<1m"
                  for a real quick meeting, hide the badge only when there is truly no content. */}
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {(m.durationMin > 0 || m.participants.length > 0) && (
                  <span className="rounded-full bg-white/[0.06] px-1.5 text-[10px] text-[color:var(--color-ink-3)]">
                    {m.durationMin > 0 ? formatDurationMin(m.durationMin) : '<1m'}
                  </span>
                )}
                <span className="tabular-nums text-[11px] text-[color:var(--color-ink-3)]">
                  {meetingTime(m.date)}
                </span>
              </div>
            </button>

            {/* Rename — opens an inline title input; see onStartEdit. */}
            <button
              type="button"
              aria-label="Rename meeting"
              title="Rename"
              disabled={isRenaming}
              onClick={() => onStartEdit(m.file, m.title)}
              className="no-drag focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-full text-[color:var(--color-ink-3)] transition-colors hover:bg-white/[0.06] hover:text-[color:var(--color-ink)] disabled:opacity-40"
            >
              <Pencil size={12} />
            </button>

            {/* Knowledge-graph expand — icon-only compact button */}
            <button
              type="button"
              aria-label="Show connections"
              aria-expanded={isOpen}
              title="Connections"
              onClick={() => onToggleConnections(m.file)}
              className="no-drag focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-full text-[color:var(--color-ink-3)] transition-colors hover:bg-white/[0.06] hover:text-[color:var(--color-ink)]"
            >
              <Network size={12} />
            </button>

            {/* Delete — single click opens a native confirm dialog (main process); see onTrash. */}
            <button
              type="button"
              aria-label="Delete meeting"
              title="Delete"
              disabled={isDeleting}
              onClick={() => onTrash(m.file, m.title)}
              className="no-drag focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-full text-[color:var(--color-ink-3)] transition-colors hover:bg-[var(--color-danger)]/10 hover:text-[var(--color-danger)] disabled:opacity-40"
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>

      {/* Rename/delete error — transient inline message; see onTrash/commitEdit. */}
      {error && <div className="px-7 pb-1 text-[11px] text-[var(--color-danger)]">{error}</div>}

      {/* Search snippet (RecallHit only) */}
      {hit?.snippet && (
        <div className="line-clamp-2 px-7 pb-1 text-[11px] text-[color:var(--color-ink-2)]">
          …{hit.snippet}…
        </div>
      )}

      {/* Topic chips — up to 3, derived from the recap's "## Tags" section (see saveMeeting). */}
      {!!m.topics?.length && (
        <div className="flex flex-wrap gap-1 px-7 pb-1.5">
          {m.topics.slice(0, 3).map((t, i) => (
            <span
              key={`${t}-${i}`}
              className="truncate max-w-full rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent-2)]"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {/* Connections panel */}
      {isOpen && (
        <div className="border-t border-[var(--color-hair-soft)]">
          <Related file={m.file} onOpen={onOpen} />
        </div>
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function RecallView({
  onOpenFolder,
  onBack,
  onConnectCalendar,
  activeFile,
  onNewChat,
  onOpenMeeting,
  onIntelligence
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
  /** Optional: open a meeting's recap in-app (Cluely recap detail). Falls back to OS-open when absent. */
  onOpenMeeting?: (file: string) => void
  /** Optional: opens the Mantu Intelligence dashboard (brain view). */
  onIntelligence?: () => void
}): JSX.Element {
  const [q, setQ] = useState('')
  // The value actually sent to the IPC search / used for grouping — updates 250ms after `q` settles (same
  // delay the search IPC call itself already waited for below), so every keystroke's re-render groups
  // against this stable value instead of re-running groupByLocalDate synchronously on each keystroke.
  const [debouncedQ, setDebouncedQ] = useState('')
  const [items, setItems] = useState<(MeetingSummary | RecallHit)[]>([])
  const [loading, setLoading] = useState(true)
  /** File whose knowledge-graph Related panel is expanded. */
  const [open, setOpen] = useState<string | null>(null)
  /** Single-click selection for the "Open ↵" footer action. */
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  /** File mid-delete — disables its trash button so a slow confirm dialog can't be double-clicked. */
  const [deleting, setDeleting] = useState<string | null>(null)
  /** File whose inline rename input is open (null = no row is being renamed). */
  const [editingFile, setEditingFile] = useState<string | null>(null)
  /** The open rename input's current value. */
  const [editingValue, setEditingValue] = useState('')
  /** File mid-rename-save — disables its pencil button while the IPC call is in flight. */
  const [renaming, setRenaming] = useState<string | null>(null)
  /** Most recent rename/delete failure — file + message shown as an inline error under that row. */
  const [rowError, setRowError] = useState<{ file: string; message: string } | null>(null)
  /** Opt-in past the INITIAL_RENDER_CAP — set once the user clicks "Show all N meetings". */
  const [showAll, setShowAll] = useState(false)
  /** The scrollable meeting-list container — focused before a row unmounts (e.g. on delete) so a
   *  keyboard user's focus doesn't fall through to <body> when the focused Delete button is removed. */
  const listRef = useRef<HTMLDivElement>(null)
  /** "Import audio" button state — idle outside a run; disables the button and drives its label.
   *  `notice` is a non-error, informational message (e.g. "no speech detected") — kept separate from
   *  `error` so it doesn't render in the danger color used for actual failures. */
  const [importState, setImportState] = useState<{
    stage: 'idle' | 'decoding' | 'transcribing' | 'saving' | 'summarizing'
    pct: number
    error: string | null
    notice: string | null
  }>({ stage: 'idle', pct: 0, error: null, notice: null })

  // Meetings are always saved; deletion is the user's to undo that. The main process pops a native,
  // unmissable confirm dialog before actually deleting (single click here is unambiguous — no "did that
  // register?" two-click pattern), then removes the .md + its index row.
  const onTrash = useCallback(async (file: string, title: string): Promise<void> => {
    setDeleting(file)
    const r = await window.toto
      .recallDelete(file, title)
      .catch((e): { ok: boolean; error?: string } => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      }))
    setDeleting(null)
    if (r.ok) {
      listRef.current?.focus()
      setItems((xs) => xs.filter((x) => x.file !== file))
      setSelectedFile((s) => (s === file ? null : s))
      setOpen((o) => (o === file ? null : o))
    } else if (r.error !== 'cancelled') {
      setRowError({ file, message: r.error || 'Could not delete meeting.' })
    }
  }, [])
  // Fire-and-forget wrapper matching MeetingRow's sync onTrash prop — kept stable via useCallback so the
  // memoized row doesn't re-render just because this component re-rendered.
  const trashMeeting = useCallback((file: string, title: string): void => {
    void onTrash(file, title)
  }, [onTrash])
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
    setRowError((e) => (e?.file === file ? null : e))
  }, [])
  const changeEditValue = useCallback((value: string): void => {
    editingRef.current.value = value
    setEditingValue(value)
  }, [])
  const cancelEdit = useCallback((): void => {
    const { file } = editingRef.current
    editingRef.current = { file: null, value: '' }
    setEditingFile(null)
    setRowError((e) => (e?.file === file ? null : e))
  }, [])
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
          setRowError((e) => (e?.file === file ? null : e))
        } else {
          // Reopen the input with the attempted title so the user can retry — unless they've since
          // started renaming another row, in which case only surface the error, don't steal the editor.
          if (editingRef.current.file === null) {
            editingRef.current = { file, value: title }
            setEditingFile(file)
            setEditingValue(title)
          }
          setRowError({ file, message: r.error || 'Could not rename meeting.' })
        }
      })
      .catch((e) => {
        if (editingRef.current.file === null) {
          editingRef.current = { file, value: title }
          setEditingFile(file)
          setEditingValue(title)
        }
        setRowError({ file, message: e instanceof Error ? e.message : 'Could not rename meeting.' })
      })
      .finally(() => setRenaming(null))
  }, [])

  // Re-runs the same list/search fetch the mount effect below uses, so a freshly imported meeting shows
  // up immediately — mirrors how onTrash/commitEdit update `items` after their own mutation.
  const refreshList = useCallback((): void => {
    const p = q.trim() ? window.toto.recallSearch(q.trim()) : window.toto.recallList()
    p.then(setItems).catch(() => {})
  }, [q])

  // Import audio: pick a recording, decode/resample it locally (main has no ffmpeg — see
  // lib/import-audio.ts), then stream it to main as ~30s windows, one IPC round trip at a time, each
  // one transcribed on-device before the next is sent. See main/import-audio.ts for the save + ingest.
  const importAudio = useCallback(async (): Promise<void> => {
    setImportState({ stage: 'decoding', pct: 0, error: null, notice: null })
    let picked: ImportAudioPickResult
    try {
      picked = await window.toto.importAudioPick()
    } catch (e) {
      setImportState({
        stage: 'idle',
        pct: 0,
        error: e instanceof Error ? e.message : 'Could not open the file picker.',
        notice: null
      })
      return
    }
    if (picked.cancelled) {
      setImportState({ stage: 'idle', pct: 0, error: null, notice: null })
      return
    }
    if (!picked.path) {
      setImportState({ stage: 'idle', pct: 0, error: picked.error || 'Could not read the selected file.', notice: null })
      return
    }
    let unsub: (() => void) | null = null
    try {
      const buf = await window.toto.importAudioRead(picked.path)
      const samples = await decodeAndResampleToMono16k(buf)
      const chunks = chunkAudio(samples)
      const sessionId = uid()
      unsub = window.toto.onImportAudioProgress((d) => {
        if (d.sessionId !== sessionId) return
        setImportState({ stage: d.stage, pct: d.pct, error: null, notice: null })
      })
      let last: ImportAudioChunkResult | undefined
      for (let seq = 0; seq < chunks.length; seq++) {
        last = await window.toto.importAudioTranscribe({
          sessionId,
          seq,
          totalChunks: chunks.length,
          done: seq === chunks.length - 1,
          name: picked.name || 'Imported audio',
          mtimeMs: picked.mtimeMs ?? Date.now(),
          samples: chunks[seq]
        })
        if (!last?.ok) throw new Error(last?.error || 'Import failed.')
      }
      // A silent/near-silent recording saves successfully with zero transcribed lines — that's not an
      // error, but going fully idle with no feedback leaves a phantom empty meeting the user can't explain.
      const noSpeech = last?.file != null && (last.lines?.length ?? 0) === 0
      setImportState({
        stage: 'idle',
        pct: 0,
        error: null,
        notice: noSpeech ? 'No speech was detected in this recording.' : null
      })
      refreshList()
    } catch (e) {
      setImportState({
        stage: 'idle',
        pct: 0,
        error: e instanceof Error ? e.message : 'Could not import this recording.',
        notice: null
      })
    } finally {
      unsub?.()
    }
  }, [refreshList])

  // Single fetch owner: immediate on mount / empty query, debounced for typed searches.
  // A stale-guard drops out-of-order resolutions so a slow earlier response can't overwrite a newer one.
  useEffect(() => {
    let stale = false
    const run = (): void => {
      setLoading(true)
      const p = q.trim() ? window.toto.recallSearch(q.trim()) : window.toto.recallList()
      p.then((l) => {
        if (!stale) {
          setItems(l)
          setDebouncedQ(q)
        }
      })
        .catch(() => {})
        .finally(() => {
          if (!stale) setLoading(false)
        })
    }
    if (!q.trim()) {
      run()
      return () => {
        stale = true
      }
    }
    const t = setTimeout(run, 250)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [q])

  /** Open the selected file (or the first item as a fallback) — in-app recap when wired, else OS-open. */
  const openMeeting = useCallback(
    (f: string): void => {
      if (onOpenMeeting) onOpenMeeting(f)
      else void window.toto.recallOpen(f)
    },
    [onOpenMeeting]
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

  // Cap the first paint to the most recent INITIAL_RENDER_CAP meetings (across groups, in existing order —
  // recallList/recallSearch already return newest-first) unless the user opted into "Show all".
  const totalCount = items.length
  const groups = useMemo(() => {
    if (showAll || totalCount <= INITIAL_RENDER_CAP) return allGroups
    let remaining = INITIAL_RENDER_CAP
    const capped: [string, (MeetingSummary | RecallHit)[]][] = []
    for (const [date, meetingsForDate] of allGroups) {
      if (remaining <= 0) break
      const slice = meetingsForDate.slice(0, remaining)
      capped.push([date, slice])
      remaining -= slice.length
    }
    return capped
  }, [allGroups, showAll, totalCount])

  return (
    <div className="flex h-full flex-col">
      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div className="mb-2 flex items-center gap-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Go back"
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
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) openSelected()
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
          disabled={importState.stage !== 'idle'}
          title="Import an audio recording and transcribe it on-device"
        >
          {importState.stage === 'idle'
            ? 'Import audio'
            : importState.stage === 'decoding'
              ? 'Decoding…'
              : importState.stage === 'transcribing'
                ? `Transcribing ${importState.pct}%`
                : importState.stage === 'summarizing'
                  ? 'Summarizing…'
                  : 'Saving…'}
        </TextButton>
      </div>
      {importState.error && (
        <div className="mb-2 px-1 text-[11px] text-[var(--color-danger)]">{importState.error}</div>
      )}
      {!importState.error && importState.notice && (
        <div className="mb-2 px-1 text-[11px] text-[color:var(--color-ink-2)]">{importState.notice}</div>
      )}

      {/* ── UPCOMING CALENDAR SECTION ───────────────────────────────────── */}
      <UpcomingSection onConnectCalendar={onConnectCalendar} />

      {/* ── KNOWLEDGE GRAPH STATUS ──────────────────────────────────────── */}
      <div className="mb-2">
        <GraphBar />
      </div>

      {/* ── DATE-GROUPED MEETING LIST ───────────────────────────────────── */}
      <div ref={listRef} tabIndex={-1} className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-1">
        {loading ? (
          <div className="py-2 text-[13px] text-[color:var(--color-ink-2)]">Loading…</div>
        ) : items.length === 0 ? (
          <div className="py-2 text-[13px] text-[color:var(--color-ink-2)]">
            {q.trim()
              ? 'No matching meetings.'
              : 'No meetings saved yet. Finish one with End & review.'}
          </div>
        ) : (
          <>
            {groups.map(([date, meetingsForDate]) => (
              <div key={date}>
                {/* Date group header */}
                <div className="cl-eyebrow px-1 pb-1 pt-2 text-[color:var(--color-ink-3)]">
                  {friendlyDate(date)}
                </div>

                {meetingsForDate.map((m) => (
                  <MeetingRow
                    key={m.file}
                    meeting={m}
                    isSelected={selectedFile === m.file}
                    isActive={activeFile === m.file}
                    isDeleting={deleting === m.file}
                    isEditing={editingFile === m.file}
                    editingValue={editingFile === m.file ? editingValue : ''}
                    isRenaming={renaming === m.file}
                    isOpen={open === m.file}
                    error={rowError?.file === m.file ? rowError.message : null}
                    onSelect={selectFile}
                    onOpen={openMeeting}
                    onToggleConnections={toggleConnections}
                    onTrash={trashMeeting}
                    onStartEdit={startEdit}
                    onEditingChange={changeEditValue}
                    onCommitEdit={commitEdit}
                    onCancelEdit={cancelEdit}
                  />
                ))}
              </div>
            ))}
            {!showAll && totalCount > INITIAL_RENDER_CAP && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="no-drag focus-ring mt-1 w-full rounded-lg px-2 py-1.5 text-center text-[11px] font-medium text-[color:var(--color-ink-3)] hover:bg-white/[0.06] hover:text-[color:var(--color-ink-2)]"
              >
                Show all {totalCount} meetings
              </button>
            )}
          </>
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
              className="no-drag focus-ring flex items-center gap-1.5 rounded-full bg-[var(--color-accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] ring-1 ring-inset ring-[var(--color-accent)]/30 transition-colors hover:bg-[var(--color-accent)]/25"
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
