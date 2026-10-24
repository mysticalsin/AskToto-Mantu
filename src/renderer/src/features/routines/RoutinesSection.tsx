/**
 * Routines in Settings (G69, CAP-31): the list with each routine's status, pause reasons, last outcome and next run,
 * plus Pause or Resume, Run now and Delete. Status is always text, never colour alone, and waiting is never shown as a
 * failure. Refetches on main's push events and after each action.
 */
import { useCallback, useEffect, useState } from 'react'
import type { LIST_REFUSALS, MutationResult, RoutineView } from '@shared/routines'
import { useConfirm } from '../../ui/confirm-context'
import { RoutineEditor } from './RoutineEditor'
import { deleteWithConfirm, resumeWithReconcile, runNowWithConfirm, type RoutinesApi } from './routine-actions'
import {
  LIST_REFUSAL_COPY,
  MUTATION_REFUSAL_COPY,
  availabilityLine,
  lastOutcomeCopy,
  routineStatus,
  type RoutineStatus
} from './routine-copy'

export type RoutinesListState =
  | { kind: 'loading' }
  | { kind: 'refused'; reason: (typeof LIST_REFUSALS)[number] }
  | { kind: 'ready'; routines: RoutineView[] }

type RowHandler = (view: RoutineView) => void

const rowBtn =
  'no-drag cl-focus min-h-[28px] rounded-md px-2.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/10 disabled:opacity-40'

/** Tone is a neutral dot plus words; only the words carry meaning. Waiting and paused are never red. */
const TONE_DOT: Record<RoutineStatus['tone'], string> = {
  active: 'bg-[var(--cl-success)]',
  waiting: 'bg-[var(--cl-muted-foreground)]',
  paused: 'bg-[var(--cl-muted-foreground)]',
  done: 'bg-[var(--cl-border)]'
}

export function RoutineRow({
  view,
  now,
  busy,
  onPause,
  onResume,
  onRunNow,
  onDelete
}: {
  view: RoutineView
  now: number
  busy: boolean
  onPause: RowHandler
  onResume: RowHandler
  onRunNow: RowHandler
  onDelete: RowHandler
}): JSX.Element {
  const status = routineStatus(view, now)
  const last = lastOutcomeCopy(view.history[0], now)
  const paused = view.pauseReasons.length > 0
  const done = view.status === 'completed'
  return (
    <div
      role="listitem"
      className="flex flex-col gap-1 rounded-[var(--cl-radius)] border border-[var(--cl-border)] px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[status.tone]}`} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--cl-foreground)]">
          {view.title}
        </span>
      </div>
      <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">{view.copy}</div>
      <div className="text-[12px] text-[color:var(--cl-foreground)]">{status.primary}</div>
      {status.secondary && (
        <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">{status.secondary}</div>
      )}
      {last && <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">Last: {last}</div>}
      <div className="text-[11px] text-[color:var(--cl-muted-foreground)]">{availabilityLine(view)}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {!done &&
          (paused ? (
            <button
              type="button"
              className={rowBtn}
              disabled={busy}
              aria-label={`Resume ${view.title}`}
              onClick={() => onResume(view)}
            >
              Resume
            </button>
          ) : (
            <button
              type="button"
              className={rowBtn}
              disabled={busy}
              aria-label={`Pause ${view.title}`}
              onClick={() => onPause(view)}
            >
              Pause
            </button>
          ))}
        {!done && (
          <button
            type="button"
            className={rowBtn}
            disabled={busy || paused}
            aria-label={`Run ${view.title} now`}
            onClick={() => onRunNow(view)}
          >
            Run now
          </button>
        )}
        <button
          type="button"
          className={`${rowBtn} text-[color:var(--cl-destructive)]`}
          disabled={busy}
          aria-label={`Delete ${view.title}`}
          onClick={() => onDelete(view)}
        >
          Delete
        </button>
      </div>
    </div>
  )
}

export function RoutinesListView({
  state,
  now,
  busyId = null,
  onPause,
  onResume,
  onRunNow,
  onDelete
}: {
  state: RoutinesListState
  now: number
  busyId?: string | null
  onPause: RowHandler
  onResume: RowHandler
  onRunNow: RowHandler
  onDelete: RowHandler
}): JSX.Element {
  const muted = 'text-[12px] text-[color:var(--cl-muted-foreground)]'
  if (state.kind === 'loading') return <div className={muted}>Loading routines</div>
  if (state.kind === 'refused') return <div className={muted}>{LIST_REFUSAL_COPY[state.reason]}</div>
  if (state.routines.length === 0) return <div className={muted}>No routines yet.</div>
  return (
    <div role="list" aria-label="Routines" className="flex flex-col gap-2">
      {state.routines.map((view) => (
        <RoutineRow
          key={view.routineId}
          view={view}
          now={now}
          busy={busyId === view.routineId}
          onPause={onPause}
          onResume={onResume}
          onRunNow={onRunNow}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}

export function RoutinesSection(): JSX.Element {
  const api: RoutinesApi = window.toto.routines
  const confirm = useConfirm()
  const [state, setState] = useState<RoutinesListState>({ kind: 'loading' })
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async (): Promise<void> => {
    const result = await api.list()
    setNow(Date.now())
    setState(result.ok ? { kind: 'ready', routines: result.routines } : { kind: 'refused', reason: result.reason })
  }, [api])

  useEffect(() => {
    void refresh()
    const offChanged = api.onChanged(() => void refresh())
    const offResult = api.onResult(() => void refresh())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      offChanged()
      offResult()
      clearInterval(timer)
    }
  }, [api, refresh])

  const act = (view: RoutineView, run: () => Promise<MutationResult | null>): void => {
    setBusyId(view.routineId)
    setNotice('')
    void run()
      .then((result) => {
        if (result && !result.ok) setNotice(MUTATION_REFUSAL_COPY[result.reason])
      })
      .finally(() => {
        setBusyId(null)
        void refresh()
      })
  }

  return (
    <div className="flex flex-col gap-3">
      <RoutinesListView
        state={state}
        now={now}
        busyId={busyId}
        onPause={(view) => act(view, () => api.pause(view.routineId))}
        onResume={(view) => act(view, () => resumeWithReconcile(api, confirm, view))}
        onRunNow={(view) => act(view, () => runNowWithConfirm(api, confirm, view))}
        onDelete={(view) => act(view, () => deleteWithConfirm(api, confirm, view))}
      />
      <div role="status" aria-live="polite" className="text-[12px] text-[color:var(--cl-foreground)]">
        {notice}
      </div>
      {editing ? (
        <RoutineEditor
          api={api}
          onClose={() => setEditing(false)}
          onCreated={() => {
            setEditing(false)
            setNotice('Routine created.')
            void refresh()
          }}
        />
      ) : (
        state.kind === 'ready' && (
          <button
            type="button"
            className="no-drag cl-focus min-h-[28px] self-start rounded-md px-2.5 text-[12px] text-[color:var(--cl-primary)] hover:bg-white/10"
            onClick={() => setEditing(true)}
          >
            New routine
          </button>
        )
      )}
    </div>
  )
}
