import type { DashboardPayload } from './dashboard'
import { esc, shell, type RenderCtx } from './render'
import { renderAudit } from './render/pages/audit'
import { renderConnectors } from './render/pages/connectors'
import { renderEvents } from './render/pages/events'
import { renderGroups } from './render/pages/groups'
import { renderKeys } from './render/pages/keys'
import { renderLicenses } from './render/pages/licenses'
import { renderNotifications } from './render/pages/notifications'
import { renderOverview } from './render/pages/overview'
import { renderRealtime } from './render/pages/realtime'
import { renderSessions } from './render/pages/sessions'
import { renderSettings } from './render/pages/settings'
import { SPA_CSS_PATH, SPA_JS_PATH } from './spa/manifest'

/**
 * Shell + composition only (plan P0.4). Every page's body-building logic lives in its own
 * module under operator/src/render/pages/<page>.ts, each exporting `render<Page>(data, ctx)`;
 * this file's only job is to call each one, assemble the `data-page` sections shell() wraps in
 * the rail, and print the outer `<html>` document. `renderConsole` stays the entry so
 * ui.console.test.ts (now split into a shell test plus one test per page module, see
 * operator/src/ui.console.test.ts and operator/src/render/pages/*.test.ts) keeps a stable
 * import, and so does operator/src/routes/admin-core.ts.
 *
 * `page: 'overview'` stays the shell() call's page because a URL hash fragment never reaches
 * the Worker (there is no way to know the real requested page at first paint); shell() itself
 * renders all three primary-action variants and operator/client/router.ts's route() flips which
 * one is visible on every hash change, including the first (plan P0.4, see
 * operator/src/render/shell.ts's `railActionFor` and its client mirror).
 */
export function renderConsole(
  data: DashboardPayload,
  opts: { nonce?: string; theme?: 'light' | 'dark' | 'system'; liveUrl?: string } = {}
): string {
  const theme = opts.theme ?? 'light'
  const ctx: RenderCtx = { now: data.now, theme }
  const nonceAttr = opts.nonce ? ` nonce="${esc(opts.nonce)}"` : ''
  const htmlThemeAttr = theme === 'system' ? '' : ` data-theme="${theme}"`
  // Plan 3.7 item 4: `data-live-url` marks a real Worker response -- operator/src/routes/
  // admin-core.ts is the only caller that supplies `liveUrl`, so a standalone preview
  // (operator/scripts/preview.mjs never passes it) renders with no attribute at all, and
  // operator/src/render/shell.ts + operator/client/live.ts key the rail's "Offline preview" off
  // its absence rather than guessing from a failed poll.
  const htmlLiveUrlAttr = opts.liveUrl ? ` data-live-url="${esc(opts.liveUrl)}"` : ''
  const pendingApprovals = data.licenses.rows.filter((r) => r.approval !== 'approved').length

  const bodyHtml = `
    <section class="page wrap" data-page="overview">${renderOverview(data, ctx)}</section>
    <section class="page wrap" data-page="realtime" hidden>${renderRealtime(data, ctx)}</section>
    <section class="page wrap" data-page="map" hidden aria-hidden="true"></section>
    <section class="page wrap" data-page="sessions" hidden>${renderSessions(data, ctx)}</section>
    <section class="page wrap" data-page="events" hidden>${renderEvents(data, ctx)}</section>
    <section class="page wrap" data-page="licenses" hidden>${renderLicenses(data, ctx)}</section>
    <section class="page wrap" data-page="groups" hidden>${renderGroups(data, ctx)}</section>
    <section class="page wrap" data-page="notifications" hidden>${renderNotifications(data, ctx)}</section>
    <section class="page wrap" data-page="keys" hidden>${renderKeys(data, ctx)}</section>
    <section class="page wrap" data-page="connectors" hidden>${renderConnectors(data, ctx)}</section>
    <section class="page wrap" data-page="audit" hidden>${renderAudit(data, ctx)}</section>
    <section class="page wrap" data-page="settings" hidden>${renderSettings(data, ctx)}</section>
  `

  const shellHtml = shell(ctx, {
    page: 'overview',
    title: 'Overview',
    live: data.kpis.live,
    email: data.email,
    navCounts: { licenses: pendingApprovals, notifications: data.notices.length },
    liveUrl: opts.liveUrl,
    bodyHtml
  })

  return `<!doctype html>
<html lang="en"${htmlThemeAttr}${htmlLiveUrlAttr}><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Métis Operator</title>
<link rel="stylesheet" href="${SPA_CSS_PATH}"${nonceAttr}>
</head>
<body>
<svg id="spark-defs"><defs>
  <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0" stop-color="#e4e4e7" stop-opacity="0.28"/>
    <stop offset="1" stop-color="#e4e4e7" stop-opacity="0"/>
  </linearGradient>
</defs></svg>
${shellHtml}
<script src="${SPA_JS_PATH}" defer${nonceAttr}></script>
</body></html>`
}
