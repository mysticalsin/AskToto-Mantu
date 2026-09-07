/**
 * Lucide icon paths (MIT license, https://lucide.dev), copied as inline `<path>` data only,
 * no lucide dependency ships in the bundle. Used by shell() nav, kindBadge(), and osGlyph().
 */

/** Nav rail icons (operator/shoey-ref/SPEC.md #2): Wallpaper, Earth, ChartNoAxesGantt, Users,
 * Building2, KeyRound, Cog, Bell, BadgeCheck. */
export const NAV_ICON_PATHS: Record<string, string> = {
  wallpaper:
    '<rect width="18" height="12" x="3" y="3" rx="2"/><path d="M7 21h10"/><path d="M12 17v4"/><path d="M3 7h18"/>',
  earth:
    '<path d="M21.54 15H17a2 2 0 0 0-2 2v4.54"/><path d="M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"/><path d="M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"/><circle cx="12" cy="12" r="10"/>',
  'chart-no-axes-gantt':
    '<path d="M8 6h10"/><path d="M6 12h9"/><path d="M11 18h7"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'building-2':
    '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  'key-round':
    '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4Z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  cog:
    '<path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"/><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  bell:
    '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  'badge-check':
    '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  search:
    '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus:
    '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'chevron-down':
    '<path d="m6 9 6 6 6-6"/>',
  'chevrons-up-down':
    '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  menu:
    '<path d="M4 12h16"/><path d="M4 6h16"/><path d="M4 18h16"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'users-round':
    '<path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  'scroll-text':
    '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  'arrow-up-down': '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>'
}

/** Icon-by-kind tint map (Tony 9c2). Every ingest kind gets a fixed color and glyph. */
export const KIND_ICON_PATHS: Record<string, string> = {
  heartbeat: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  ask: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/>',
  recap: '<path d="M15 2H9a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z"/><path d="M9 2v6a2 2 0 0 1-2 2H1"/><path d="M12 13h4"/><path d="M12 17h4"/>',
  listen: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H3v-7a9 9 0 1 1 18 0v7h-3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  rating: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.12 2.12 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.595-1.16z"/>',
  crm: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/>',
  vault: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  license: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  seat: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  use: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  platform: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>'
}

/** OS icon glyphs (Apple / Windows / Linux). Minimal inline SVG, no PNG assets. */
export const OS_ICON_PATHS: Record<string, string> = {
  darwin:
    '<path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-3.014 1.57-.12 0-.23-.02-.3-.03-.014-.06-.03-.2-.03-.34 0-1.1.55-2.2 1.174-2.93.75-.87 2.04-1.53 3.096-1.57.014.06.03.2.03.22Zm4.565 15.71c-.03.07-.463 1.58-1.535 3.12-.98 1.4-1.99 2.79-3.585 2.79-1.575 0-1.99-.91-3.79-.91-1.75 0-2.4.94-3.837.94-1.44 0-2.487-1.33-3.508-2.79-1.184-1.71-2.13-4.32-2.13-6.79 0-4.03 2.615-6.16 5.185-6.16 1.24 0 2.286.86 3.07.86.75 0 1.94-.91 3.38-.91.545 0 2.505.05 3.79 1.9-.1.06-2.26 1.32-2.26 4.03 0 3.12 2.72 4.23 2.72 4.23Z"/>',
  win: '<path d="M3 5.5 10.5 4.4V11H3z"/><path d="M11.5 4.3 21 3v8h-9.5z"/><path d="M3 12h7.5v6.6L3 17.5z"/><path d="M11.5 12H21v8l-9.5-1.3z"/>',
  linux:
    '<path d="M12 2a4 4 0 0 0-4 4v3.5c0 1-.5 1.7-1.2 2.5C5.6 13.2 5 14.6 5 16.4 5 19 7 21 9.5 21h5c2.5 0 4.5-2 4.5-4.6 0-1.8-.6-3.2-1.8-4.4-.7-.8-1.2-1.5-1.2-2.5V6a4 4 0 0 0-4-4Z"/><circle cx="9.5" cy="10.5" r="1"/><circle cx="14.5" cy="10.5" r="1"/>'
}

export function iconSvg(paths: string, opts?: { class?: string }): string {
  const cls = opts?.class ? ` class="${opts.class}"` : ''
  return `<svg${cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`
}
