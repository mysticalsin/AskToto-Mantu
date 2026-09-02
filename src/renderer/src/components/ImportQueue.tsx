import type { ImportAssetsProgress, ImportJobView } from '@shared/ipc'
import { X } from 'lucide-react'
import { TextButton } from './ui'
import { InlineOrb } from './AgentStatus'
import { WorkProgressMeter } from './WorkProgressMeter'
import { describeImportProgress } from './work-progress'
import { importQueueHeadline, visibleImportJobs } from './import-queue'

export function ImportQueue({
  jobs,
  assets,
  dragOver,
  error,
  onCancel,
  onResume,
  onDismiss,
  onOpenMeeting
}: {
  jobs: ImportJobView[]
  assets: ImportAssetsProgress | null
  dragOver: boolean
  error: string | null
  onCancel: (jobId: string) => void
  onResume: (jobId: string) => void
  onDismiss: (jobId: string) => void
  onOpenMeeting: (file: string) => void
}): JSX.Element | null {
  const visible = visibleImportJobs(jobs)
  const fetching = assets?.status === 'downloading'
  const fetchError = assets?.status === 'error' ? assets.label || assets.error : null
  if (!visible.length && !error && !fetching && !fetchError && !dragOver) return null
  const headline = importQueueHeadline(visible)

  return (
    <section
      aria-label="Import queue"
      className={`mb-2 rounded-xl border px-3 py-2 ${
        dragOver
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
          : 'border-[var(--color-hair-soft)] bg-white/[0.03]'
      }`}
    >
      {dragOver && (
        <div className="mb-2 text-[12px] text-[color:var(--color-ink)]">Drop recordings to import them</div>
      )}
      {headline && (
        <div className="mb-2 text-[11px] font-medium tracking-wide text-[color:var(--color-ink-3)]">
          {headline}
        </div>
      )}
      {error && <div className="mb-2 text-[11px] text-[var(--color-danger)]">{error}</div>}
      {fetchError && <div className="mb-2 text-[11px] text-[var(--color-danger)]">{fetchError}</div>}
      {fetching && (
        <div className="mb-2">
          <div className="text-[12px] text-[color:var(--color-ink)]">Getting transcription files…</div>
          <div className="mt-1 flex items-center gap-2">
            <InlineOrb kind="loading-model" />
            <WorkProgressMeter
              active
              ariaLabel="Transcription file download"
              className="min-w-0 flex-1"
              percent={Math.round((assets?.progress ?? 0) * 100) || null}
              valueText="Getting transcription files"
            />
          </div>
        </div>
      )}
      {visible.map((job) => {
        const progress = describeImportProgress(job)
        return (
          <div
            key={job.jobId}
            aria-busy={progress.active || undefined}
            className="mb-2 last:mb-0 rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2"
          >
            <div className="flex items-center gap-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate font-medium text-[color:var(--color-ink)]">
                {job.title}
              </span>
              <span className="shrink-0 text-[color:var(--color-ink-3)]">{progress.label}</span>
              {job.state === 'failed' ? (
                <>
                  <TextButton
                    onClick={() => onResume(job.jobId)}
                    title="Resume this import from its last saved transcript checkpoint"
                  >
                    Resume
                  </TextButton>
                  <TextButton
                    icon={X}
                    ariaLabel="Dismiss failed import"
                    onClick={() => onDismiss(job.jobId)}
                    title="Dismiss this failed import"
                  />
                </>
              ) : job.state === 'done' && job.recapError && job.file ? (
                <>
                  <TextButton onClick={() => onOpenMeeting(job.file!)} title="Open this meeting and retry its summary">
                    Open meeting
                  </TextButton>
                  <TextButton
                    icon={X}
                    ariaLabel="Dismiss this summary notice"
                    onClick={() => onDismiss(job.jobId)}
                    title="Dismiss, the transcript is already saved"
                  />
                </>
              ) : job.state === 'done' ? (
                <>
                  {job.file && (
                    <TextButton onClick={() => onOpenMeeting(job.file!)} title="Open this meeting">
                      Open
                    </TextButton>
                  )}
                  <TextButton
                    icon={X}
                    ariaLabel="Dismiss finished import"
                    onClick={() => onDismiss(job.jobId)}
                    title="Dismiss this finished import"
                  />
                </>
              ) : (
                <TextButton onClick={() => onCancel(job.jobId)} title="Cancel this import">
                  Cancel
                </TextButton>
              )}
            </div>
            {(progress.active || progress.percent !== null) && (
              <div className="mt-1.5">
                <div aria-atomic="true" aria-live="polite" className="text-[11px] text-[color:var(--color-ink-3)]">
                  {progress.detail}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  {(progress.percent == null || progress.pulseAtFull) && (
                    <InlineOrb kind={progress.pulseAtFull ? 'writing' : 'loading-model'} />
                  )}
                  <WorkProgressMeter
                    active={progress.active}
                    ariaLabel={`${job.title} import progress`}
                    className="min-w-0 flex-1"
                    percent={progress.percent}
                    pulseAtFull={progress.pulseAtFull}
                    valueText={progress.valueText}
                  />
                </div>
              </div>
            )}
            {job.state === 'recapping' && job.recapPartial && (
              <div
                aria-live="off"
                className="mt-1 line-clamp-2 text-[11px] text-[color:var(--color-ink-3)]"
                title="Summary so far"
              >
                {job.recapPartial.slice(-280)}
              </div>
            )}
            {job.error && <div className="mt-1 text-[11px] text-[var(--color-danger)]">{job.error}</div>}
          </div>
        )
      })}
    </section>
  )
}
