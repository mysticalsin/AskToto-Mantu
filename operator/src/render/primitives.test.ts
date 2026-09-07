import { describe, expect, it } from 'vitest'
import {
  alertBadge,
  avatar,
  catalogTile,
  chip,
  clientChip,
  countryCell,
  deltaChip,
  dialog,
  emptyState,
  exportMenu,
  flag,
  flagStrip,
  formatCompact,
  kindBadge,
  logoGlyph,
  osChip,
  osGlyph,
  relativeTime,
  segmented,
  skeletonRows,
  sourceTooltip,
  statusDot,
  tabs,
  tierBadge,
  timeCell,
  toast,
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

describe('flagStrip', () => {
  it('renders up to 8 flags, each with a name on hover, and skips invalid codes', () => {
    const html = flagStrip(['ca', 'us', 'fr', 'de', 'jp', 'br', 'in', 'gb', 'mx'])
    expect((html.match(/class="flag"/g) || []).length).toBe(8)
    expect(html).toContain('title="Canada"')
    expect(html).not.toContain('title="Mexico"')
  })
  it('renders nothing for an empty or all-invalid list', () => {
    expect(flagStrip([])).toBe('')
    expect(flagStrip(['', null, 'usa'])).toBe('')
  })
})

describe('countryCell', () => {
  it('renders the flag, the full country name, and "Country only" when no secondary is given', () => {
    const html = countryCell('ca')
    expect(html).toContain('src="/assets/flags/ca.svg"')
    expect(html).toContain('alt="Canada"')
    expect(html).toContain('country-cell-name">Canada<')
    expect(html).toContain('Country only')
  })
  it('renders the caller-supplied secondary line (city or region) instead', () => {
    expect(countryCell('ca', { secondary: 'Toronto' })).toContain('country-cell-secondary">Toronto<')
  })
  it('degrades gracefully for an invalid code: no fabricated flag, still a name', () => {
    const html = countryCell('zz-bad')
    expect(html).not.toContain('<img')
    expect(html).toContain('ZZ-BAD')
  })
  it('adds a tooltip with the ISO code and every stat the caller passes, labeled', () => {
    const html = countryCell('ca', { stats: { region: 'Ontario', seats: 5, live: 2, asks: 41, timeSaved: '3.2h' } })
    expect(html).toMatch(/title="ISO CA, Ontario, 5 seats, 2 live, 41 asks, 3\.2h saved"/)
  })
  it('renders no tooltip wrapper when no stats are given', () => {
    expect(countryCell('ca')).not.toContain('tooltip-host')
  })
  it('never emits an inline style attribute or an em dash', () => {
    const html = countryCell('ca', { secondary: 'x', stats: { seats: 1 } })
    expect(html).not.toContain('style="')
    expect(html).not.toMatch(/ — /)
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
  it('never hard-codes a hex colour and never emits an inline style attribute (plan D6: no style-src unsafe-inline)', () => {
    const html = avatar({ name: 'Tonys-MacBook-Pro' })
    expect(html).toMatch(/data-hue="\d+"/)
    expect(html).not.toContain('style="')
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })
  it('buckets different identities into different data-hue values', () => {
    const a = avatar({ name: 'Tonys-MacBook-Pro' })
    const b = avatar({ name: 'Other-PC' })
    const hueOf = (html: string) => html.match(/data-hue="(\d+)"/)?.[1]
    expect(hueOf(a)).toBeDefined()
    expect(hueOf(b)).toBeDefined()
    expect(hueOf(a)).not.toBe(hueOf(b))
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

describe('logoGlyph', () => {
  it('points at the static-assets path with the label as alt text', () => {
    const html = logoGlyph('hubspot', 'HubSpot')
    expect(html).toContain('src="/assets/logos/hubspot.svg"')
    expect(html).toContain('alt="HubSpot"')
  })
})

describe('catalogTile', () => {
  it('ready tiles are clickable, not inert', () => {
    const html = catalogTile({ kind: 'hubspot', label: 'HubSpot', transport: 'rest', state: 'ready' })
    expect(html).not.toContain('data-inert')
    expect(html).toContain('data-catalog-tile="hubspot"')
    expect(html).toContain('API')
  })
  it('needs-oauth tiles render identically but inert, with the exact sentence (lock 12)', () => {
    const html = catalogTile({ kind: 'salesforce', label: 'Salesforce', transport: 'rest', state: 'needs-oauth' })
    expect(html).toContain('data-inert')
    expect(html).toContain('Needs OAuth (phase 2)')
    expect(html).toContain('catalog-tile-lock')
  })
  it('is a compact 64px-tall horizontal row: logo, then name and badge, no per-tile buttons', () => {
    const html = catalogTile({ kind: 'hubspot', label: 'HubSpot', transport: 'rest', state: 'ready' })
    expect(html).toContain('catalog-tile-body')
    expect(html).toContain('catalog-tile-name')
    // Exactly one <button> -- the tile itself -- never a nested per-tile button.
    expect((html.match(/<button/g) || []).length).toBe(1)
  })
  it('connected tiles show a live status dot with the connection count', () => {
    const html = catalogTile({ kind: 'notion', label: 'Notion', transport: 'rest', state: 'connected', connections: 2 })
    expect(html).toContain('catalog-tile-dot-connected')
    expect(html).toContain('2 connections')
  })
  it('mcp transport shows the MCP badge', () => {
    expect(catalogTile({ kind: 'github', label: 'GitHub', transport: 'mcp', state: 'ready' })).toContain('>MCP<')
  })
})

describe('tabs', () => {
  it('renders one button per item with role=tab and aria-selected matching active', () => {
    const html = tabs({ items: [{ id: 'a', label: 'A', active: true }, { id: 'b', label: 'B' }] })
    expect(html).toContain('role="tab"')
    expect(html).toMatch(/data-tab="a"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-tab="a"/)
    expect(html).toContain('data-tab="b"')
  })
})

describe('chip', () => {
  it('renders the label with no tone class by default, and a tone-* class when given', () => {
    expect(chip({ label: 'Plain' })).not.toContain('chip-')
    expect(chip({ label: 'Connected', tone: 'ok' })).toContain('chip-ok')
  })
})

describe('segmented', () => {
  it('renders one radio button per item, active gets aria-checked=true', () => {
    const html = segmented({ items: [{ id: 'light', label: 'Light', active: true }, { id: 'dark', label: 'Dark' }] })
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('role="radio"')
    expect(html).toMatch(/data-segmented="light"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-segmented="light"/)
  })
})

describe('sourceTooltip', () => {
  it('combines the formula and source into one tooltip, no em dash', () => {
    const html = sourceTooltip('Live seats in the last 2 minutes', 'heartbeats table, last 2m')
    expect(html).toContain('Live seats in the last 2 minutes. Source: heartbeats table, last 2m')
    expect(html).not.toMatch(/ — /)
  })
})

describe('toast', () => {
  it('renders the message, an Undo button only when asked, and a request id only when given', () => {
    const plain = toast({ message: 'Saved' })
    expect(plain).toContain('Saved')
    expect(plain).not.toContain('toast-undo')
    expect(plain).not.toContain('toast-request-id')
    const full = toast({ message: 'Failed', kind: 'error', requestId: 'req_123', undo: true })
    expect(full).toContain('toast-error')
    expect(full).toContain('toast-undo')
    expect(full).toContain('req_123')
  })
})

describe('dialog', () => {
  it('ships hidden with a Cancel and a named confirm action', () => {
    const html = dialog({ id: 'add-key', title: 'Add key', label: 'Secret', confirmLabel: 'Add' })
    expect(html).toContain('hidden')
    expect(html).toContain('data-dialog-cancel')
    expect(html).toContain('>Add<')
  })
  it('masked dialogs get a password input and a reveal toggle, never window.prompt', () => {
    const html = dialog({ id: 'rotate', title: 'Rotate key', label: 'New value', masked: true })
    expect(html).toContain('type="password"')
    expect(html).toContain('data-dialog-reveal')
  })
})

describe('exportMenu', () => {
  it('links to the real export route, not a client-only download', () => {
    const html = exportMenu({ csvHref: '/v1/admin/audit.csv' })
    expect(html).toContain('href="/v1/admin/audit.csv"')
    expect(html).toContain('data-export-link')
  })
})

describe('alertBadge', () => {
  it('renders the variant class and the label', () => {
    const html = alertBadge({ variant: 'danger', label: 'Connector test failing' })
    expect(html).toContain('alert-badge-danger')
    expect(html).toContain('Connector test failing')
  })
  it('renders an icon with a divider only when an icon is given', () => {
    const withIcon = alertBadge({ variant: 'ok', label: 'x', icon: '<path d="M0 0h1v1H0z"/>' })
    expect(withIcon).toContain('alert-badge-divider')
    expect(withIcon).toContain('<svg')
    const withoutIcon = alertBadge({ variant: 'ok', label: 'x' })
    expect(withoutIcon).not.toContain('alert-badge-divider')
    expect(withoutIcon).not.toContain('<svg')
  })
  it('renders an action link only when given', () => {
    const withAction = alertBadge({ variant: 'info', label: 'x', action: { label: 'Fix', href: '/fix' } })
    expect(withAction).toContain('alert-badge-action')
    expect(withAction).toContain('href="/fix"')
    expect(withAction).toContain('>Fix<')
    expect(alertBadge({ variant: 'info', label: 'x' })).not.toContain('alert-badge-action')
  })
  it('never emits an inline style attribute or an em dash', () => {
    const html = alertBadge({ variant: 'ok', label: 'x', icon: '<path d="M0 0h1v1H0z"/>', action: { label: 'Go' } })
    expect(html).not.toContain('style="')
    expect(html).not.toMatch(/ — /)
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

describe('no inline style attribute anywhere in primitives.ts (plan D6: style-src self, no unsafe-inline)', () => {
  it('none of these primitives ever emit style="', () => {
    const samples = [
      timeCell(NOW, NOW),
      flag('ca'),
      osChip('darwin'),
      avatar({ name: 'X', live: true }),
      kindBadge('ask'),
      tierBadge('metis'),
      statusDot({ state: 'idle', label: 'Idle' }),
      clientChip('1.8.5'),
      deltaChip(1.2, { flashKey: 'k' }),
      tooltip('x', 'y'),
      sourceTooltip('formula', 'source'),
      skeletonRows(3),
      emptyState({ title: 't', description: 'd' }),
      logoGlyph('hubspot', 'HubSpot'),
      catalogTile({ kind: 'hubspot', label: 'HubSpot', transport: 'rest', state: 'ready' }),
      tabs({ items: [{ id: 'a', label: 'A' }] }),
      chip({ label: 'x', tone: 'ok' }),
      segmented({ items: [{ id: 'a', label: 'A' }] }),
      toast({ message: 'x', undo: true, requestId: 'r' }),
      dialog({ id: 'x', title: 't', label: 'l', masked: true }),
      exportMenu({ csvHref: '/x.csv' }),
      flagStrip(['ca', 'us']),
      countryCell('ca', { secondary: 'Toronto', stats: { seats: 1 } }),
      alertBadge({ variant: 'ok', label: 'x', icon: '<path d="M0 0h1v1H0z"/>', action: { label: 'Go' } })
    ]
    for (const s of samples) expect(s).not.toContain('style="')
  })
})
