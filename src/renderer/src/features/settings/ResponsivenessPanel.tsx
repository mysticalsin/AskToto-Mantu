import { useEffect, useState } from 'react'
import { describeMetricEntry, type ResponsivenessReport } from '@shared/responsiveness-metrics'
import { AgentStatus } from '../../components/AgentStatus'

// Last report fetched this session, so a tab revisit shows the previous numbers while the effect refreshes.
let lastReport: ResponsivenessReport | null = null

/** One metric per row. Everything a number needs to be read honestly sits beside it. */
export function ResponsivenessRows({ report }: { report: ResponsivenessReport }): JSX.Element {
  return (
    <div className="flex flex-col gap-2 text-left">
      <div className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">Responsiveness</div>
      <p className="text-[10px] leading-snug text-[color:var(--cl-muted-foreground)]">
        Measured on {report.host.platform} {report.host.arch}, Métis {report.host.appVersion}. Targets are{' '}
        {report.budgetStatus} until the packaged measurements are in. Counts and timings only, kept on this device.
      </p>
      <ul className="flex flex-col gap-1.5">
        {report.entries.map((entry) => {
          const row = describeMetricEntry(entry, report.minSamples)
          return (
            <li
              key={entry.id}
              className="flex items-start justify-between gap-3 rounded-[10px] bg-[var(--cl-card)] px-3 py-2"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-[12px] text-[color:var(--cl-foreground)]">{row.label}</span>
                {row.note && <span className="text-[10px] text-[color:var(--cl-muted-foreground)]">{row.note}</span>}
              </span>
              <span className="flex flex-col items-end gap-0.5 text-right">
                <span className="text-[12px] font-semibold tabular-nums text-[color:var(--cl-foreground)]">
                  {row.value}
                </span>
                {row.budget && (
                  <span className="text-[10px] text-[color:var(--cl-muted-foreground)]">{row.budget}</span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Settings → About → Diagnostics: the responsiveness report from main. */
export function ResponsivenessPanel(): JSX.Element {
  const [report, setReport] = useState<ResponsivenessReport | null>(lastReport)
  const [loadErr, setLoadErr] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoadErr(false)
    void window.toto
      .readResponsiveness()
      .then((value) => {
        if (cancelled) return
        setReport(value)
        lastReport = value
      })
      .catch(() => {
        if (!cancelled) setLoadErr(true)
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  if (loadErr) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
        <span>Couldn’t load the responsiveness report.</span>
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
  if (!report) return <AgentStatus kind="searching" size="inline" caption />
  return <ResponsivenessRows report={report} />
}
