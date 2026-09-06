import { describe, expect, it } from 'vitest'
import {
  avatar,
  clientChip,
  deltaChip,
  emptyState,
  flag,
  formatCompact,
  kindBadge,
  osChip,
  osGlyph,
  relativeTime,
  skeletonRows,
  statusDot,
  tierBadge,
  timeCell,
  tooltip
} from './primitives'

const NOW = 1_725_000_000_000

describe('formatCompact', () => {
  it('compacts thousands/millions/billions without inventing precision', () => {
    expect(formatCompact(0)).toBe('0')
    expect(formatCompact(42)).toBe('42')
    expect(formatCompact(1234)).toBe('1.2K')
    expect(formatCompact(55700)).toBe('55.7K')
    expect(formatCompact(2_000_000)).toBe('2M')
    expect(formatCompact(1_234_000_000)).toBe('1.2B')
    expect(formatCompact(-500)).toBe('-500')
  })
  it('never renders an em dash', () => {
    expect(formatCompact(1234)).not.toMatch(/—/)
  })
})

describe('relativeTime / timeCell', () => {
  it('formats now/seconds/minutes/hours/days and never negative', () => {
    expect(relativeTime(NOW, NOW)).toBe('now')
    expect(relativeTime(NOW - 2_000, NOW)).toBe('now')
    expect(relativeTime(NOW - 30_000, NOW)).toBe('30s')
    expect(relativeTime(NOW - 90_000, NOW)).toBe('1m')
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h')
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3d')
    expect(relativeTime(NOW + 999_999, NOW)).toBe('now')
  })
  it('timeCell wraps relativeTime with an absolute title and data-ts for the client ticker', () => {
    const html = timeCell(NOW - 90_000, NOW)
    expect(html).toContain('data-ts="' + (NOW - 90_000) + '"')
    expect(html).toContain('>1m<')
    expect(html).toMatch(/title="2024-08-30/)
  })
})

describe('flag', () => {
  it('renders a regional-indicator emoji with the country name as title and aria-label', () => {
    const html = flag('ca')
    expect(html).toContain('title="Canada"')
    expect(html).toContain('aria-label="Canada"')
    expect(html).toContain('🇨🇦')
  })
  it('renders nothing for a non-ISO2 value, never a fake flag', () => {
    expect(flag('')).toBe('')
    expect(flag(null)).toBe('')
    expect(flag('usa')).toBe('')
  })
  it('escapes and never em-dashes', () => {
    expect(flag('ca')).not.toMatch(/—/)
  })
})

describe('osGlyph / osChip', () => {
  it('maps darwin/win/linux to a labeled glyph', () => {
    expect(osGlyph('darwin').label).toBe('macOS')
    expect(osGlyph('win32').label).toBe('Windows')
    expect(osGlyph('linux').label).toBe('Linux')
    expect(osChip('darwin')).toContain('macOS')
    expect(osChip('darwin')).toContain('<svg')
  })
  it('never fabricates a device signal for an unknown OS', () => {
    expect(osGlyph(null).label).toBe('')
    expect(osChip(null)).toBe('')
  })
})

describe('avatar', () => {
  it('is deterministic for the same identity and varies for different ones', () => {
    const a1 = avatar({ name: 'Tonys-MacBook-Pro' })
    const a2 = avatar({ name: 'Tonys-MacBook-Pro' })
    const b = avatar({ name: 'Other-PC' })
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(a1).toContain('TM')
  })
  it('shows a live dot only when live is true', () => {
    expect(avatar({ name: 'X', live: true })).toContain('avatar-live')
    expect(avatar({ name: 'X', live: false })).not.toContain('avatar-live')
  })
  it('escapes the identity and falls back to email, then "?"', () => {
    expect(avatar({ name: '', email: 'a@b.com' })).toContain('a@b.com')
    expect(avatar({ name: '' })).toContain('?')
  })
})

describe('kindBadge', () => {
  it('renders the tint, an icon, and a label for every known ingest kind', () => {
    for (const kind of ['heartbeat', 'ask', 'recap', 'listen', 'rating', 'crm', 'vault', 'license', 'seat', 'use', 'platform']) {
      const html = kindBadge(kind)
      expect(html, kind).toContain(`kind-${kind}`)
      expect(html, kind).toContain('<svg')
    }
    expect(kindBadge('heartbeat')).toContain('Heartbeat')
  })
  it('falls back to the grey seat tint for an unknown kind, keeping the raw label', () => {
    const html = kindBadge('mystery')
    expect(html).toContain('kind-seat')
    expect(html).toContain('mystery')
  })
})

describe('tierBadge', () => {
  it('labels metis and metis-light, renders nothing for null', () => {
    expect(tierBadge('metis')).toContain('Métis')
    expect(tierBadge('metis-light')).toContain('Métis Light')
    expect(tierBadge(null)).toBe('')
  })
})

describe('statusDot', () => {
  it('never renders color alone: text label always present', () => {
    const html = statusDot({ state: 'live', label: 'Live' })
    expect(html).toContain('status-dot-live')
    expect(html).toContain('>Live<')
  })
})

describe('clientChip', () => {
  it('renders "Métis <version>" or nothing', () => {
    expect(clientChip('1.8.5')).toBe('<span class="client-chip">Métis 1.8.5</span>')
    expect(clientChip(null)).toBe('')
  })
})

describe('deltaChip', () => {
  it('shows an up/down/flat arrow with the signed percent', () => {
    expect(deltaChip(8.9)).toContain('delta-up')
    expect(deltaChip(-8.9)).toContain('delta-down')
    expect(deltaChip(0)).toContain('delta-flat')
    expect(deltaChip(null)).toBe('')
  })
})

describe('tooltip', () => {
  it('wraps content with a title and an aria-describedby span carrying the same text', () => {
    const html = tooltip('<b>x</b>', 'Visitors online right now')
    expect(html).toContain('title="Visitors online right now"')
    expect(html).toMatch(/aria-describedby="tt-[a-z0-9]+"/)
    expect(html).toContain('<b>x</b>')
    expect(html).toContain('Visitors online right now</span>')
  })
})

describe('skeletonRows', () => {
  it('renders exactly n rows, zero for n<=0', () => {
    expect((skeletonRows(3).match(/skeleton-row/g) || []).length).toBe(3)
    expect(skeletonRows(0)).toBe('')
    expect(skeletonRows(-1)).toBe('')
  })
})

describe('emptyState', () => {
  it('renders a title and optional description, with a default dashed mark', () => {
    const html = emptyState({ title: 'No events found', description: 'Nothing matches the current filters.' })
    expect(html).toContain('No events found')
    expect(html).toContain('Nothing matches the current filters.')
    expect(html).toContain('empty-dash')
    expect(html).not.toMatch(/ — /)
  })
  it('omits the description paragraph when absent', () => {
    expect(emptyState({ title: 'No groups found' })).not.toContain('<p>')
  })
})

describe('no user-facing em dash in generated copy', () => {
  it('none of these primitives ever emit " — " prose', () => {
    const samples = [
      formatCompact(1234),
      relativeTime(NOW - 1000, NOW),
      flag('ca'),
      osChip('darwin'),
      avatar({ name: 'X' }),
      kindBadge('ask'),
      tierBadge('metis'),
      statusDot({ state: 'idle', label: 'Idle' }),
      clientChip('1.8.5'),
      deltaChip(1.2),
      tooltip('x', 'y'),
      emptyState({ title: 't', description: 'd' })
    ]
    for (const s of samples) expect(s).not.toMatch(/ — /)
  })
})
