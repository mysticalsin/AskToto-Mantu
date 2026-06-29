import { useEffect, useState } from 'react'
import { Search, FolderOpen, FileText, Network, RefreshCw, ExternalLink, ChevronDown } from 'lucide-react'
import type { MeetingSummary, RecallHit, GraphStatus, GraphRelated } from '@shared/ipc'

function when(iso: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return iso
  }
}

/** Knowledge-graph controls (status + rebuild + open). Hidden unless the user enabled graphify. */
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
        <button
          type="button"
          onClick={rebuild}
          disabled={busy || status.building}
          title="Rebuild the graph from your notes"
          className="no-drag focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)] disabled:opacity-50"
        >
          <RefreshCw size={11} className={busy || status.building ? 'animate-spin' : ''} /> Rebuild
        </button>
        {status.hasGraph && (
          <button
            type="button"
            onClick={() => void window.toto.graphifyOpenGraph()}
            title="Open the interactive graph"
            className="no-drag focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
          >
            <ExternalLink size={11} /> Open graph
          </button>
        )}
      </div>
    </div>
  )
}

/** Inline "what this note connects to" panel, read from the graph. */
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

  if (!data) return <div className="px-2 py-1 text-[11px] text-[color:var(--color-ink-3)]">Loading connections…</div>
  if (!data.ok)
    return <div className="px-2 py-1 text-[11px] text-[color:var(--color-ink-3)]">{data.error || 'No graph yet.'}</div>
  if (data.topics.length === 0 && data.notes.length === 0)
    return <div className="px-2 py-1 text-[11px] text-[color:var(--color-ink-3)]">No connections found yet.</div>

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
            <span className="text-[10px] text-[color:var(--color-ink-3)]">via {n.via.join(', ')}</span>
          )}
        </button>
      ))}
    </div>
  )
}

export function RecallView({ onOpenFolder }: { onOpenFolder: () => void }): JSX.Element {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<(MeetingSummary | RecallHit)[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<string | null>(null) // file with its Related panel expanded

  // Single fetch owner: immediate on mount / empty query, debounced for typed searches. A stale-guard
  // drops out-of-order resolutions so a slow earlier response can't overwrite a newer one. (Previously a
  // separate eager effect double-fetched on mount.)
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-accent)]">
          Meeting history · {items.length}
        </div>
        <button
          type="button"
          onClick={onOpenFolder}
          className="no-drag focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
        >
          <FolderOpen size={11} /> Open folder
        </button>
      </div>

      <GraphBar />

      <div className="flex items-center gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.05] px-3 py-2">
        <Search size={14} className="text-[color:var(--color-ink-3)]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search past meetings…"
          spellCheck={false}
          aria-label="Search past meetings"
          className="no-drag font-body flex-1 bg-transparent text-[13px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-3)]"
        />
      </div>

      <div className="scroll-thin flex max-h-[420px] flex-col gap-1.5 overflow-y-auto pr-1">
        {loading ? (
          <div className="py-2 text-[13px] text-[color:var(--color-ink-2)]">Loading…</div>
        ) : items.length === 0 ? (
          <div className="py-2 text-[13px] text-[color:var(--color-ink-2)]">
            {q.trim() ? 'No matching meetings.' : 'No meetings saved yet. Finish one with End & review.'}
          </div>
        ) : (
          items.map((m) => (
            <div
              key={m.file}
              className="flex flex-col rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.03]"
            >
              <div className="flex items-stretch">
                <button
                  type="button"
                  onClick={() => void window.toto.recallOpen(m.file)}
                  className="no-drag focus-ring flex flex-1 flex-col gap-0.5 rounded-l-xl px-3 py-2 text-left hover:bg-white/[0.06]"
                >
                  <div className="flex items-center gap-1.5">
                    <FileText size={12} className="shrink-0 text-[color:var(--color-ink-3)]" />
                    <span className="truncate text-[13px] font-medium text-[color:var(--color-ink)]">
                      {m.title}
                    </span>
                  </div>
                  <div className="text-[11px] text-[color:var(--color-ink-3)]">
                    {when(m.date)} · {m.mode}
                    {m.durationMin ? ` · ${m.durationMin} min` : ''}
                    {m.participants.length ? ` · ${m.participants.join(', ')}` : ''}
                  </div>
                  {'snippet' in m && m.snippet && (
                    <div className="mt-0.5 line-clamp-2 text-[11px] text-[color:var(--color-ink-2)]">
                      …{m.snippet}…
                    </div>
                  )}
                </button>
                <button
                  type="button"
                  aria-label="Show connections"
                  aria-expanded={open === m.file}
                  title="Connections"
                  onClick={() => setOpen((o) => (o === m.file ? null : m.file))}
                  className="no-drag focus-ring flex items-center gap-1 rounded-r-xl px-2.5 text-[11px] text-[color:var(--color-ink-3)] hover:bg-white/[0.06] hover:text-[color:var(--color-ink)]"
                >
                  <Network size={13} />
                  <ChevronDown
                    size={12}
                    className={open === m.file ? 'rotate-180 transition-transform' : 'transition-transform'}
                  />
                </button>
              </div>
              {open === m.file && (
                <div className="border-t border-[var(--color-hair-soft)]">
                  <Related file={m.file} />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
