import { useCallback, useEffect, useState } from 'react'
import { Calendar, RefreshCw } from 'lucide-react'
import { InlineOrb } from './AgentStatus'
import type { CalendarEvent, CalendarTodayResult } from '@shared/ipc'

// ---------------------------------------------------------------------------
// History's upcoming calendar section (moved unchanged out of RecallView.tsx)
// ---------------------------------------------------------------------------

/** Format a calendar event start/end time for the upcoming row. */
function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function CompactEventRow({ ev }: { ev: CalendarEvent }): JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.06]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-[color:var(--color-ink)]">
          {ev.subject}
        </div>
        {ev.location && (
          <div className="truncate text-[10px] text-[color:var(--color-ink-3)]">
            {ev.location}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right text-[11px] tabular-nums text-[color:var(--color-ink-3)]">
        {ev.allDay ? 'All day' : fmtTime(ev.start)}
      </div>
    </div>
  )
}

export function UpcomingSection({
  onConnectCalendar
}: {
  onConnectCalendar?: () => void
}): JSX.Element {
  const [res, setRes] = useState<CalendarTodayResult | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    try {
      setRes(await window.toto.calendarToday(tz))
    } catch {
      setRes({ ok: false, error: 'Calendar unavailable.' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const showConnect = !loading && (!res?.ok || res?.needsConsent)
  const events = res?.ok && res.events ? res.events.slice(0, 3) : []

  return (
    <div className="mb-1.5">
      <div className="mb-1 flex items-center justify-between px-1">
        <div className="cl-eyebrow flex items-center gap-1.5 text-[color:var(--color-ink-3)]">
          {loading ? <InlineOrb kind="searching" /> : <RefreshCw size={10} />}
          Upcoming
        </div>
        {!loading && res?.ok && (
          <button
            type="button"
            onClick={() => void load()}
            aria-label="Refresh calendar"
            className="no-drag focus-ring grid h-5 w-5 place-items-center rounded-full text-[color:var(--color-ink-3)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
          >
            <RefreshCw size={9} />
          </button>
        )}
      </div>
      {showConnect ? (
        <button
          type="button"
          onClick={onConnectCalendar}
          className="no-drag focus-ring flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06]"
        >
          <Calendar size={13} className="shrink-0 text-[color:var(--color-ink-3)]" />
          <span className="text-[12px] text-[color:var(--color-ink-2)]">Connect your calendar</span>
        </button>
      ) : events.length === 0 && !loading ? (
        <div className="px-2 py-1 text-[12px] text-[color:var(--color-ink-3)]">
          No upcoming events today.
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {events.map((ev, i) => (
            <CompactEventRow key={i} ev={ev} />
          ))}
        </div>
      )}
    </div>
  )
}
