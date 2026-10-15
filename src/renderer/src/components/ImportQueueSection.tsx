import type { ImportAssetsProgress, ImportJobView } from '@shared/ipc'
import { ImportQueue } from './ImportQueue'

export function ImportQueueSection({
  jobs,
  policyBlocked,
  policyHeldJobIds,
  inventoryOverflow,
  policyHoldOverflow,
  error,
  assets,
  dragOver,
  onCancel,
  onResume,
  onDismiss,
  onOpenMeeting
}: {
  jobs: ImportJobView[]
  policyBlocked: boolean
  policyHeldJobIds: string[]
  inventoryOverflow: boolean
  policyHoldOverflow: boolean
  error: string | null
  assets: ImportAssetsProgress | null
  dragOver: boolean
  onCancel: (jobId: string) => void
  onResume: (jobId: string) => void
  onDismiss: (jobId: string) => void
  onOpenMeeting: (file: string) => void
}): JSX.Element {
  return (
    <>
      {policyBlocked && (
        <p role="status" className="mt-2 text-[11px] text-[color:var(--color-ink-2)]">
          Recording import currently requires retaining a full transcript. Your organization’s summary-only policy
          prevents import. Your original recording is unchanged.
        </p>
      )}
      {!policyBlocked && (policyHeldJobIds.length > 0 || policyHoldOverflow) && (
        <p role="status" className="mt-2 text-[11px] text-[color:var(--color-ink-2)]">
          Saved imports paused while your organization’s summary-only policy was active. Resume a listed import after
          your organization restores permission. Your original recordings are unchanged.
        </p>
      )}
      {!policyBlocked &&
        policyHeldJobIds.length === 0 &&
        !policyHoldOverflow &&
        (inventoryOverflow || jobs.some((job) => job.state === 'policy-held')) && (
          <p role="status" className="mt-2 text-[11px] text-[color:var(--color-ink-2)]">
            Saved imports are paused after the app restarted. Choose Resume to continue. Your original recordings are
            unchanged.
          </p>
        )}
      <ImportQueue
        jobs={jobs}
        assets={assets}
        dragOver={dragOver}
        error={error}
        onCancel={onCancel}
        onResume={onResume}
        resumeDisabled={policyBlocked}
        onDismiss={onDismiss}
        onOpenMeeting={onOpenMeeting}
      />
    </>
  )
}
