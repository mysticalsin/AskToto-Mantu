import { useCallback, useEffect, useState } from 'react'
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
  Brain
} from 'lucide-react'
import { TextButton } from './ui'
import type {
  MeetingSummary,
  RecallHit,
  GraphStatus,
  GraphRelated,
  CalendarTodayResult,
  CalendarEvent
} from '@shared/ipc'

// ---------------------------------------------------------------------------
// Helpers duplicated from Review.tsx — DO NOT edit Review.tsx; it owns these.
// ---------------------------------------------------------------------------

function formatDurationMin(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function meetingTime(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function groupByDate(
  meetings: (MeetingSummary | RecallHit)[]
): [string, (MeetingSummary | RecallHit)[]][] {
  const map = new Map<string, (MeetingSummary | RecallHit)[]>()
  for (const m of meetings) {
    const d = m.date.slice(0, 10)
    if (!map.has(d)) map.set(d, [])
    map.get(d)!.push(m)
  }
  return Array.from(map.entries())
}

function friendlyDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    if (d.toDateString() === today.toDateString()) return 'Today'
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  } catch {
    return dateStr
  }
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
  const [status, setStatus] = useState<GraphStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = (): void => void window.toto.graphifyStatus().then(setStatus)
  useEffect(refresh, [])

  if (!status || !status.enabled) return null

  if (!status.installed) {
    return (
      <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2 text-[11px] text-[color:var(--color-ink-2)]">
        Knowledge graph needs graphify. Run{' '}
        <code className="rounded bg-white/[0.08] px-1">pip install graphifyy</code> (or{' '}
        <code className="rounded bg-white/[0.08] px-1">uv tool install graphifyy</code>), then Rebuild.
      </div>
    )
  }

  const rebuild = async (): Promise<void> => {
    setBusy(true)
    setStatus(await window.toto.graphifyRebuild())
    setBusy(false)
  }

  return (
    <div className="flex items-center justify-between rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-ink-2)]">
        <Network size={12} className="text-[var(--color-accent)]" />
        {busy || status.building ? (
          'Building knowledge graph…'
        ) : status.hasGraph ? (
          <>
            Graph · {status.nodes ?? 0} nodes · {status.edges ?? 0} links
            {status.backend ? ` · ${status.backend}` : ''}
          </>
        ) : (
          'No graph yet. Build it from your notes.'
        )}
      </div>
      <div className="flex items-center gap-1">
        <TextButton
          onClick={rebuild}
          disabled={busy || status.building}
          title="Rebuild the graph from your notes"
        >
          <RefreshCw size={11} className={busy || status.building ? 'animate-spin' : ''} /> Rebuild
        </TextButton>
        {status.hasGraph && (
          <TextButton
            onClick={() => void window.toto.graphifyOpenGraph()}
            title="Open the interactive graph"
          >
            <ExternalLink size={11} /> Open graph
          </TextButton>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline connections panel — unchanged from original
// ---------------------------------------------------------------------------

function Related({ file }: { file: string }): JSX.Element {
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
              className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent)]"
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
          onClick={() => void window.toto.recallOpen(n.file)}
          className="no-drag focus-ring flex flex-col gap-0.5 rounded-lg px-2 py-1 text-left hover:bg-white/[0.06]"
        >
          <span className="truncate text-[12px] text-[color:var(--color-ink)]">{n.title}</span>
          {n.via.length > 0 && (
            <span className="text-[10px] text-[color:var(--color-ink-3)]">
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
  /** Optional: any row whose file === activeFile shows a purple "Analyzing" badge. */
  activeFile?: string
  /** Optional: called by the "New chat ⌘R" footer button. */
  onNewChat?: () => void
  /** Optional: open a meeting's recap in-app (Cluely recap detail). Falls back to OS-open when absent. */
  onOpenMeeting?: (file: string) => void
  /** Optional: opens the Mantu Intelligence dashboard (brain view). */
  onIntelligence?: () => void
}): JSX.Element {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<(MeetingSummary | RecallHit)[]>([])
  const [loading, setLoading] = useState(true)
  /** File whose knowledge-graph Related panel is expanded. */
  const [open, setOpen] = useState<string | null>(null)
  /** Single-click selection for the "Open ↵" footer action. */
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  /** File mid-delete — disables its trash button so a slow confirm dialog can't be double-clicked. */
  const [deleting, setDeleting] = useState<string | null>(null)

  // Meetings are always saved; deletion is the user's to undo that. The main process pops a native,
  // unmissable confirm dialog before actually deleting (single click here is unambiguous — no "did that
  // register?" two-click pattern), then removes the .md + its index row.
  const onTrash = useCallback(async (file: string, title: string): Promise<void> => {
    setDeleting(file)
    const r = await window.toto.recallDelete(file, title).catch(() => ({ ok: false }))
    setDeleting(null)
    if (r.ok) {
      setItems((xs) => xs.filter((x) => x.file !== file))
      setSelectedFile((s) => (s === file ? null : s))
      setOpen((o) => (o === file ? null : o))
    }
  }, [])

  // Single fetch owner: immediate on mount / empty query, debounced for typed searches.
  // A stale-guard drops out-of-order resolutions so a slow earlier response can't overwrite a newer one.
  useEffect(() => {
    let stale = false
    const run = (): void => {
      const p = q.trim() ? window.toto.recallSearch(q.trim()) : window.toto.recallList()
      p.then((l) => {
        if (!stale) setItems(l)
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
  const openMeeting = (f: string): void => {
    if (onOpenMeeting) onOpenMeeting(f)
    else void window.toto.recallOpen(f)
  }
  const openSelected = (): void => {
    const f = selectedFile ?? items[0]?.file
    if (f) openMeeting(f)
  }

  const groups = groupByDate(items)

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
            placeholder="Ask or search anything"
            spellCheck={false}
            aria-label="Search past meetings"
            className="no-drag font-body flex-1 bg-transparent text-[13px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-3)]"
          />
          <Search size={14} className="shrink-0 text-[color:var(--color-ink-3)]" />
        </div>
      </div>

      {/* ── UPCOMING CALENDAR SECTION ───────────────────────────────────── */}
      <UpcomingSection onConnectCalendar={onConnectCalendar} />

      {/* ── KNOWLEDGE GRAPH STATUS ──────────────────────────────────────── */}
      <div className="mb-2">
        <GraphBar />
      </div>

      {/* ── DATE-GROUPED MEETING LIST ───────────────────────────────────── */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-1">
        {loading ? (
          <div className="py-2 text-[13px] text-[color:var(--color-ink-2)]">Loading…</div>
        ) : items.length === 0 ? (
          <div className="py-2 text-[13px] text-[color:var(--color-ink-2)]">
            {q.trim()
              ? 'No matching meetings.'
              : 'No meetings saved yet. Finish one with End & review.'}
          </div>
        ) : (
          groups.map(([date, meetingsForDate]) => (
            <div key={date}>
              {/* Date group header */}
              <div className="cl-eyebrow px-1 pb-1 pt-2 text-[color:var(--color-ink-3)]">
                {friendlyDate(date)}
              </div>

              {meetingsForDate.map((m) => {
                const isSelected = selectedFile === m.file
                const isActive = activeFile === m.file
                const hit = 'snippet' in m ? (m as RecallHit) : null

                return (
                  <div
                    key={m.file}
                    className={`rounded-lg transition-colors${isSelected ? ' bg-white/[0.08]' : ''}`}
                  >
                    {/* Row */}
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setSelectedFile(m.file)}
                        onDoubleClick={() => openMeeting(m.file)}
                        className="no-drag focus-ring flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06]"
                      >
                        <FileText
                          size={12}
                          className="shrink-0 text-[color:var(--color-ink-3)]"
                        />
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[color:var(--color-ink)]">
                          {m.title}
                        </span>

                        {/* Analyzing badge */}
                        {isActive && (
                          <span className="shrink-0 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] text-[color:var(--color-accent)]">
                            Analyzing
                          </span>
                        )}

                        {/* Duration badge + time */}
                        <div className="ml-auto flex shrink-0 items-center gap-1.5">
                          {m.durationMin > 0 && (
                            <span className="rounded-full bg-white/[0.06] px-1.5 text-[10px] text-[color:var(--color-ink-3)]">
                              {formatDurationMin(m.durationMin)}
                            </span>
                          )}
                          <span className="tabular-nums text-[11px] text-[color:var(--color-ink-3)]">
                            {meetingTime(m.date)}
                          </span>
                        </div>
                      </button>

                      {/* Knowledge-graph expand — icon-only compact button */}
                      <button
                        type="button"
                        aria-label="Show connections"
                        aria-expanded={open === m.file}
                        title="Connections"
                        onClick={() => setOpen((o) => (o === m.file ? null : m.file))}
                        className="no-drag focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-full text-[color:var(--color-ink-3)] hover:bg-white/[0.06] hover:text-[color:var(--color-ink)]"
                      >
                        <Network size={12} />
                      </button>

                      {/* Delete — single click opens a native confirm dialog (main process); see onTrash. */}
                      <button
                        type="button"
                        aria-label="Delete meeting"
                        title="Delete"
                        disabled={deleting === m.file}
                        onClick={() => void onTrash(m.file, m.title)}
                        className="no-drag focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-full text-[color:var(--color-ink-3)] transition-colors hover:bg-[var(--color-danger)]/10 hover:text-[var(--color-danger)] disabled:opacity-40"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>

                    {/* Search snippet (RecallHit only) */}
                    {hit?.snippet && (
                      <div className="line-clamp-2 px-9 pb-1 text-[11px] text-[color:var(--color-ink-2)]">
                        …{hit.snippet}…
                      </div>
                    )}

                    {/* Topic chips — up to 3, derived from the recap's "## Tags" section (see saveMeeting). */}
                    {!!m.topics?.length && (
                      <div className="flex flex-wrap gap-1 px-9 pb-1.5">
                        {m.topics.slice(0, 3).map((t, i) => (
                          <span
                            key={`${t}-${i}`}
                            className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent)]"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Connections panel */}
                    {open === m.file && (
                      <div className="border-t border-[var(--color-hair-soft)]">
                        <Related file={m.file} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>

      {/* ── BOTTOM ACTION BAR ───────────────────────────────────────────── */}
      <div className="mt-2 flex items-center justify-between border-t border-[var(--color-hair-soft)] pt-2">
        <div className="flex items-center gap-1.5">
          <TextButton onClick={openSelected} disabled={items.length === 0}>
            Open
            <kbd className="rounded bg-white/[0.06] px-1 py-0.5 text-[10px] text-[color:var(--color-ink-3)]">↵</kbd>
          </TextButton>
          <TextButton icon={FolderOpen} onClick={onOpenFolder}>Open folder</TextButton>
          {onIntelligence && (
            <button
              type="button"
              onClick={onIntelligence}
              title="Mantu Intelligence — your meeting knowledge dashboard"
              className="no-drag focus-ring flex items-center gap-1.5 rounded-full bg-[var(--color-accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] ring-1 ring-inset ring-[var(--color-accent)]/30 transition-colors hover:bg-[var(--color-accent)]/25"
            >
              <Brain size={12} strokeWidth={2.2} /> Intelligence
            </button>
          )}
        </div>

        {onNewChat && (
          <TextButton onClick={onNewChat}>
            New chat
            <kbd className="rounded bg-white/[0.06] px-1 py-0.5 text-[10px] text-[color:var(--color-ink-3)]">⌘R</kbd>
          </TextButton>
        )}
      </div>
    </div>
  )
}
