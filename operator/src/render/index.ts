/**
 * Shared render primitives. A later task fills this in with one `render<Section>`
 * function per section (see plan D2): a pure `(payload, ctx) -> html string` used by
 * the Worker for first paint and by the browser client for live re-render.
 *
 * Kept dependency-free (no DOM, no Worker globals) so it compiles under both
 * operator/tsconfig.json (Worker, WebWorker lib) and operator/client/tsconfig.json
 * (browser, DOM lib), and bundles cleanly with esbuild for the client build.
 */

/** Context passed to every render function. */
export type RenderCtx = {
  now: number
  /** Server-rendered `data-theme`. 'system' means no explicit choice was cookied yet — the
   * client resolves it from prefers-color-scheme and the CSS media queries in spa/css.ts. */
  theme: 'light' | 'dark' | 'system'
}

/** HTML-escape a value for safe interpolation into server- or client-rendered markup. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export * from './primitives'
export * from './countries'
export { NAV_ICON_PATHS, KIND_ICON_PATHS, OS_ICON_PATHS, iconSvg } from './icons'
export * from './toolbar'
export * from './page-header'
export * from './metric-table'
export * from './top-list-card'
export * from './data-table'
export * from './detail-drawer'
export * from './metric-tiles'
export * from './live'
export * from './shell'
