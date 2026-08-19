import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatResetPhrase } from './reset-time'

/**
 * MQA-203 — a usage cap that resets days away was rendered as a bare clock time on both surfaces
 * (Settings → Backups & limits, and the failed-ask message), so a WEEKLY cap read as "later today": the
 * user retried at 9:14 AM and got the same wall, every morning, for a week. Multi-day cooldowns are a
 * designed state — exhaustion.ts parses "resets in 164h27m24s" (~6.8 d) and provider-health clamps at 8 d.
 */
const clock = (y: number, m: number, d: number, h: number, min: number): number =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime()

const timeOf = (t: number): string =>
  new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

describe('formatResetPhrase (MQA-203)', () => {
  const now = clock(2026, 8, 17, 9, 14) // a Monday morning

  it('keeps the bare clock time when the reset really is later today (MQA-203)', () => {
    const until = clock(2026, 8, 17, 15, 40)
    expect(formatResetPhrase(until, now)).toBe(`resets ~${timeOf(until)}`)
  })

  it('names tomorrow for the 24h default a weekly cap falls back to (MQA-203)', () => {
    // exhaustion.ts defaults a stated-window-less weekly cap to 24h, which used to render as the exact
    // clock time it currently is — "resets ~9:14 AM", shown at 9:14 AM.
    const until = now + 24 * 60 * 60 * 1000
    const phrase = formatResetPhrase(until, now)
    expect(phrase).toContain('tomorrow')
    expect(phrase).not.toBe(`resets ~${timeOf(until)}`)
  })

  it('names the distance in days for a weekly cap ~7 days out (MQA-203)', () => {
    const until = now + (164 * 60 + 27) * 60 * 1000 // the CLI's own "resets in 164h27m24s"
    const phrase = formatResetPhrase(until, now)
    expect(phrase).toContain('in 7 days')
    expect(phrase).not.toContain(timeOf(until))
  })

  it('stays unambiguous at the 8-day cooldown ceiling, where a weekday alone would collide (MQA-203)', () => {
    // provider-health.ts clamps at 8 days: "resets ~Mon 9:14 AM" while today is Monday is exactly the
    // ambiguity this phrasing exists to remove.
    const phrase = formatResetPhrase(now + 8 * 24 * 60 * 60 * 1000, now)
    expect(phrase).toContain('in 8 days')
    expect(phrase).toContain(
      new Date(now + 8 * 24 * 60 * 60 * 1000).toLocaleDateString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      })
    )
  })

  it('does not go negative when the cooldown has already lapsed (MQA-203)', () => {
    expect(formatResetPhrase(now - 60_000, now)).toBe(`resets ~${timeOf(now - 60_000)}`)
  })
})

const settingsSrc = readFileSync(
  join(__dirname, '..', 'renderer', 'src', 'components', 'Settings.tsx'),
  'utf8'
)
const mainSrc = readFileSync(join(__dirname, '..', 'main', 'index.ts'), 'utf8')

describe('both reset surfaces use the day-aware phrasing (MQA-203)', () => {
  it("Settings' provider-limit row does not print a bare clock time (MQA-203)", () => {
    const label = settingsSrc.slice(
      settingsSrc.indexOf('function providerLimitLabel'),
      settingsSrc.indexOf('function providerLimitLabel') + 900
    )
    expect(label).toContain('formatResetPhrase(u.until)')
    expect(label).not.toContain('toLocaleTimeString')
  })

  it('the failed-ask message does not print a bare clock time either (MQA-203)', () => {
    const msg = mainSrc.slice(mainSrc.indexOf('hit its usage limit'), mainSrc.indexOf('hit its usage limit') + 400)
    expect(msg).toContain('formatResetPhrase(exhaustion.resetAt)')
    expect(msg).not.toContain('toLocaleTimeString')
  })
})
