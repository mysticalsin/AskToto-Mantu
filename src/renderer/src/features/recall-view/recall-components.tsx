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

/** "1 meeting" / "2 meetings" (or an irregular plural like "person" → "people") — the Intelligence strip's
 *  counts below used to always render the plural noun, reading as "1 meetings · 1 people · 0 accounts". */
function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

// T6 6d — per-meeting Mantu Intelligence status: the smallest-possible dot+tooltip on each row.
export type MeetingIndexStatus = 'indexed' | 'pending' | 'failed'

/** indexed (in the brain, ok) / failed (last extraction returned ok:false) / pending (a backfill/live
 *  ingest was requested but this file hasn't settled either way yet) / null (no ingest signal at all —
 *  brain status hasn't loaded yet, or a backfill was never requested). Exported for unit testing. */
export function meetingIndexStatus(
  file: string,
  ingest: { indexed: ReadonlySet<string>; failed: ReadonlySet<string>; backfillRequested: boolean } | null
): MeetingIndexStatus | null {
  if (!ingest) return null
  if (ingest.indexed.has(file)) return 'indexed'
  if (ingest.failed.has(file)) return 'failed'
  return ingest.backfillRequested ? 'pending' : null
}

// ---------------------------------------------------------------------------
// Knowledge-graph status bar — unchanged from original
// ---------------------------------------------------------------------------

function formatLastIndexedAt(at?: number): string {
  if (!at || !Number.isFinite(at) || at <= 0) return ''
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function GraphBar({
  onOpenSettings,
  onDashboardOpen
}: {
  onOpenSettings?: () => void
  /** Called once the full Mantu Intelligence dashboard window actually opened successfully. */
  onDashboardOpen?: () => void
}): JSX.Element | null {
  // Mantu Intelligence — the meeting brain (people, accounts, deals, win/loss reasons, graph).
  // Replaces the old graphify note-graph as the "open graph" surface in History.
  const [brain, setBrain] = useState<import('@shared/brain').BrainStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  // Distinguishes the deferred "no-provider" error (fixable via Settings → AI) from any other backfill
  // failure (network blip, etc.) — only the former gets an Open Settings action below.
  const [noProvider, setNoProvider] = useState(false)
  const applyStatus = (st: import('@shared/brain').BrainStatus | null): void => {
    setBrain(st)
    setStatusError(st ? null : INTELLIGENCE_STATUS_UNAVAILABLE)
    if (st?.intelligenceIndex?.running) setError(null)
  }
  useEffect(() => {
    void window.toto
      .brainStatus()
      .then(applyStatus)
      .catch(() => setStatusError(INTELLIGENCE_STATUS_UNAVAILABLE))
  }, [])

  // Historical batches and newly saved/imported meetings both update in main. Keep a lightweight status
  // poll alive while this panel is visible: a live job can start after this component mounted, and a
  // permanent 5s idle poll is cheaper and more reliable than a filesystem watcher over OneDrive.
  const liveRunning = !!brain?.live?.running
  const preparing = !!brain?.backfill?.preparing
  const brainWorking = brainStatusIsWorking(brain) || busy
  useEffect(() => {
    const iv = setInterval(() => {
      void window.toto
        .brainStatus()
        .then(applyStatus)
        .catch(() => setStatusError(INTELLIGENCE_STATUS_UNAVAILABLE))
    }, brainWorking ? 1000 : 5000)
    return () => clearInterval(iv)
  }, [brainWorking])

  const backfill = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNoProvider(false)
    try {
      const { error: clickError } = await runIntelligenceUpdateClick(() => window.toto.brainBackfill())
      if (clickError) {
        setError(clickError)
        setNoProvider(/provider/i.test(clickError))
        return
      }
      applyStatus(await window.toto.brainStatus())
    } catch {
      setStatusError(INTELLIGENCE_STATUS_UNAVAILABLE)
    } finally {
      setBusy(false)
    }
  }

  const openDashboard = async (): Promise<void> => {
    const r = await window.toto.brainOpenDashboard().catch((e) => ({ ok: false, error: String(e) }))
    if (!r.ok) setError(r.error || 'Could not open Mantu Intelligence.')
    else onDashboardOpen?.()
  }

  const backfilling = !!brain?.backfill?.running || preparing
  const livePending = brain?.live?.pending ?? 0
  const backfillFailed = brain?.backfill?.failed ?? 0
  const indexProgress = brain?.backfill ? describeMeetingIndexProgress(brain.backfill) : null
  const lastIndexed = formatLastIndexedAt(brain?.lastIndexedAt)
  const updating = brainWorking
  const displayError = error || statusError || brainStatusError(brain)
  return (
    <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1 text-[11px] text-[color:var(--color-ink-2)]">
          <div className="flex items-center gap-1.5">
            <Network size={12} className="shrink-0 text-[var(--color-accent)]" />
            {displayError ? (
              <span className="text-[var(--color-danger)]">{displayError}</span>
            ) : updating ? (
              <span aria-atomic="true" aria-live="polite">
                {backfilling && indexProgress
                  ? indexProgress.label
                  : liveRunning
                    ? `Updating Intelligence from ${livePending} new meeting${livePending === 1 ? '' : 's'}…`
                    : 'Updating…'}
              </span>
            ) : backfillFailed > 0 && indexProgress ? (
              <span className="text-[var(--color-danger)]" role="alert">
                {indexProgress.label}. Retry Update Intelligence after checking AI settings.
              </span>
            ) : brain && brain.meetings > 0 ? (
              <>
                Intelligence · {countLabel(brain.meetings, 'meeting')} · {countLabel(brain.people, 'person', 'people')} ·{' '}
                {countLabel(brain.accounts, 'account')}
                {brain.deals > 0 ? ` · ${countLabel(brain.deals, 'deal')}` : ''}
              </>
            ) : (
              'Mantu Intelligence: build a brain from your meetings.'
            )}
          </div>
          {lastIndexed && !displayError && !updating && (
            <div className="mt-0.5 text-[10px] text-[color:var(--color-ink-3)]">Last indexed {lastIndexed}</div>
          )}
          {updating && (
            <div className="mt-1.5 flex items-center gap-2">
              <InlineOrb kind="searching" />
              {backfilling && indexProgress && (
                <WorkProgressMeter
                  active
                  ariaLabel="Mantu Intelligence meeting index progress"
                  className="min-w-0 flex-1"
                  percent={indexProgress.percent}
                  valueText={indexProgress.valueText}
                />
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {noProvider && onOpenSettings && <TextButton onClick={onOpenSettings}>Open Settings</TextButton>}
          <IntelligenceUpdateButton
            variant="text"
            updating={updating}
            disabled={busy}
            onClick={() => void backfill()}
          />
          <TextButton onClick={() => void openDashboard()} title="Open the Mantu Intelligence dashboard">
            <ExternalLink size={11} /> Mantu Intelligence
          </TextButton>
        </div>
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
              className="truncate max-w-full rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-accent-text)]"
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
// One meeting row — memoized so re-renders of RecallView (e.g. a keystroke in the search box before the
// debounced search resolves) don't re-render every already-rendered row, only ones whose props changed.
// ---------------------------------------------------------------------------

/** Exported for unit testing. */
export const MeetingRow = memo(function MeetingRow({
  meeting,
  isSelected,
  isActive,
  isDeleting,
  isEditing,
  editingValue,
  isRenaming,
  isOpen,
  error,
  indexStatus,
  indexError,
  hydration,
  onSelect,
  onOpen,
  onDownload,
  onToggleConnections,
  onTrash,
  onExport,
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
  /** T6 6d: Mantu Intelligence status dot — null renders nothing (no ingest signal yet). */
  indexStatus: MeetingIndexStatus | null
  /** FIX 4: the failed source's own error string (bounded — up to 20 across the whole list, see
   *  ingestStatus above), shown as the failed dot's tooltip. Null when unknown/not failed. */
  indexError: string | null
  hydration: RowHydration | undefined // this row's explicit-open download (useRecallHydration), if any
  onSelect: (file: string) => void
  onOpen: (file: string) => void
  /** The explicit open of a cloud-only row (its Download/Retry action or a double-click) — see openOnRow. */
  onDownload: (file: string) => void
  onToggleConnections: (file: string) => void
  onTrash: (file: string, title: string) => void
  /** Export a decrypted .md copy via a native save dialog (main process) — see recallExportPlain. */
  onExport: (file: string) => void
  onStartEdit: (file: string, title: string) => void
  onEditingChange: (value: string) => void
  onCommitEdit: () => void
  onCancelEdit: () => void
}): JSX.Element {
  const m = meeting
  const hit = 'snippet' in m ? (m as RecallHit) : null
  // One string for both the pointer tooltip and the accessible name — the dot is this row's only
  // per-meeting surface of the failure reason, so the two must never drift apart.
  const indexStatusText =
    indexStatus === 'indexed'
      ? 'Indexed in Mantu Intelligence'
      : indexStatus === 'failed'
        ? // FIX 4: name the actual reason when it's known, instead of a generic message.
          `Intelligence extraction failed${indexError ? `: ${indexError}` : ''}. Retry from Mantu Intelligence.`
        : 'Queued for Mantu Intelligence indexing'

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
              onDoubleClick={() => (m.notDownloaded ? onDownload : onOpen)(m.file)}
              className="no-drag focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06]"
            >
              <RowIcon meeting={m} />
              {/* T6 6d: smallest-possible Mantu Intelligence indicator — a dot, color is state (never
                  color alone; title carries the text for pointer users, aria-label for assistive tech —
                  it must exist in the accessibility tree, not be aria-hidden decoration). */}
              {indexStatus && (
                <span
                  role="img"
                  aria-label={indexStatusText}
                  title={indexStatusText}
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    indexStatus === 'indexed'
                      ? 'bg-[var(--color-success)]'
                      : indexStatus === 'failed'
                        ? 'bg-[var(--color-danger)]'
                        : 'bg-[color:var(--color-ink-3)]'
                  }`}
                />
              )}
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[color:var(--color-ink)]">
                {m.title}
              </span>

              <RowStatusChip meeting={m} hydration={hydration} />

              {/* Analyzing badge */}
              {isActive && (
                <span className="shrink-0 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] text-[color:var(--color-accent-text)]">
                  Just saved
                </span>
              )}

              {/* Task MI-5 — confidential lock chip: excluded from every published wiki page. */}
              {m.confidential && (
                <span
                  title="Confidential: excluded from published intelligence"
                  className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-danger)]/10 px-2 py-0.5 text-[10px] text-[var(--color-danger)]"
                >
                  <Lock size={10} /> Confidential
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

            <RowDownloadButton meeting={m} hydration={hydration} onOpen={onDownload} />

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

            {/* Export a decrypted markdown copy (native save dialog) — the hand-off for external tools
                like Claude local ingesting this meeting into the second brain. */}
            <button
              type="button"
              aria-label="Export meeting copy"
              title="Export copy (.md)"
              onClick={() => onExport(m.file)}
              className="no-drag focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-full text-[color:var(--color-ink-3)] transition-colors hover:bg-white/[0.06] hover:text-[color:var(--color-ink)]"
            >
              <FileDown size={12} />
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

      {/* Rename/delete/open error — transient inline message; see onTrash/commitEdit/openOnRow. */}
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
              className="truncate max-w-full rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-accent-text)]"
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

export type HistoryListItem =
  | { kind: 'date'; date: string }
  | { kind: 'meeting'; meeting: MeetingSummary | RecallHit }

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

