import type { ImportAssetsProgress, ImportCapabilityState, ImportJobView, ImportPolicyState } from '@shared/ipc'
import { Upload } from 'lucide-react'
import { ImportQueue } from './ImportQueue'
import { TextButton } from './ui'

export function ImportActionButton({
  disabled,
  title,
  onClick
}: {
  disabled: boolean
  title: string
  onClick: () => void
}): JSX.Element {
  return (
    <TextButton icon={Upload} onClick={onClick} disabled={disabled} title={title}>
      Import meetings
    </TextButton>
  )
}

export function ImportQueueSection({
  jobs,
  policyState,
  capabilityState,
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
  policyState: ImportPolicyState
  capabilityState: ImportCapabilityState
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
  const actionsBlocked = policyState !== 'allowed' || capabilityState !== 'available'
  return (
    <>
      {policyState === 'unavailable' && (
        <p role="status" className="mt-2 text-[11px] text-[color:var(--color-ink-2)]">
          Import is paused because current organization settings could not be verified. Existing recordings are
          unchanged.
        </p>
      )}
      {policyState === 'summary-only' && (
        <p role="status" className="mt-2 text-[11px] text-[color:var(--color-ink-2)]">
          Recording import currently requires retaining a full transcript. Your organization’s summary-only policy
          prevents import. Your original recording is unchanged.
        </p>
      )}
      {policyState === 'allowed' && capabilityState === 'cloud-only-unsupported' && (
        <p role="status" className="mt-2 text-[11px] text-[color:var(--color-ink-2)]">
          Recording import is unavailable because this installation does not support its configured cloud-only speech
          route. Existing recordings are unchanged.
        </p>
      )}
      {policyState === 'allowed' && capabilityState === 'unavailable' && (
        <p role="status" className="mt-2 text-[11px] text-[color:var(--color-ink-2)]">
          Import is paused because the available speech capability could not be verified. Existing recordings are
          unchanged.
        </p>
      )}
      {!actionsBlocked && (policyHeldJobIds.length > 0 || policyHoldOverflow) && (
        <p role="status" className="mt-2 text-[11px] text-[color:var(--color-ink-2)]">
          Saved imports paused while your organization’s summary-only policy was active. Resume a listed import after
          your organization restores permission. Your original recordings are unchanged.
        </p>
      )}
      {!actionsBlocked &&
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
        resumeDisabled={actionsBlocked}
        onDismiss={onDismiss}
        onOpenMeeting={onOpenMeeting}
      />
    </>
  )
}
