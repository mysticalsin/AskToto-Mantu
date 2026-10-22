import { AlertCircle, Check, Send } from 'lucide-react'
import type { CrmPayload } from '../../lib/review-push-memory'
import { Chip, TextButton } from '../ui'
import { InlineOrb } from '../AgentStatus'
import type { ClickupPush } from './useClickupPush'

/** The "Push to ClickUp" panel: create one task from the recap, after the person reviewed the exact payload. */
export function ReviewClickupSection({
  push,
  payload,
  confidentialFlag
}: {
  push: ClickupPush
  payload: CrmPayload
  confidentialFlag: boolean
}): JSX.Element {
  const { open, setOpen, state, setState, destName, resolving, pushed, ensureDest, send } = push
  return (
    <section aria-live="polite">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
          <Send size={12} /> ClickUp
        </div>
        {!open && !pushed && !confidentialFlag && (
          <Chip
            onClick={() => {
              setOpen(true)
              void ensureDest()
            }}
            variant="accent"
          >
            <Send size={13} /> Push to ClickUp
          </Chip>
        )}
        {confidentialFlag && (
          <span className="text-[11px] text-[color:var(--color-ink-3)]">ClickUp push blocked (confidential)</span>
        )}
      </div>

      {pushed ? (
        <div className="flex flex-col gap-1 text-[13px] text-[var(--color-success)]">
          <div className="flex items-center gap-1.5">
            <Check size={13} /> Created in {state.destinationName || destName || 'ClickUp'}.
          </div>
          {state.taskUrl ? (
            <a
              href={state.taskUrl}
              className="text-[11px] text-[color:var(--color-ink-2)] underline"
              target="_blank"
              rel="noreferrer"
            >
              {state.taskUrl}
            </a>
          ) : null}
        </div>
      ) : open ? (
        <div className="flex flex-col gap-2">
          <div className="text-[12px] text-[color:var(--color-ink-2)]">
            {resolving
              ? 'Finding the ClickUp list…'
              : destName
                ? `Task in ${destName}`
                : 'ClickUp could not name the destination.'}
          </div>
          <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3 text-[12px]">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              Payload preview
            </div>
            <div className="flex flex-col gap-1 text-[color:var(--color-ink-2)]">
              <div>
                <span className="text-[color:var(--color-ink-3)]">Name: </span>
                {payload.title}
              </div>
              <div className="text-[color:var(--color-ink-3)]">Description:</div>
              <div className="scroll-thin max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/[0.03] p-2 text-[color:var(--color-ink)]">
                {payload.summary || '(empty)'}
              </div>
            </div>
          </div>
          {state.phase === 'error' && state.error && (
            <div role="alert" className="flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>{state.error}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            {destName && !resolving ? (
              <Chip onClick={() => void send()} variant="accent" disabled={state.phase === 'sending'}>
                {state.phase === 'sending' ? <InlineOrb kind="connecting" /> : <Send size={13} />}
                {state.phase === 'sending' ? 'Pushing…' : state.error ? 'Try Again' : 'Confirm push'}
              </Chip>
            ) : null}
            <TextButton
              onClick={() => {
                setOpen(false)
                setState({ phase: 'idle', error: null })
              }}
              disabled={state.phase === 'sending'}
            >
              Cancel
            </TextButton>
          </div>
        </div>
      ) : null}
    </section>
  )
}
