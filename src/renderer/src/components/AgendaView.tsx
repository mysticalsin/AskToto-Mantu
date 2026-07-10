import { useCallback, useEffect, useState } from 'react'
import { Calendar, Video, RefreshCw, ExternalLink, Users } from 'lucide-react'
import type { CalendarEvent, CalendarTodayResult } from '@shared/ipc'
import { Spinner } from './ui'

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function EventRow({ ev }: { ev: CalendarEvent }): JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2.5">
      <div className="w-[64px] shrink-0 pt-0.5 text-right">
        <div className="whitespace-nowrap text-[12px] font-medium tabular-nums text-[color:var(--color-ink)]">
          {ev.allDay ? 'All day' : fmtTime(ev.start)}
        </div>
        {!ev.allDay && (
          <div className="whitespace-nowrap text-[10px] tabular-nums text-[color:var(--color-ink-3)]">{fmtTime(ev.end)}</div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-[color:var(--color-ink)]">{ev.subject}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-[color:var(--color-ink-2)]">
          {ev.location && <span title={ev.location} className="min-w-0 max-w-[180px] truncate">{ev.location}</span>}
          {ev.attendees > 0 && (
            <span className="inline-flex items-center gap-1">
              <Users size={11} /> {ev.attendees}
            </span>
          )}
          {ev.online && ev.joinUrl && (
            <a
              href={ev.joinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="no-drag inline-flex items-center gap-1 text-[color:var(--color-accent)] hover:underline"
            >
              <Video size={11} /> Join <ExternalLink size={9} />
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

/** Today's Outlook / Microsoft 365 agenda. Pulls on mount; offers a one-click connect when not yet
 *  consented; degrades gracefully when SSO isn't configured or the calendar is unreachable. */
export function AgendaView(): JSX.Element {
  const [loading, setLoading] = useState(true)
  const [res, setRes] = useState<CalendarTodayResult | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [notConfigured, setNotConfigured] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setNotConfigured(false)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    try {
      setRes(await window.toto.calendarToday(tz))
    } catch {
      setRes({ ok: false, error: 'Calendar unavailable. Try again.' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const connect = useCallback(async (): Promise<void> => {
    setConnecting(true)
    try {
      const r = await window.toto.signIn()
      if (r.configured === false) {
        setNotConfigured(true)
        return
      }
      if (r.ok) {
        await load()
      } else {
        setRes({ ok: false, error: r.error || 'Sign-in failed.' })
      }
    } catch {
      /* ignore */
    } finally {
      setConnecting(false)
    }
  }, [load])

  const header = (
    <div className="mb-2 flex items-center justify-between px-0.5">
      <div className="flex items-center gap-2 text-[color:var(--color-ink)]">
        <Calendar size={15} className="text-[color:var(--color-accent)]" />
        <span className="text-[13px] font-semibold">Today’s agenda</span>
      </div>
      <button
        type="button"
        onClick={() => void load()}
        aria-label="Refresh agenda"
        title="Refresh"
        className="no-drag focus-ring grid h-7 w-7 place-items-center rounded-full text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
      >
        <RefreshCw size={13} />
      </button>
    </div>
  )

  let body: JSX.Element
  if (loading) {
    body = (
      <div className="flex items-center gap-2 px-1 py-6 text-[12px] text-[color:var(--color-ink-2)]">
        <Spinner size={13} /> Loading agenda…
      </div>
    )
  } else if (res?.ok && res.events && res.events.length > 0) {
    body = (
      <div className="flex flex-col gap-1.5">
        {res.events.map((ev, i) => (
          <EventRow key={i} ev={ev} />
        ))}
      </div>
    )
  } else if (res?.ok) {
    body = <div className="px-1 py-6 text-center text-[12px] text-[color:var(--color-ink-2)]">No meetings today.</div>
  } else if (notConfigured) {
    body = (
      <div className="px-1 py-5 text-[12px] leading-relaxed text-[color:var(--color-ink-2)]">
        This needs your org’s Microsoft sign-in configured first (Azure AD client &amp; tenant).
        Ask your IT admin to turn it on, then connect here.
      </div>
    )
  } else if (res?.needsConsent) {
    body = (
      <div className="flex flex-col items-center gap-3 px-1 py-5 text-center">
        <p className="text-[12px] leading-relaxed text-[color:var(--color-ink-2)]">
          Connect your Outlook calendar to see today’s meetings. Read-only: Métis never changes your calendar.
        </p>
        <button
          type="button"
          disabled={connecting}
          onClick={() => void connect()}
          className="no-drag focus-ring inline-flex items-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {connecting ? <Spinner size={13} /> : <Calendar size={14} />} Connect Outlook calendar
        </button>
      </div>
    )
  } else {
    body = (
      <div className="flex flex-col items-center gap-3 px-1 py-5 text-center">
        <p className="text-[12px] text-[color:var(--color-danger)]">{res?.error || 'Calendar unavailable.'}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="no-drag focus-ring inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-ink)] hover:bg-white/10"
        >
          <RefreshCw size={13} /> Try again
        </button>
      </div>
    )
  }

  return (
    // No height cap or inner scroll here: this view renders inside Settings' Calendar tab, whose
    // tabpanel (main.cl-content, 480px cap) is the ONE scroll container. A taller nested scroll box
    // trapped the wheel and clipped the bottom of the section — the classic nested-scroll trap.
    <div className="no-drag">
      {header}
      {body}
    </div>
  )
}
