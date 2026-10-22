import { useEffect, useState } from 'react'
import type { GraphRelated } from '@shared/ipc'

/** The one-line state of the connections panel, or null when it has connections to show. A failed request
 *  says so instead of staying on the loading text. */
export function relatedMessage(data: GraphRelated | null, failed: boolean): string | null {
  if (!data) return failed ? 'Connections are unavailable right now.' : 'Loading connections…'
  if (!data.ok) return data.error || 'No graph yet.'
  if (data.topics.length === 0 && data.notes.length === 0) return 'No connections found yet.'
  return null
}

/** A meeting's inline connections panel (knowledge-graph neighbours). */
export function Related({ file, onOpen }: { file: string; onOpen: (file: string) => void }): JSX.Element {
  const [data, setData] = useState<GraphRelated | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setFailed(false)
    window.toto
      .graphifyRelated(file)
      .then((r) => alive && setData(r))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [file])

  const message = relatedMessage(data, failed)
  if (message || !data) return <div className="px-2 py-1 text-[11px] text-[color:var(--color-ink-3)]">{message}</div>

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
            <span className="truncate text-[10px] text-[color:var(--color-ink-3)]">via {n.via.join(', ')}</span>
          )}
        </button>
      ))}
    </div>
  )
}
