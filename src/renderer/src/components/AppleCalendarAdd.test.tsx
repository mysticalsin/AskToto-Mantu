import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AppleCalendarStatus } from '@shared/apple-calendar'
import { AppleCalendarAddView, buildAppleEvent, type AppleCalendarAddViewProps } from './AppleCalendarAdd'

function view(status: AppleCalendarStatus, over: Partial<AppleCalendarAddViewProps> = {}): string {
  return renderToStaticMarkup(
    <AppleCalendarAddView
      status={status}
      startLocal="2026-10-25T10:00"
      durationMinutes={30}
      busy={false}
      message={null}
      onStartChange={vi.fn()}
      onDurationChange={vi.fn()}
      onAllowAccess={vi.fn()}
      onAdd={vi.fn()}
      {...over}
    />
  )
}

describe('AppleCalendarAdd (G65c)', () => {
  it('renders nothing when EventKit is not available on this Mac', () => {
    expect(view({ available: false })).toBe('')
    expect(view({ available: true })).toBe('')
  })

  it('offers Add with the no-invitations line when access is full', () => {
    const html = view({ available: true, permission: 'fullAccess' })
    expect(html).toContain('Add to Apple Calendar')
    expect(html).toContain('No invitations are sent.')
    expect(html).not.toContain('Allow Calendar access')
  })

  it('offers an explicit Allow button, and never prompts by itself, while the system has not asked', () => {
    const html = view({ available: true, permission: 'notDetermined' })
    expect(html).toContain('Allow Calendar access')
  })

  it.each([
    'denied',
    'restricted',
    'writeOnly'
  ] as const)('%s shows the typed permission copy and disables Add', (p) => {
    const html = view({ available: true, permission: p })
    expect(html).toContain('System Settings')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:<[^>]*>)*Add to Apple Calendar/)
    expect(html).not.toContain('Allow Calendar access')
  })

  it('builds UTC ISO times from the local start and refuses an empty or invalid start', () => {
    const e = buildAppleEvent(' Follow-up: Sync ', '2026-10-25T10:00', 30)
    expect(e?.subject).toBe('Follow-up: Sync')
    expect(Date.parse(e?.endIso ?? '') - Date.parse(e?.startIso ?? '')).toBe(30 * 60_000)
    expect(buildAppleEvent('x', '', 30)).toBeNull()
    expect(buildAppleEvent('x', 'not a date', 30)).toBeNull()
  })
})
