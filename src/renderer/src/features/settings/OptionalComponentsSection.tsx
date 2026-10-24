import { useCallback, useEffect, useRef, useState } from 'react'
import { NON_REMOVABLE_COMPONENTS, matrixRowFor, type DegradeTarget } from '@shared/component-failure-matrix'
import type {
  OffloadConfirmResult,
  OffloadPlan,
  OffloadPreviewResult,
  OffloadReceipt,
  OffloadRefusalReason
} from '@shared/component-offload'
import type { OptionalComponentId, OptionalComponentStatus, SpeechPackSnapshot } from '@shared/speech-pack'

export type OptionalComponentsBridge = {
  speechPackState: () => Promise<SpeechPackSnapshot>
  componentOffloadPreview: (componentId: OptionalComponentId) => Promise<OffloadPreviewResult>
  componentOffloadConfirm: (planId: string) => Promise<OffloadConfirmResult>
  componentOffloadReceipts: () => Promise<OffloadReceipt[]>
}

export function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${Math.ceil(mb)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`
}

const PRESENCE_LABEL: Record<OptionalComponentStatus['presence'], string> = {
  bundled: 'Ships inside this app',
  installed: 'Installed',
  'model-only': 'Model installed, runtime missing',
  absent: 'Not downloaded'
}

const DEGRADE_LABEL: Record<DegradeTarget, string> = {
  'cloud-speech': 'Cloud speech or Apple Speech',
  'other-local-speech': 'The other offline speech engine',
  'cloud-llm': 'Cloud suggestions',
  'feature-off': 'This feature turns off'
}

const REFUSAL_COPY: Record<OffloadRefusalReason, string> = {
  'not-removable': 'This component cannot be removed.',
  bundled: 'This component ships inside the app and cannot be removed.',
  absent: 'There is nothing to remove.',
  busy: 'A download or check is running. Try again when it finishes.',
  'capture-active': 'A meeting is being captured. Remove components after it ends.',
  'plan-expired': 'That confirmation expired. Choose Remove again.',
  'stale-plan': 'This component changed. Choose Remove again.',
  'invalid-request': 'That request could not be understood.',
  failed: 'Removal did not complete. Nothing else was touched.'
}

export type OptionalComponentsViewProps = {
  components: readonly OptionalComponentStatus[]
  plan: OffloadPlan | null
  receipt: OffloadReceipt | null
  receipts: readonly OffloadReceipt[]
  message: string | null
  busy: boolean
  onRemove: (id: OptionalComponentId) => void
  onConfirm: () => void
  onKeep: () => void
}

function ReceiptCard({ receipt }: { receipt: OffloadReceipt }): JSX.Element {
  return (
    <div
      role="status"
      aria-label="Removal receipt"
      className="mt-2 rounded-lg border border-[var(--cl-border)] bg-white/[0.03] p-2.5 text-[11px]"
    >
      <p className="m-0 font-medium text-[color:var(--cl-foreground)]">Removed {receipt.label}</p>
      <p className="mt-1 text-[color:var(--cl-muted-foreground)]">Freed {formatBytes(receipt.bytesFreed)} (measured)</p>
      {receipt.freeBytesBefore !== null && receipt.freeBytesAfter !== null && (
        <p className="text-[color:var(--cl-muted-foreground)]">
          Free disk space: {formatBytes(receipt.freeBytesBefore)} before, {formatBytes(receipt.freeBytesAfter)} after
        </p>
      )}
      <p className="text-[color:var(--cl-muted-foreground)]">
        {receipt.verifiedAbsent ? 'Files confirmed gone.' : 'Could not confirm the files are gone.'} Your meetings and
        notes were not touched.
      </p>
    </div>
  )
}

/** Keys on the destructive confirm card: Escape keeps the component; no key ever confirms. */
export function optionalConfirmKey(key: string): 'keep' | null {
  return key === 'Escape' ? 'keep' : null
}

/** Presentational: one row per optional component with size, provider, privacy, failure and a two-step Remove. */
export function OptionalComponentsView(props: OptionalComponentsViewProps): JSX.Element {
  const { components, plan, receipt, receipts, message, busy } = props
  // When the confirm card closes, focus goes back to that row's Remove button instead of the page body.
  const removeButtons = useRef(new Map<string, HTMLButtonElement>())
  const lastPlanned = useRef<string | null>(null)
  useEffect(() => {
    if (plan) lastPlanned.current = plan.componentId
    else if (lastPlanned.current) {
      removeButtons.current.get(lastPlanned.current)?.focus()
      lastPlanned.current = null
    }
  }, [plan])
  return (
    <section
      aria-label="Optional on-device components"
      className="rounded-xl border border-[var(--cl-border)] bg-white/[0.02] p-3"
    >
      <h3 className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Optional components</h3>
      <p className="mt-1 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
        What each one is, who supplies it, what it costs on disk and what keeps working without it. Removing one frees
        its space and never touches your meetings or notes.
      </p>
      {message && (
        <p role="alert" className="mt-2 text-[11px] text-amber-300">
          {message}
        </p>
      )}
      <ul className="mt-2 flex flex-col gap-2 p-0" style={{ listStyle: 'none' }}>
        {components.map((item) => {
          const failure = item.failure ? matrixRowFor(item.id, item.failure) : null
          const planned = plan?.componentId === item.id ? plan : null
          const rowReceipt = receipt?.componentId === item.id ? receipt : null
          return (
            <li key={item.id} data-component={item.id} className="rounded-lg border border-[var(--cl-border)] p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <span className="font-medium text-[color:var(--cl-foreground)]">{item.label}</span>
                <span className="text-[11px]">{PRESENCE_LABEL[item.presence]}</span>
              </div>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--cl-muted-foreground)]">
                <dt>Provider</dt>
                <dd className="m-0">{item.provider}</dd>
                <dt>Source</dt>
                <dd className="m-0">{item.sourceHost}</dd>
                <dt>Size</dt>
                <dd className="m-0">
                  {formatBytes(item.downloadBytes)} download · {formatBytes(item.installedBytes)} on disk
                </dd>
                <dt>Privacy</dt>
                <dd className="m-0">{item.privacyNote}</dd>
              </dl>
              {failure && (
                <div role="status" data-failure={failure.mode} className="mt-1.5 text-[11px] text-amber-300">
                  <p className="m-0">{failure.copy}</p>
                  <p className="m-0 text-[color:var(--cl-muted-foreground)]">
                    Falls back to: {DEGRADE_LABEL[failure.degradesTo]}
                  </p>
                </div>
              )}
              {item.presence === 'bundled' && (
                <p className="mt-1.5 text-[10px] text-[color:var(--cl-muted-foreground)]">
                  This ships inside the app and cannot be removed here.
                </p>
              )}
              {item.removable && !planned && (
                <button
                  type="button"
                  ref={(el) => {
                    if (el) removeButtons.current.set(item.id, el)
                    else removeButtons.current.delete(item.id)
                  }}
                  disabled={busy}
                  onClick={() => props.onRemove(item.id)}
                  className="focus-ring mt-2 rounded border px-2 py-1 text-[11px] disabled:opacity-50"
                >
                  Remove {item.label}
                </button>
              )}
              {planned && (
                <div
                  role="group"
                  aria-label="Confirm removal"
                  onKeyDown={(e) => {
                    if (optionalConfirmKey(e.key) !== 'keep') return
                    e.preventDefault()
                    e.stopPropagation()
                    props.onKeep()
                  }}
                  className="mt-2 rounded-lg border border-[var(--cl-border)] bg-white/[0.03] p-2.5 text-[11px]"
                >
                  <p className="m-0 font-medium text-[color:var(--cl-foreground)]">Remove {planned.label}?</p>
                  <p className="mt-1 text-[color:var(--cl-muted-foreground)]">
                    This frees about {formatBytes(planned.removableBytes)}. Afterwards:{' '}
                    {DEGRADE_LABEL[planned.degradesTo]}. Your meetings and notes are not touched. You can download it
                    again later.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={props.onConfirm}
                      aria-label={`Confirm remove ${planned.label}`}
                      className="focus-ring rounded border px-2 py-1 disabled:opacity-50"
                    >
                      Confirm remove
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      autoFocus
                      onClick={props.onKeep}
                      className="focus-ring rounded border px-2 py-1 disabled:opacity-50"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              )}
              {rowReceipt && <ReceiptCard receipt={rowReceipt} />}
            </li>
          )
        })}
      </ul>
      <h4 className="mt-3 text-[12px] font-medium text-[color:var(--cl-foreground)]">Also on this device</h4>
      <ul className="mt-1 flex flex-col gap-1.5 p-0 text-[11px]" style={{ listStyle: 'none' }}>
        {NON_REMOVABLE_COMPONENTS.map((item) => (
          <li key={item.id} data-component={item.id} className="text-[color:var(--cl-muted-foreground)]">
            <span className="font-medium text-[color:var(--cl-foreground)]">{item.label}</span> · {item.provider}.{' '}
            {item.privacyNote} Not removable.
            {item.failures.map((failure) => (
              <span key={failure.seam}> If it fails: {failure.stillWorks}</span>
            ))}
          </li>
        ))}
      </ul>
      {receipts.length > 0 && (
        <details className="mt-3 text-[11px]">
          <summary className="cursor-pointer">Removal history ({receipts.length})</summary>
          <ul className="mt-1 p-0" style={{ listStyle: 'none' }}>
            {receipts.map((entry) => (
              <li key={entry.receiptId} className="text-[color:var(--cl-muted-foreground)]">
                {entry.label} · freed {formatBytes(entry.bytesFreed)} · {entry.removedAt.slice(0, 10)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

/** Stateful host: reads the speech-pack snapshot, runs preview then confirm, and shows the measured receipt. */
export function OptionalComponentsSection({ bridge }: { bridge: OptionalComponentsBridge }): JSX.Element | null {
  const [components, setComponents] = useState<readonly OptionalComponentStatus[] | null>(null)
  const [plan, setPlan] = useState<OffloadPlan | null>(null)
  const [receipt, setReceipt] = useState<OffloadReceipt | null>(null)
  const [receipts, setReceipts] = useState<readonly OffloadReceipt[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    const [snapshot, history] = await Promise.all([
      bridge.speechPackState().catch(() => null),
      bridge.componentOffloadReceipts().catch(() => [] as OffloadReceipt[])
    ])
    if (!mounted.current) return
    if (snapshot) setComponents(snapshot.optionalComponents ?? [])
    setReceipts(history)
  }, [bridge])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh])

  const onRemove = async (id: OptionalComponentId): Promise<void> => {
    setBusy(true)
    setMessage(null)
    setReceipt(null)
    setPlan(null)
    try {
      const result = await bridge.componentOffloadPreview(id)
      if (!mounted.current) return
      if (result.ok) setPlan(result.plan)
      else setMessage(REFUSAL_COPY[result.reason])
    } catch {
      if (mounted.current) setMessage('Could not prepare the removal.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const onConfirm = async (): Promise<void> => {
    if (!plan) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await bridge.componentOffloadConfirm(plan.planId)
      if (!mounted.current) return
      setPlan(null)
      if (result.ok) setReceipt(result.receipt)
      else setMessage(REFUSAL_COPY[result.reason])
      await refresh()
    } catch {
      if (mounted.current) {
        setPlan(null)
        setMessage('Could not complete the removal.')
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (components === null) return null
  return (
    <OptionalComponentsView
      components={components}
      plan={plan}
      receipt={receipt}
      receipts={receipts}
      message={message}
      busy={busy}
      onRemove={(id) => void onRemove(id)}
      onConfirm={() => void onConfirm()}
      onKeep={() => setPlan(null)}
    />
  )
}
