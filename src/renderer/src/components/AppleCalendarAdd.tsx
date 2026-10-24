import { useEffect, useState } from 'react'
import {
  appleCalendarPermissionCopy,
  type AppleCalendarCreateRequest,
  type AppleCalendarStatus
} from '@shared/apple-calendar'
import { TextButton } from './ui'

const DURATIONS = [15, 30, 60] as const

/** A `datetime-local` value is local wall time; the event goes to main as UTC ISO so the readback compares instants. */
export function buildAppleEvent(
  title: string,
  startLocal: string,
  durationMinutes: number
): AppleCalendarCreateRequest | null {
  const start = new Date(startLocal)
  if (!startLocal || Number.isNaN(start.getTime()) || !(durationMinutes > 0)) return null
  const end = new Date(start.getTime() + durationMinutes * 60_000)
  return { subject: title.trim().slice(0, 200), startIso: start.toISOString(), endIso: end.toISOString() }
}

export interface AppleCalendarAddViewProps {
  status: AppleCalendarStatus
  startLocal: string
  durationMinutes: number
  busy: boolean
  message: string | null
  onStartChange(value: string): void
  onDurationChange(value: number): void
  onAllowAccess(): void
  onAdd(): void
}

/** Presentational half: nothing here can reach the OS. Hidden unless EventKit is available on this Mac. */
export function AppleCalendarAddView(props: AppleCalendarAddViewProps): React.JSX.Element | null {
  const { status } = props
  if (!status.available || !status.permission) return null
  const permission = status.permission
  const needsAccess = permission !== 'fullAccess' && permission !== 'notDetermined'
  return (
    <div className="flex flex-col gap-1.5" data-testid="apple-calendar-add">
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[color:var(--color-ink-2)]">
        <input
          type="datetime-local"
          aria-label="Event start"
          value={props.startLocal}
          onChange={(e) => props.onStartChange(e.target.value)}
          className="rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.02] px-2 py-1 text-[12px] focus:outline-none"
        />
        <select
          aria-label="Event length"
          value={props.durationMinutes}
          onChange={(e) => props.onDurationChange(Number(e.target.value))}
          className="rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.02] px-2 py-1 text-[12px] focus:outline-none"
        >
          {DURATIONS.map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>
        {permission === 'notDetermined' ? (
          <TextButton onClick={props.onAllowAccess} disabled={props.busy}>
            Allow Calendar access
          </TextButton>
        ) : null}
        <TextButton onClick={props.onAdd} disabled={props.busy || !props.startLocal || needsAccess}>
          {props.busy ? 'Adding…' : 'Add to Apple Calendar'}
        </TextButton>
      </div>
      {needsAccess ? (
        <div className="text-[11px] text-[var(--color-danger)]">{appleCalendarPermissionCopy(permission)}</div>
      ) : null}
      {props.message ? <div className="text-[11px] text-[color:var(--color-ink-2)]">{props.message}</div> : null}
      <div className="text-[11px] text-[color:var(--color-ink-3)]">
        No invitations are sent. You confirm before anything is saved.
      </div>
    </div>
  )
}

/** "Add to calendar" for Apple Calendar (G65c). The write itself always waits for the connector confirm card in main. */
export function AppleCalendarAdd({ title }: { title: string }): React.JSX.Element | null {
  const [status, setStatus] = useState<AppleCalendarStatus>({ available: false })
  const [startLocal, setStartLocal] = useState('')
  const [durationMinutes, setDurationMinutes] = useState<number>(30)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.toto?.appleCalendar
      ?.status()
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const allowAccess = (): void => {
    setBusy(true)
    setMessage(null)
    void window.toto.appleCalendar
      .requestAccess()
      .then(setStatus)
      .finally(() => setBusy(false))
  }
  const add = (): void => {
    const event = buildAppleEvent(title, startLocal, durationMinutes)
    if (!event) {
      setMessage('Choose a start time first.')
      return
    }
    setBusy(true)
    setMessage(null)
    void window.toto.appleCalendar
      .create(event)
      .then((r) => {
        if (r.ok) setMessage('Added to Apple Calendar.')
        else setMessage(r.error ?? 'Apple Calendar did not save the event.')
        // A refusal can change what the OS now allows; read it again, without prompting.
        if (r.permission) void window.toto.appleCalendar.status().then(setStatus)
      })
      .finally(() => setBusy(false))
  }

  return (
    <AppleCalendarAddView
      status={status}
      startLocal={startLocal}
      durationMinutes={durationMinutes}
      busy={busy}
      message={message}
      onStartChange={setStartLocal}
      onDurationChange={setDurationMinutes}
      onAllowAccess={allowAccess}
      onAdd={add}
    />
  )
}
