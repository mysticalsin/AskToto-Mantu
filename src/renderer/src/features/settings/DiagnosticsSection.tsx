import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import type { EvalMetrics } from '@shared/ipc'
import { AgentStatus } from '../../components/AgentStatus'

// Last metrics fetched this session — reusing this on remount lets a tab revisit show the previous
// numbers instantly instead of flashing "Loading…" again, while the effect below still refreshes it.
let lastMetrics: EvalMetrics | null = null

/** Usage panel from the local audit log. Computed on-device; never sent anywhere. */
export function DiagnosticsSection(): JSX.Element {
  const [m, setM] = useState<EvalMetrics | null>(lastMetrics)
  // Distinguish a genuine load FAILURE from the still-loading state — previously a failed readMetrics()
  // set m back to null, leaving "Loading…" on screen forever with no way to recover.
  const [loadErr, setLoadErr] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoadErr(false)
    void window.toto
      .readMetrics()
      .then((v) => {
        if (!cancelled) {
          setM(v)
          lastMetrics = v
        }
      })
      .catch(() => {
        if (!cancelled) setLoadErr(true)
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const ms = (v: number | null): string =>
    v == null ? 'N/A' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`
  const pct = (r: number | null): string => (r == null ? 'N/A' : `${Math.round(r * 100)}%`)
  const n = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))

  if (loadErr) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
        <span>Couldn’t load usage metrics.</span>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="no-drag focus-ring rounded-full bg-[var(--cl-card)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--cl-foreground)] hover:bg-white/10"
        >
          Retry
        </button>
      </div>
    )
  }
  if (!m) {
    return <AgentStatus kind="searching" size="inline" caption />
  }
  if (m.answers === 0 && m.acceptance.up + m.acceptance.down === 0) {
    return (
      <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">
        No data yet. Ask a few questions and rate some answers, then check back.
      </div>
    )
  }

  const card = (label: string, value: string, sub?: string): JSX.Element => (
    <div key={label} className="flex flex-col gap-0.5 rounded-[10px] bg-[var(--cl-card)] px-3 py-2">
      <span className="text-[10px] uppercase tracking-wide text-[color:var(--cl-muted-foreground)]">{label}</span>
      <span className="text-[16px] font-semibold tabular-nums text-[color:var(--cl-foreground)]">{value}</span>
      {sub && <span className="text-[10px] text-[color:var(--cl-muted-foreground)]">{sub}</span>}
    </div>
  )

  const byProviderEntries = Object.entries(m.byProvider).filter(([, v]) => v > 0)

  return (
    <div className="flex flex-col gap-4">
      {/* Volume */}
      <div className="grid grid-cols-3 gap-2">
        {card('Answers', String(m.answers))}
        {card('Tokens in', n(m.tokensIn))}
        {card('Tokens out', n(m.tokensOut))}
      </div>

      {/* Latency */}
      <div>
        <div className="mb-1.5 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">Latency</div>
        <div className="grid grid-cols-4 gap-2">
          {card('First token p50', ms(m.ttftP50Ms))}
          {card('First token p95', ms(m.ttftP95Ms))}
          {card('Full answer p50', ms(m.answerP50Ms))}
          {card('Full answer p95', ms(m.answerP95Ms))}
        </div>
      </div>

      {/* Quality */}
      <div>
        <div className="mb-1.5 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">Quality</div>
        <div className="grid grid-cols-4 gap-2">
          {card('Acceptance', pct(m.acceptance.rate))}
          {card('Rated up', String(m.acceptance.up))}
          {card('Rated down', String(m.acceptance.down))}
          {card('Fallbacks', String(m.fallbacks))}
        </div>
      </div>

      {/* By provider */}
      {byProviderEntries.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">By provider</div>
          <div className="flex flex-wrap gap-2">
            {byProviderEntries.map(([provider, count]) => (
              <div key={provider} className="flex flex-col gap-0.5 rounded-[10px] bg-[var(--cl-card)] px-3 py-2 min-w-[80px]">
                <span className="text-[10px] uppercase tracking-wide text-[color:var(--cl-muted-foreground)]">{provider}</span>
                <span className="text-[16px] font-semibold tabular-nums text-[color:var(--cl-foreground)]">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {m.failures > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
          <AlertCircle size={12} /> {m.failures} answer{m.failures !== 1 ? 's' : ''} failed
        </div>
      )}
    </div>
  )
}
