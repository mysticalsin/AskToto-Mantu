// @ts-nocheck
import { AlertTriangle, ArrowLeft, Brain, Building2, CalendarCheck, Check, ChevronRight, ClipboardList, ExternalLink, FileWarning, Users, VolumeX, X } from 'lucide-react'
import { BrainRecordPage, recordKey, sortAttentionItems } from '../brain-record-page/BrainRecordPage'
import { AgentStatus, InlineOrb } from '../../components/AgentStatus'
import { WorkProgressMeter } from '../../components/WorkProgressMeter'
import { TextButton } from '../../components/ui'
import { MantuMark } from '../../components/MantuMark'
import { IntelligenceUpdateButton } from '../../components/IntelligenceUpdateButton'
import { NO_PROVIDER_INDEX_COPY } from '../../lib/intelligence-update'
import { VirtualList } from '../../ui/VirtualList'
import { renderMarsMarkdown } from '@shared/mars'
import {
  DealRow,
  MIXED_COLOR,
  PersonRow,
  SectionTitle,
  SectorBars,
  StatTile,
  TimeSavedCard,
  WeeklyBars
} from './brain-widgets'

export function BrainViewLayout(props: any): JSX.Element {
  const {
    record,
    data,
    openRecord,
    onOpenMeeting,
    refresh,
    setError,
    setRecentMerge,
    recentMerge,
    undoMerge,
    ingested,
    statusWorking,
    backfilling,
    meetings,
    runIntelligencePass,
    canIndex,
    onOpenSettings,
    bf,
    live,
    status,
    notIngested,
    startBackfill,
    usageStats,
    timeSavedAssumptions,
    nextStepsCount,
    attention,
    sectors,
    openPromises,
    openPromisesRef,
    settlePromise,
    mars,
    marsPrev,
    marsCopied,
    flashMarsCopied,
    silence,
    deals,
    handleSetDealOutcome,
    accountIdByName,
    people,
    resetCorruptionLock,
    onDashboardOpen,
    visibleError,
    failuresExpanded,
    setFailuresExpanded,
    indexProgress,
    durableFailed,
    topError,
    localFallbackReady,
    loading,
    setRecord,
    onBack
  } = props
  return (
    <div className="fade-up flex flex-col gap-3 px-1 py-1">
      {/* Header — Mantu-branded */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label="Back"
          // A record page pops back to the dashboard first; only a second Back leaves Mantu Intelligence
          // entirely — matching how every other in-component drill-down in this app layers Escape/Back.
          onClick={() => (record ? setRecord(null) : onBack())}
          className="no-drag focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]"
        >
          <ArrowLeft size={15} />
        </button>
        <MantuMark size={22} />
        <div className="min-w-0 flex-1">
          <div className="font-ui text-[15px] font-semibold tracking-tight text-[color:var(--color-ink)]">
            Mantu Intelligence
          </div>
          <div className="text-[11px] text-[color:var(--color-ink-3)]">
            {record
              ? 'Record'
              : status?.lastIndexedAt
                ? `Last indexed ${new Date(status.lastIndexedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                : 'Your meeting knowledge, compounding. Grounded in transcripts, never invented.'}
          </div>
        </div>
        <IntelligenceUpdateButton
          updating={backfilling || statusWorking}
          disabled={backfilling}
          onClick={() => void runIntelligencePass()}
        />
      </div>

      {visibleError && (
        <div className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-1.5 text-[11px] text-[var(--color-danger)]">
          {visibleError}
        </div>
      )}

      {durableFailed > 0 && !bf?.running && (
        <div
          className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-[11px] text-[var(--color-danger)]"
          role="alert"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <AlertTriangle size={13} className="shrink-0" />
              <span>
                {topError
                  ? `Your AI provider is failing: ${topError}. Check Settings → AI`
                  : indexProgress?.label ?? 'Some meetings need attention.'}
              </span>
            </div>
            <span className="flex shrink-0 items-center gap-1">
              {/* Per-file detail (FIX 4): failedDetails is bounded (up to 20) by main — never the whole
                  ledger — so this toggle is safe to render unconditionally once any detail exists. */}
              {(status?.failedDetails?.length ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={() => setFailuresExpanded((v) => !v)}
                  aria-expanded={failuresExpanded}
                  className="no-drag focus-ring shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold text-[color:var(--color-danger)] hover:bg-white/[0.08]"
                >
                  {failuresExpanded ? 'Hide' : 'Details'}
                </button>
              )}
              <IntelligenceUpdateButton
                variant="retry"
                idleLabel="Retry index"
                updating={backfilling || statusWorking}
                disabled={backfilling}
                onClick={() => void startBackfill()}
                title="Retry the Intelligence index"
              />
            </span>
          </div>
          {failuresExpanded && (status?.failedDetails?.length ?? 0) > 0 && (
            <ul className="mt-2 flex list-disc flex-col gap-0.5 border-t border-[var(--color-danger)]/20 pl-4 pt-2 text-[color:var(--color-ink-2)]">
              {status!.failedDetails!.map((d) => (
                <li key={d.file} className="truncate" title={`${d.file}: ${d.error}`}>
                  <span className="font-medium">{d.file}</span>
                  {d.exhausted ? ' (exhausted): ' : ': '}
                  {d.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center py-10">
          <AgentStatus kind="searching" size="hero" />
        </div>
      ) : record && data ? (
        <BrainRecordPage
          // Force a genuine remount on every record change (incl. direct record→record transitions:
          // post-merge onOpenRecord to the survivor, post-undo setRecord to the restored source).
          // Without this React reuses the instance and leftover local edit state (header rename draft,
          // each FieldCard's editing/draft/pending) would survive the swap and save to the WRONG entity
          // — a misattribution the whole correction feature exists to prevent. See recordKey's doc.
          key={recordKey(record)}
          recordRef={record}
          data={data}
          onOpenRecord={openRecord}
          onOpenMeeting={onOpenMeeting}
          onRefresh={async () => { await refresh() }}
          onError={setError}
          onMerged={setRecentMerge}
          recentMerge={recentMerge}
          onUndoMerge={() => void undoMerge()}
          onDismissMerge={() => setRecentMerge(null)}
        />
      ) : ingested === 0 && !statusWorking && !backfilling ? (
        /* Empty state — the brain has not ingested anything yet. */
        <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-6 py-8 text-center">
          <Brain size={28} className="text-[color:var(--color-accent-2)]" />
          <div className="text-[13px] font-semibold text-[color:var(--color-ink)]">
            Build your intelligence from {meetings.length > 0 ? `${meetings.length} saved meeting${meetings.length === 1 ? '' : 's'}` : 'your meetings'}
          </div>
          <div className="max-w-[380px] text-[12px] leading-snug text-[color:var(--color-ink-3)]">
            {meetings.length > 0
              ? 'Métis extracts people, accounts, deals, and win/loss signals from every saved transcript. Update Intelligence to run that pass now. Local AI is first, then your API if Local cannot run.'
              : 'Save a meeting, then use Update Intelligence to build your knowledge from the transcript.'}
          </div>
          <IntelligenceUpdateButton
            variant="accent"
            updating={backfilling || statusWorking}
            disabled={backfilling || meetings.length === 0}
            onClick={() => void runIntelligencePass()}
          />
          {/* canIndex ORs in localFallbackReady — a local-only setup already indexes fine, so this must
              only claim "no provider" when NEITHER a cloud provider NOR the local safety net is live. */}
          {!canIndex && meetings.length > 0 && (
            <div className="flex flex-col items-center gap-0.5 text-[11px] text-[color:var(--color-ink-3)]">
              <span>{NO_PROVIDER_INDEX_COPY}</span>
              {onOpenSettings && <TextButton onClick={onOpenSettings}>Open Settings</TextButton>}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Backfill progress + drift note */}
          {bf?.running ? (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-[var(--color-accent-soft)] px-3 py-2 text-[11px] text-[color:var(--color-ink-2)]">
              <div className="flex items-center gap-2">
                <InlineOrb kind="searching" />
                <span aria-atomic="true" aria-live="polite">{indexProgress?.label ?? 'Updating…'}</span>
              </div>
              <WorkProgressMeter
                active
                ariaLabel="Mantu Intelligence meeting index progress"
                className="mt-1.5"
                percent={indexProgress?.percent ?? null}
                valueText={indexProgress?.valueText ?? 'Mapping meetings'}
              />
            </div>
          ) : live?.running ? (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-[var(--color-accent-soft)] px-3 py-2 text-[11px] text-[color:var(--color-ink-2)]">
              <div className="flex items-center gap-2">
                <InlineOrb kind="searching" />
                <span aria-atomic="true" aria-live="polite">
                  Updating Intelligence from {live.pending} new meeting{live.pending === 1 ? '' : 's'}…
                </span>
              </div>
            </div>
          ) : status?.intelligenceIndex?.running ? (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-[var(--color-accent-soft)] px-3 py-2 text-[11px] text-[color:var(--color-ink-2)]">
              <div className="flex items-center gap-2">
                <InlineOrb kind="searching" />
                <span aria-atomic="true" aria-live="polite">Finishing Intelligence update…</span>
              </div>
              <WorkProgressMeter
                active
                ariaLabel="Mantu Intelligence completion progress"
                className="mt-1.5"
                percent={null}
                valueText="Finishing summaries and saving Intelligence"
              />
            </div>
          ) : notIngested > 0 ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-1.5 text-[11px] text-[color:var(--color-ink-3)]">
              <span>
                {notIngested} saved meeting{notIngested === 1 ? '' : 's'} not in the brain yet.
                {!canIndex && ' Connect an AI provider in Settings to ingest them.'}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {!canIndex && onOpenSettings && <TextButton onClick={onOpenSettings}>Open Settings</TextButton>}
                <IntelligenceUpdateButton
                  variant="retry"
                  updating={backfilling || statusWorking}
                  disabled={backfilling}
                  onClick={() => void startBackfill()}
                />
              </span>
            </div>
          ) : null}

          {/* Honest time-saved estimate — above the measured tiles, visibly distinct from them. */}
          <TimeSavedCard
            usageStats={usageStats}
            assumptions={timeSavedAssumptions}
            nextSteps={nextStepsCount}
            onAdjust={() => onOpenSettings?.()}
          />

          {/* FACTUAL — KPI tiles */}
          <div className="flex gap-2">
            <StatTile value={ingested} label="Meetings" />
            <StatTile value={status?.people ?? 0} label="People" />
            <StatTile value={status?.accounts ?? 0} label="Accounts" />
            <StatTile value={status?.deals ?? 0} label="Deals" />
            <StatTile value={status?.edges ?? 0} label="Connections" />
          </div>

          {/* Ingested, but nothing extracted — explain the 0/0/0 instead of leaving bare zeros that read
              as "broken". Happens with short or non-client-facing transcripts. */}
          {ingested > 0 &&
            !bf?.running &&
            (status?.people ?? 0) === 0 &&
            (status?.accounts ?? 0) === 0 &&
            (status?.deals ?? 0) === 0 && (
              <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5 text-[12px] leading-snug text-[color:var(--color-ink-3)]">
                Meetings are ingested, but no people, accounts, or deals were extracted yet. Usually the
                transcripts are short or don&rsquo;t name clients. Longer, client-facing meetings will fill this in.
              </div>
            )}

          {/* ATTENTION — lint contradictions, AMBIGUOUS fields, and pins a later meeting disputed. Never
              auto-resolved; each row jumps straight to the entity's record page. Empty state is a single
              quiet line (not a panel) — an empty queue is good news, not a gap to explain. */}
          <div>
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
                <AlertTriangle size={11} /> Attention
              </span>
              {attention.length > 0 && (
                <span className="rounded-full bg-white/[0.08] px-1.5 py-px text-[10px] font-semibold text-[color:var(--color-ink-2)]">
                  {attention.length}
                </span>
              )}
            </div>
            {attention.length === 0 ? (
              <div className="text-[12px] text-[color:var(--color-ink-3)]">Nothing needs a look right now.</div>
            ) : (
              <div className="flex flex-col gap-1 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
                {sortAttentionItems(attention)
                  .slice(0, 8)
                  .map((item, i) => (
                    <button
                      key={`${item.kind}:${item.entityKind ?? 'file'}:${item.id}:${i}`}
                      type="button"
                      // 'ingest_failed' has no entity to jump to (see AttentionItemSchema's doc comment)
                      // — its `id` is the source filename, so it opens the transcript instead.
                      onClick={() =>
                        item.kind === 'ingest_failed' ? onOpenMeeting?.(item.id) : openRecord(item.entityKind!, item.id)
                      }
                      className="no-drag focus-ring flex items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-white/[0.06]"
                    >
                      {item.kind === 'ingest_failed' && (
                        <FileWarning size={12} className="shrink-0 text-[color:var(--color-danger)]" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="text-[12px] font-semibold text-[color:var(--color-ink)]">{item.label}</span>
                        <span className="block truncate text-[11px] text-[color:var(--color-ink-3)]">{item.detail}</span>
                      </span>
                      <ChevronRight size={13} className="shrink-0 text-[color:var(--color-ink-3)]" />
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* FACTUAL — volume + sectors */}
          <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
            <SectionTitle>Meetings per week</SectionTitle>
            <WeeklyBars meetings={meetings} />
          </div>

          {sectors.length > 0 && (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
              <SectionTitle>
                <Building2 size={11} className="mr-1 inline" />
                Accounts by sector
              </SectionTitle>
              <SectorBars sectors={sectors} />
            </div>
          )}

          {/* COMMITMENT LEDGER — open promises across every deal AND deal-less person ledger, oldest
              (most urgent) first. */}
          {openPromises.length > 0 && (
            <div
              ref={openPromisesRef}
              tabIndex={-1}
              className="focus-ring rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5"
            >
              <SectionTitle>
                <CalendarCheck size={11} className="mr-1 inline" />
                Open promises
              </SectionTitle>
              <div className="flex flex-col gap-1">
                {openPromises.map((c) => {
                  const days = c.date ? Math.max(0, Math.floor((Date.now() - Date.parse(c.date)) / 86400000)) : null
                  const yours = c.by === 'you'
                  // A person-only row (no deal.commitments source, see the useMemo above) has no deal to
                  // settle against — settleCommitment (ingest.ts) is deal-keyed only, a known limitation,
                  // not a bug — so the Kept/Broken actions only render for deal-backed rows.
                  const dealName = c.deal
                  return (
                    <div key={c.meeting + c.text + (c.deal ?? c.person ?? '')} className="flex items-center gap-2 text-[12px]" title={c.quote || undefined}>
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                        style={{
                          color: yours ? 'var(--color-accent-2)' : MIXED_COLOR,
                          background: 'rgba(255,255,255,0.05)'
                        }}
                      >
                        {yours ? 'You' : c.by === 'them' ? 'Them' : c.by}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[color:var(--color-ink-2)]">{c.text}</span>
                      {c.due_hint && (
                        <span
                          className="max-w-[110px] shrink-0 truncate text-[10px] italic text-[color:var(--color-ink-3)]"
                          title={c.due_hint}
                        >
                          “{c.due_hint}”
                        </span>
                      )}
                      {days !== null && (
                        <span
                          className="shrink-0 text-[10px] font-semibold"
                          style={{ color: days >= 7 ? 'var(--color-danger)' : 'var(--color-ink-3)' }}
                        >
                          {days === 0 ? 'today' : `${days}d`}
                        </span>
                      )}
                      {/* Deal name today, the speaker's own name for a deal-less commitment — same slot,
                          same subdued styling, so the source reads without shouting either way. */}
                      <span
                        className="min-w-0 max-w-[90px] shrink truncate text-[10px] text-[color:var(--color-ink-3)]"
                        title={dealName ?? c.person}
                      >
                        {dealName ?? c.person}
                      </span>
                      {/* Settlement — the human closes the loop. Settled rows leave this rail on refresh
                          and feed the per-person kept-promise reliability read. Deal-backed rows only. */}
                      {dealName && (
                        <span className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            aria-label="Mark kept"
                            title="Kept: promise delivered"
                            onClick={() => void settlePromise(dealName, c.text, 'kept')}
                            className="no-drag focus-ring grid h-5 w-5 place-items-center rounded text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[var(--color-success)]"
                          >
                            <Check size={11} />
                          </button>
                          <button
                            type="button"
                            aria-label="Mark broken"
                            title="Broken: promise not delivered"
                            onClick={() => void settlePromise(dealName, c.text, 'broken')}
                            className="no-drag focus-ring grid h-5 w-5 place-items-center rounded text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[var(--color-danger)]"
                          >
                            <X size={11} />
                          </button>
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* MARS WEEK — the weekly-report section: this week's facts, ready to file. */}
          {mars.meetings.length > 0 && (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
              <div className="mb-1.5 flex items-center justify-between">
                <SectionTitle>
                  <ClipboardList size={11} className="mr-1 inline" />
                  Mars week: {mars.weekStart} → {mars.weekEnd}
                </SectionTitle>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(renderMarsMarkdown(mars))
                      .then(() => {
                        flashMarsCopied()
                      })
                      .catch((e) => setError(`Copy failed: ${e instanceof Error ? e.message : String(e)}`))
                  }}
                  title="Copy the full Mars draft as markdown"
                  className="no-drag focus-ring flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]"
                >
                  {marsCopied ? <Check size={11} className="text-[var(--color-success)]" /> : <ClipboardList size={11} />}
                  {marsCopied ? 'Copied' : 'Copy draft'}
                </button>
              </div>
              <div className="mb-2 grid grid-cols-4 gap-1.5 text-center">
                {(
                  [
                    ['Meetings', mars.meetings.length, marsPrev.meetings.length],
                    ['New accounts', mars.newAccounts.length, marsPrev.newAccounts.length],
                    ['Won', mars.won.length, marsPrev.won.length],
                    ['Lost', mars.lost.length, marsPrev.lost.length]
                  ] as const
                ).map(([label, n, prev]) => {
                  const d = n - prev
                  return (
                    <div key={label} className="rounded-lg bg-white/[0.03] px-1.5 py-1">
                      <div className="flex items-baseline justify-center gap-1">
                        <span className="text-[15px] font-semibold text-[color:var(--color-ink)]">{n}</span>
                        {d !== 0 && (
                          <span
                            className="text-[9px] font-semibold"
                            title={`${prev} last week`}
                            style={{
                              // Direction color follows MEANING: more losses is bad, more of the rest is good.
                              color:
                                (label === 'Lost' ? d < 0 : d > 0) ? 'var(--color-success)' : 'var(--color-danger)'
                            }}
                          >
                            {d > 0 ? `▲${d}` : `▼${-d}`}
                          </span>
                        )}
                      </div>
                      <div className="text-[9px] uppercase tracking-wide text-[color:var(--color-ink-3)]">{label}</div>
                    </div>
                  )
                })}
              </div>
              <div className="flex flex-col gap-1">
                {mars.meetings.slice(0, 6).map((m) => (
                  <div key={m.date + m.title} className="flex items-center gap-2 text-[12px]">
                    <span className="shrink-0 text-[10px] tabular-nums text-[color:var(--color-ink-3)]">{m.date.slice(5)}</span>
                    <span className="min-w-0 flex-1 truncate text-[color:var(--color-ink-2)]">
                      <span className="text-[color:var(--color-ink)]">{m.title}</span>
                      {m.account && <span className="text-[color:var(--color-ink-3)]"> · {m.account}</span>}
                    </span>
                    {m.firstContact && (
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
                        style={{ color: 'var(--color-accent-2)', background: 'rgba(255,255,255,0.05)' }}
                      >
                        First contact
                      </span>
                    )}
                    {m.band && (
                      <span className="shrink-0 text-[10px] text-[color:var(--color-ink-3)]">{m.band}</span>
                    )}
                  </div>
                ))}
                {mars.meetings.length > 6 && (
                  <div className="text-[10px] text-[color:var(--color-ink-3)]">
                    +{mars.meetings.length - 6} more in the copied draft
                  </div>
                )}
              </div>
              {(mars.openFollowups.length > 0 || mars.atRisk.length > 0) && (
                <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] text-[color:var(--color-ink-3)]">
                  {mars.openFollowups.length > 0 && (
                    <span className="rounded px-1.5 py-0.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                      {mars.openFollowups.length} open follow-up{mars.openFollowups.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {mars.atRisk.length > 0 && (
                    <span className="rounded px-1.5 py-0.5" style={{ background: 'rgba(255,255,255,0.04)', color: MIXED_COLOR }}>
                      {mars.atRisk.length} at risk
                    </span>
                  )}
                </div>
              )}
              <div className="mt-1.5 text-[10px] text-[color:var(--color-ink-3)]">
                Facts from recorded meetings. The Mars bucket (prospection / cold call / QM) is yours to confirm.
              </div>
            </div>
          )}

          {/* SILENCE DETECTOR — accounts going quiet: dropped themes, vanished champions, cooling, dark */}
          {silence.length > 0 && (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
              <SectionTitle>
                <VolumeX size={11} className="mr-1 inline" />
                Going quiet: what accounts stopped saying
              </SectionTitle>
              <div className="flex flex-col gap-1.5">
                {silence.map((s) => (
                  <div key={s.account} className="text-[12px]">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate font-semibold text-[color:var(--color-ink)]">{s.account}</span>
                      <span className="shrink-0 text-[10px] text-[color:var(--color-ink-3)]">{s.sector}</span>
                      <span className="flex-1" />
                      {s.cooling && (
                        <span className="shrink-0 text-[10px] font-semibold" style={{ color: MIXED_COLOR }}>
                          cooling
                        </span>
                      )}
                      {s.wentDark ? (
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                          style={{ color: 'var(--color-danger)', background: 'rgba(255,255,255,0.05)' }}
                        >
                          Silent {s.daysQuiet}d
                        </span>
                      ) : (
                        <span
                          className="shrink-0 text-[10px] font-semibold"
                          style={{ color: s.daysQuiet >= 30 ? 'var(--color-danger)' : 'var(--color-ink-3)' }}
                        >
                          {s.daysQuiet}d quiet
                        </span>
                      )}
                    </div>
                    {(s.droppedTopics.length > 0 || s.vanishedPeople.length > 0) && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-[color:var(--color-ink-3)]">
                        {s.droppedTopics.slice(0, 4).map((t) => (
                          <span key={t.topic} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                            dropped: {t.topic}
                          </span>
                        ))}
                        {s.vanishedPeople.slice(0, 2).map((p) => (
                          <span key={p} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                            {p} went quiet
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PREDICTIVE — opportunities */}
          {deals.length > 0 && (
            <div>
              <SectionTitle>Opportunities: win read &amp; momentum</SectionTitle>
              <VirtualList
                items={deals}
                getKey={(deal) => `deal:${deal.id}`}
                estimateSize={(deal) => (deal.band_evidence && deal.outcome === 'open' ? 94 : 70)}
                className="scroll-thin h-[min(520px,60vh)] overflow-y-auto"
                contentClassName="pr-1"
                ariaLabel="Opportunities"
                renderItem={({ item, style, measureRef }) => (
                  <div key={item.id} ref={measureRef} style={style} className="pb-1.5">
                    <DealRow
                      deal={item}
                      onSetOutcome={handleSetDealOutcome}
                      onOpenRecord={openRecord}
                      accountIdByName={accountIdByName}
                    />
                  </div>
                )}
              />
            </div>
          )}

          {/* FACTUAL — people */}
          {people.length > 0 && (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
              <SectionTitle>
                <Users size={11} className="mr-1 inline" />
                People you meet
              </SectionTitle>
              <VirtualList
                items={people}
                getKey={(person) => `person:${person.id}`}
                estimateSize={() => 34}
                className="scroll-thin h-[min(320px,45vh)] overflow-y-auto"
                contentClassName="pr-1"
                ariaLabel="People you meet"
                renderItem={({ item, style, measureRef }) => (
                  <div key={item.id} ref={measureRef} style={style} className="pb-1">
                    <PersonRow person={item} onOpenRecord={openRecord} />
                  </div>
                )}
              />
            </div>
          )}

          {(status?.corruptionBlocked || data?.index.replayError) && (
            <div className="rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2.5">
              <SectionTitle>
                <AlertTriangle size={11} className="mr-1 inline" />
                Corrections paused
              </SectionTitle>
              <div className="text-[11px] text-[color:var(--color-ink-2)]">
                {data?.index.replayError
                  ? `A rebuild could not re-apply your saved corrections: ${data.index.replayError}`
                  : 'The correction journal on this device was locked after a corruption was detected and preserved. Your prior corrections are safe in a preserved copy.'}
              </div>
              {status?.corruptionBlocked && (
                <button
                  type="button"
                  onClick={() => void resetCorruptionLock()}
                  className="no-drag focus-ring mt-2 rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-ink)] hover:bg-white/[0.08]"
                >
                  Reset corrections lock
                </button>
              )}
            </div>
          )}

          {/* MQA-230: a deleted meeting's transcript + extraction are removed synchronously, but items
              attributed to it inside entity files wait on the next source refresh (needs a usable
              provider). Say so — a silent wait reads as a completed delete. */}
          {status?.cleanupPending && (
            <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2 text-[11px] text-[color:var(--color-ink-2)]">
              Cleanup after a deleted meeting is pending — references to it are removed automatically the
              next time indexing runs.
            </div>
          )}

          {/* Lint warnings — contradictions the ingest refused to auto-resolve (the replay-failure notice
              is shown in the banner above, so it's filtered out here to avoid duplication + being cut off). */}
          {(() => {
            const lint = (data?.index.warnings ?? []).filter((w) => !w.includes('re-apply your saved corrections'))
            return lint.length > 0 ? (
              <div className="rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/5 px-3 py-2">
                <SectionTitle>
                  <AlertTriangle size={11} className="mr-1 inline" />
                  Needs a human read
                </SectionTitle>
                <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-[color:var(--color-ink-3)]">
                  {lint.slice(0, 5).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null
          })()}

          {/* Footer: escalate from this in-overlay glance to the full dedicated dashboard window */}
          <button
            type="button"
            onClick={() => {
              void window.toto.brainOpenDashboard()
                .catch((e) => ({ ok: false, error: String(e) }))
                .then((r) => {
                  if (!r.ok) setError(r.error || 'Could not open Mantu Intelligence.')
                  else onDashboardOpen?.()
                })
            }}
            className="no-drag focus-ring flex items-center justify-center gap-1.5 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2 text-[11px] font-semibold text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]"
          >
            <ExternalLink size={12} /> Open the full Mantu Intelligence dashboard
          </button>
        </>
      )}
    </div>
  )
}
