/**
 * Reference Sidebar.tsx chrome, ported. Renders the fixed 288px rail (logo mark, project
 * switcher, primary action or search, three nav groups, footer identity/theme/sign-out) plus
 * the sticky top header and the mount point for the page sections. Mobile (<1024px): the rail
 * goes off-canvas behind a menu button and a backdrop scrim (SPEC #2).
 */
import type { RenderCtx } from './index'
import { esc } from './index'
import { iconSvg, NAV_ICON_PATHS } from './icons'
import { NAV_SECTIONS, type NavId } from '../nav'

const NAV_ICON_BY_ID: Record<NavId, string> = {
  overview: 'wallpaper',
  realtime: 'earth',
  events: 'chart-no-axes-gantt',
  sessions: 'users',
  licenses: 'badge-check',
  notifications: 'bell',
  keys: 'key-round',
  settings: 'cog'
}

function railNav(activePage: NavId, navCounts: Partial<Record<NavId, number>>): string {
  const sections = NAV_SECTIONS.map((sec) => {
    const items = sec.items
      .map((item) => {
        const icon = iconSvg(NAV_ICON_PATHS[NAV_ICON_BY_ID[item.id]], { class: 'tool-ic' })
        const n = navCounts[item.id] ?? 0
        const count = n > 0 ? `<span class="nav-count">${n}</span>` : ''
        const active = item.id === activePage
        return `<a class="nav-item${active ? ' on' : ''}" data-nav="${item.id}" href="#${item.id}" aria-current="${active ? 'page' : 'false'}">${icon}<span>${esc(item.label)}</span>${count}</a>`
      })
      .join('')
    return `<div class="nav-sec"><p>${esc(sec.label)}</p>${items}</div>`
  }).join('')
  return `<nav id="rail-nav">${sections}</nav>`
}

export function shell(
  ctx: RenderCtx,
  opts: {
    page: NavId
    title: string
    live: number
    email: string
    /** Per-nav-item badge count (e.g. licenses: pending approvals, notifications: open notices). */
    navCounts?: Partial<Record<NavId, number>>
    bodyHtml: string
  }
): string {
  const navCounts = opts.navCounts ?? {}
  const primaryAction =
    opts.page === 'overview' || opts.page === 'licenses'
      ? `<button type="button" class="tool" data-rail-generate>${iconSvg(NAV_ICON_PATHS.plus, { class: 'tool-ic' })}<span>Generate license</span></button>`
      : `<div class="search-wrap rail-search-wrap">${iconSvg(NAV_ICON_PATHS.search, { class: 'tool-ic' })}<input id="nav-search" class="rail-search" type="search" placeholder="Search seats, events" autocomplete="off"><kbd class="kbd-hint">/</kbd></div>`
  return `<button type="button" class="rail-toggle" id="rail-toggle" aria-label="Toggle menu" aria-expanded="false" aria-controls="rail">${iconSvg(NAV_ICON_PATHS.menu, { class: 'tool-ic' })}</button>
<button type="button" class="rail-backdrop" id="rail-backdrop" data-open="0" aria-label="Close menu" tabindex="-1"></button>
<div class="shell">
  <aside class="rail hide-scrollbar" id="rail">
    <div class="rail-brand">
      <span class="rail-logo" aria-hidden="true">M</span>
      <button type="button" class="tool rail-switcher" data-rail-switcher>${iconSvg(NAV_ICON_PATHS['building-2'], { class: 'tool-ic' })}<span>Métis Operator</span>${iconSvg(NAV_ICON_PATHS['chevrons-up-down'], { class: 'tool-ic' })}</button>
    </div>
    ${primaryAction}
    ${railNav(opts.page, navCounts)}
    <div class="rail-foot">
      <span class="access-chip" data-access-solid>Access</span>
      <div class="who">${esc(opts.email)}</div>
      <div class="row theme-group" role="radiogroup" aria-label="Theme">
        <button type="button" class="theme-btn" data-theme-choice="system" aria-pressed="${ctx.theme === 'system' ? 'true' : 'false'}">System</button>
        <button type="button" class="theme-btn" data-theme-choice="light" aria-pressed="${ctx.theme === 'light' ? 'true' : 'false'}">Light</button>
        <button type="button" class="theme-btn" data-theme-choice="dark" aria-pressed="${ctx.theme === 'dark' ? 'true' : 'false'}">Dark</button>
      </div>
      <form method="post" action="/logout"><button class="theme-btn" type="submit">Sign out</button></form>
    </div>
  </aside>
  <div class="main">
    <header class="top">
      <h2 id="page-title">${esc(opts.title)}</h2>
      <span class="live" data-live-indicator>LIVE ${opts.live}</span>
    </header>
    ${opts.bodyHtml}
  </div>
</div>`
}
