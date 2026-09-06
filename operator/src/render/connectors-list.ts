/**
 * Connector list block (plan 6.10b, from the reference screenshot): two groups, "Needs
 * attention N" and "Connected N", each a card of hairline-separated 56px rows. Used as the
 * first block on Connectors and as a compact card on Overview (plan 6.2).
 *
 * Rows stagger in 30ms (plan 6.10b), not the usual 40ms -- `connectorRow()` carries its own
 * `data-stagger-ms="30"` so operator/client/motion-bind.ts picks the right cadence without
 * every other `data-stagger` user having to know this section is different.
 */
import { esc } from './index'
import { iconSvg, NAV_ICON_PATHS } from './icons'

export type ConnectorRowStatus = 'connected' | 'attention' | 'pending' | 'untested'
export type ConnectorTransport = 'mcp' | 'rest'

const STATUS_DOT_CLASS: Record<ConnectorRowStatus, string> = {
  connected: 'connected',
  attention: 'attention',
  pending: 'pending',
  untested: 'untested'
}

export interface ConnectorRow {
  id: string
  kind: string
  label: string
  transport: ConnectorTransport
  /** Corner dot colour (plan 6.10b): emerald connected, rose attention, amber pending, grey
   *  untested. */
  status: ConnectorRowStatus
  /**
   * One word, verbatim (plan 6.10b names four: Authenticate for an OAuth kind, Connect for an
   * API-key kind, Test for a connected row, Fix for a failing one) -- the caller decides which
   * applies for `pending`/`untested` rows too, since that depends on the catalog entry and the
   * last test result, not on anything this primitive knows.
   */
  action: string
  /** Drives which flow the client opens on click (plan 6.10b): 'oauth2-auth-code',
   *  'oauth2-client-credentials', an api-key kind, 'custom-mcp', or whatever the client-side
   *  handler recognizes. */
  auth: string
  /** Needs-attention reason and scope ("Needs authentication", "Test failed 2 hours ago",
   *  "Credential revoked") -- shown only when status is 'attention'. */
  reason?: string
  /** Tools enabled, from tools_json (plan 6.10b) -- omitted or 0 renders "No tools discovered
   *  yet" instead of a count. Ignored when status is 'attention' (the reason shows instead). */
  toolsCount?: number
}

/** One 56px connector row: 32px logo tile with a corner status dot, name + transport badge,
 *  a secondary line, and a right-aligned one-word action in --accent-text. The whole row is
 *  clickable (plan 6.10b: "when I click on it it makes me connect") via the data-connector-*
 *  attributes a client click handler reads -- this module never attaches a listener itself. */
export function connectorRow(row: ConnectorRow, opts?: { hidden?: boolean }): string {
  const badge = row.transport === 'mcp' ? 'MCP' : 'API'
  const secondary =
    row.status === 'attention'
      ? esc(row.reason || 'Needs attention')
      : row.toolsCount
        ? `<span data-count-to="${row.toolsCount}">${row.toolsCount}</span> tool${row.toolsCount === 1 ? '' : 's'} enabled`
        : 'No tools discovered yet'
  const hiddenAttr = opts?.hidden ? ' hidden' : ''
  return `<div class="connector-row" role="button" tabindex="0" data-stagger data-stagger-ms="30"${hiddenAttr}
    data-connector-kind="${esc(row.kind)}" data-connector-id="${esc(row.id)}"
    data-connector-action="${esc(row.action)}" data-connector-auth="${esc(row.auth)}">
    <span class="connector-row-icon">
      <img class="connector-row-logo" src="/assets/logos/${esc(row.kind)}.svg" width="32" height="32" alt="${esc(row.label)}" loading="lazy">
      <i class="connector-row-dot connector-row-dot-${STATUS_DOT_CLASS[row.status]}" aria-hidden="true" data-flash-key="connector-status-${esc(row.id)}"></i>
    </span>
    <span class="connector-row-body">
      <span class="connector-row-name">${esc(row.label)}<span class="chip connector-row-badge">${badge}</span></span>
      <span class="connector-row-secondary">${secondary}</span>
    </span>
    <span class="connector-row-action">${esc(row.action)}</span>
  </div>`
}

/**
 * One group card: heading with a count, up to `visibleLimit` (default 5) rows shown, the rest
 * present but `hidden`, and a "Show N more" button (`data-expand`) past the limit that the
 * client reveals in place with `flip()` at the same 30ms stagger (plan 6.10b). An empty group
 * (no rows) renders nothing at all -- never a zero-count card.
 */
export function connectorGroup(title: string, rows: ConnectorRow[], opts?: { visibleLimit?: number }): string {
  if (!rows.length) return ''
  const limit = opts?.visibleLimit ?? 5
  const rowsHtml = rows.map((r, i) => connectorRow(r, { hidden: i >= limit })).join('')
  const moreCount = Math.max(0, rows.length - limit)
  const showMore = moreCount
    ? `<button type="button" class="connector-show-more" data-expand data-expand-ms="30">Show ${moreCount} more${iconSvg(NAV_ICON_PATHS['chevron-down'], { class: 'tool-ic' })}</button>`
    : ''
  return `<div class="card connector-group" data-connector-group>
    <div class="connector-group-head"><h3>${esc(title)} <span class="connector-group-count">${rows.length}</span></h3></div>
    <div class="connector-group-rows" data-connector-rows>${rowsHtml}</div>
    ${showMore}
  </div>`
}
