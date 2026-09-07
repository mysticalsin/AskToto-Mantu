/**
 * Reference Sidebar.tsx chrome, ported and extended per plan (metis-portal-wow) 6.1: the fixed
 * 288px rail (logo mark, inert project pill, live indicator, primary action or search, three nav
 * groups with badge slots, footer identity/theme/sign-out), the mobile top bar (<1024px: menu
 * button, title, live dot), and the toast region. Mobile (<1024px): the rail goes off-canvas
 * behind a menu button and a backdrop scrim (SPEC #2).
 *
 * Tony 2026-09-06 ("remove that bar jump to a page, I want a fast search bar for users and
 * licences but not like that"): there is no command palette, no page list, no shortcut sheet.
 * The rail's search field (plan 3.7 item 7) is a plain input with an inline results dropdown
 * (operator/client/search.ts builds the dropdown from the rendered page, this file only ships
 * the empty `[data-search-results]` container).
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
  groups: 'users-round',
  notifications: 'bell',
  keys: 'key-round',
  connectors: 'plug',
  audit: 'scroll-text',
  settings: 'cog'
}

function navIconPath(key: string): string {
  return NAV_ICON_PATHS[key] ?? ''
}

/** Nav item ids that carry a live-updated badge (plan 6.1: Licenses = pending approvals,
 * Notifications = unseen, Connectors = failing tests). operator/client/live.ts targets these by
 * `data-badge` so it can create/update/remove the count span without a full rail re-render. */
const BADGE_NAV_IDS: ReadonlySet<NavId> = new Set(['licenses', 'notifications', 'connectors'])

function railNav(activePage: NavId, navCounts: Partial<Record<NavId, number>>): string {
  const sections = NAV_SECTIONS.map((sec) => {
    const items = sec.items
      .map((item) => {
        const icon = iconSvg(navIconPath(NAV_ICON_BY_ID[item.id]), { class: 'tool-ic' })
        const n = navCounts[item.id] ?? 0
        const badgeAttr = BADGE_NAV_IDS.has(item.id) ? ` data-badge="${item.id}"` : ''
        const count = n > 0 ? `<span class="nav-count"${badgeAttr}>${n}</span>` : ''
        const active = item.id === activePage
        return `<a class="nav-item${active ? ' on' : ''}" data-nav="${item.id}" href="#${item.id}" aria-current="${active ? 'page' : 'false'}">${icon}<span class="nav-label">${esc(item.label)}</span>${count}</a>`
      })
      .join('')
    return `<div class="nav-sec"><p>${esc(sec.label)}</p>${items}</div>`
  }).join('')
  return `<nav id="rail-nav">${sections}</nav>`
}

/** Which of the three primary-action variants is correct for a page (plan 6.1). Mirrored
 * exactly in operator/client/router.ts's `railActionFor()` so a hash-only route change (no
 * reload, first paint is always the 'overview' variant server-side since a URL fragment never
 * reaches the Worker) can toggle the right one back into view. */
export function railActionFor(page: NavId): 'generate' | 'connector' | 'search' {
  if (page === 'overview' || page === 'licenses') return 'generate'
  if (page === 'connectors') return 'connector'
  return 'search'
}

/** All three variants always render (plan P0.4: "the rail shows the right ... primary action");
 * only the one `railActionFor(page)` picks is not `hidden`. operator/client/router.ts's route()
 * flips which one is hidden on every navigation, so the button is correct after the very first
 * hash change even though the server can only guess 'overview' for opts.page. */
function primaryAction(page: NavId): string {
  const active = railActionFor(page)
  const generateHidden = active === 'generate' ? '' : ' hidden'
  const connectorHidden = active === 'connector' ? '' : ' hidden'
  const searchHidden = active === 'search' ? '' : ' hidden'
  return `<button type="button" class="tool rail-action" data-rail-action="generate" data-rail-generate${generateHidden}>${iconSvg(NAV_ICON_PATHS.plus, { class: 'tool-ic' })}<span>Generate license</span></button>
  <button type="button" class="tool rail-action" data-rail-action="connector" data-rail-add-connector${connectorHidden}>${iconSvg(NAV_ICON_PATHS.plus, { class: 'tool-ic' })}<span>Add connector</span></button>
  <div class="rail-search-shell" data-rail-action="search" data-rail-search${searchHidden}>
    <div class="search-wrap rail-search-wrap">
      ${iconSvg(NAV_ICON_PATHS.search, { class: 'tool-ic' })}
      <input id="nav-search" class="rail-search" type="search" placeholder="Search seats, licenses, groups" autocomplete="off" spellcheck="false">
      <kbd class="kbd-hint">/</kbd>
    </div>
    <div class="search-results" data-search-results hidden role="listbox" aria-label="Search results"></div>
  </div>`
}

/** "Live, 7 online" seeds the rail's live indicator at first paint (no JS has run yet, so there
 * is no "updated Ns ago" to show); operator/client/live.ts overwrites `[data-live-text]` with a
 * ticking "updated Ns ago" once the first poll lands. */
function seedLiveText(live: number): string {
  return live > 0 ? `Live, ${live} online` : 'No seats online right now'
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
  return `<div class="shell">
  <button type="button" class="rail-backdrop" id="rail-backdrop" data-open="0" aria-label="Close menu" tabindex="-1"></button>
  <aside class="rail hide-scrollbar" id="rail">
    <div class="rail-brand">
      <span class="rail-logo" aria-hidden="true">M</span>
      <div class="rail-pill" data-rail-pill>${iconSvg(NAV_ICON_PATHS['building-2'], { class: 'tool-ic' })}<span>Métis Operator</span></div>
    </div>
    <div class="live-indicator" data-live-indicator data-state="live">
      <i class="live-dot" aria-hidden="true"></i>
      <span data-live-text>${esc(seedLiveText(opts.live))}</span>
    </div>
    ${primaryAction(opts.page)}
    ${railNav(opts.page, navCounts)}
    <div class="rail-foot">
      <span class="access-chip" data-access-solid>Private, Access</span>
      <div class="who">${esc(opts.email)}</div>
      <div class="theme-seg" role="radiogroup" aria-label="Theme">
        <button type="button" class="theme-btn" data-theme-choice="system" aria-pressed="${ctx.theme === 'system' ? 'true' : 'false'}">System</button>
        <button type="button" class="theme-btn" data-theme-choice="light" aria-pressed="${ctx.theme === 'light' ? 'true' : 'false'}">Light</button>
        <button type="button" class="theme-btn" data-theme-choice="dark" aria-pressed="${ctx.theme === 'dark' ? 'true' : 'false'}">Dark</button>
      </div>
      <form method="post" action="/logout"><button class="theme-btn" type="submit">Sign out</button></form>
    </div>
  </aside>
  <div class="main">
    <header class="mobile-bar">
      <button type="button" class="rail-toggle" id="rail-toggle" aria-label="Toggle menu" aria-expanded="false" aria-controls="rail">${iconSvg(NAV_ICON_PATHS.menu, { class: 'tool-ic' })}</button>
      <h2 id="page-title">${esc(opts.title)}</h2>
      <i class="live-dot-mini" data-live-dot data-state="live" aria-hidden="true"></i>
    </header>
    ${opts.bodyHtml}
  </div>
</div>
<div class="toast-region" data-toasts aria-live="polite" aria-atomic="false"></div>`
}
