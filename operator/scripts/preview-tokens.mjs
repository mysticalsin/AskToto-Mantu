#!/usr/bin/env node
/**
 * Renders the plan-3.2 token sheet as two standalone HTML pages -- every token as a swatch with
 * its name and value, the type scale with real text, a card, a button in every state, an input,
 * a 4-row table, a status dot set, and the four data colours as bars (P0.1 deliverable 7).
 *
 * Writes /private/tmp/claude-501/operator-preview/tokens-light.html and tokens-dark.html. CSS is
 * inlined and the @font-face `src` is rewritten from `/assets/fonts/...` to an absolute
 * `file://` path into operator/public/fonts/, so each file opens standalone (no server, no
 * Worker) with the real Space Grotesk / Inter faces.
 *
 * Run: `node operator/scripts/preview-tokens.mjs`.
 */
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPERATOR_ROOT = join(__dirname, '..')
const CSS_ENTRY = join(OPERATOR_ROOT, 'src', 'spa', 'css.ts')
const FONTS_DIR = join(OPERATOR_ROOT, 'public', 'fonts')
const LOGOS_DIR = join(OPERATOR_ROOT, 'public', 'logos')
const FLAGS_DIR = join(OPERATOR_ROOT, 'public', 'flags')
const OUT_DIR = '/private/tmp/claude-501/operator-preview'

/** Bundles operator/src/spa/css.ts's own CONSOLE_CSS export directly (not manifest.ts's
 *  composed SPA_CSS, which also concatenates other pages' shell/chrome stylesheets owned by
 *  other tasks) -- this preview is specifically the P0.1 token sheet. Same in-Node-bundle
 *  technique as operator/scripts/build-client.mjs's loadShoeyLandSvg(). */
async function loadConsoleCss() {
  const result = await build({
    entryPoints: [CSS_ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    write: false
  })
  const tmpDir = mkdtempSync(join(tmpdir(), 'metis-operator-preview-'))
  const tmpFile = join(tmpDir, 'css.mjs')
  try {
    writeFileSync(tmpFile, result.outputFiles[0].text)
    const mod = await import(pathToFileURL(tmpFile).href)
    if (!mod.CONSOLE_CSS || typeof mod.CONSOLE_CSS !== 'string') {
      throw new Error('preview-tokens: operator/src/spa/css.ts did not export CONSOLE_CSS')
    }
    return mod.CONSOLE_CSS
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** `/assets/fonts/<file>` -> `file:///abs/path/to/operator/public/fonts/<file>` so the @font-face
 *  rules resolve with the file opened directly (no Worker, no dev server). */
function makeFontsStandalone(css) {
  const fontsUrl = pathToFileURL(FONTS_DIR + '/').href
  return css.replace(/url\('\/assets\/fonts\//g, `url('${fontsUrl}`)
}

/** Same idea as makeFontsStandalone(), applied to the rendered page body rather than the CSS:
 *  the new connector-list and country-cell demos below render real `<img src="/assets/logos/...">`
 *  / `/assets/flags/...` markup from the real primitives, so this file opens standalone with the
 *  real logo and flag art too, not broken-image icons. */
function makeAssetPathsStandalone(html) {
  const logosUrl = pathToFileURL(LOGOS_DIR + '/').href
  const flagsUrl = pathToFileURL(FLAGS_DIR + '/').href
  return html.replace(/src="\/assets\/logos\//g, `src="${logosUrl}`).replace(/src="\/assets\/flags\//g, `src="${flagsUrl}`)
}

/** Bundles one operator/src/render/*.ts module standalone (same in-Node-bundle technique as
 *  loadConsoleCss() above) so this preview calls the real primitive functions instead of
 *  hand-typing markup that could drift from what they actually render. */
async function bundleRenderModule(entryFile) {
  const result = await build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    write: false
  })
  const tmpDir = mkdtempSync(join(tmpdir(), 'metis-operator-preview-'))
  const tmpFile = join(tmpDir, 'mod.mjs')
  try {
    writeFileSync(tmpFile, result.outputFiles[0].text)
    return await import(pathToFileURL(tmpFile).href)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** Parses every `--token: value;` declaration out of one `{...}` block's body. Strips `/* ... *\/`
 *  comments first -- css.ts's token blocks carry prose comments that themselves contain
 *  `--token:` -like text (documenting the role split), and without stripping them the regex
 *  below would treat a comment's "--accent: rings and selected..." as the real declaration and
 *  swallow everything up to the next real semicolon into one garbage value. */
function parseDeclarations(body) {
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = new Map()
  const re = /--([a-z0-9-]+):\s*([^;]+);/g
  let m
  while ((m = re.exec(withoutComments))) out.set(`--${m[1]}`, m[2].trim())
  return out
}

/** Pulls every `--token: value;` declaration out of the light (`:root`) block, in source order,
 *  so the preview always reflects the real sheet rather than a hand-maintained duplicate list. */
function extractLightTokens(css) {
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/)
  if (!rootMatch) throw new Error('preview-tokens: could not find the :root token block in SPA_CSS')
  const light = parseDeclarations(rootMatch[1])
  return [...light.entries()].map(([name, value]) => ({ name, value }))
}

/**
 * Same token names, in the same order as extractLightTokens(), but each value is the real one a
 * dark-theme viewer sees: the `[data-theme="dark"]` block's own declaration when it redefines a
 * token, otherwise the light value (plan 3.2: "dark redefines only tokens"). Without this, the
 * dark preview's swatches would render correctly (the browser resolves var() against the page's
 * own data-theme) while the printed hex text next to them stayed the light value -- a real,
 * user-visible mismatch on the exact page meant to let Tony verify tokens.
 */
function extractDarkTokens(css) {
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/)
  const darkMatch = css.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)
  if (!rootMatch) throw new Error('preview-tokens: could not find the :root token block in SPA_CSS')
  if (!darkMatch) throw new Error('preview-tokens: could not find the [data-theme="dark"] token block in SPA_CSS')
  const light = parseDeclarations(rootMatch[1])
  const dark = parseDeclarations(darkMatch[1])
  return [...light.keys()].map((name) => ({ name, value: dark.has(name) ? dark.get(name) : light.get(name) }))
}

const GROUPS = [
  { title: 'Surfaces & ink', match: (n) => /^--(bg|bg-2|surface|surface-2|border|border-2|ink|ink-2|ink-3)$/.test(n) },
  { title: 'Accent', match: (n) => /^--accent/.test(n) },
  { title: 'Status', match: (n) => /^--(live|ok|warn|danger|info|beacon)/.test(n) },
  { title: 'Data series', match: (n) => /^--data-/.test(n) },
  { title: 'Map (light choropleth, both themes)', match: (n) => /^--map-/.test(n) },
  { title: 'Choropleth scale (sequential, light to saturated violet)', match: (n) => /^--chart-scale-/.test(n) },
  { title: 'Shape & glass', match: (n) => /^--(radius|shadow|glass|card-highlight)/.test(n) },
  { title: 'Type', match: (n) => /^--font-/.test(n) },
  { title: 'Motion', match: (n) => /^--ease-/.test(n) },
  {
    title: 'Legacy aliases',
    match: (n) =>
      /^--(def-|card|card-foreground|input|ring|foreground|muted|accent-surface|accent-foreground|primary|primary-foreground|destructive|chart-[0-5]\b|ping|panel|hair|ink2|ink3|land|ocean|land-stroke|nav|nav-on|mono|sans)/.test(
        n
      )
  }
]

function isColorLike(value) {
  return /^#|^rgba?\(|^color-mix\(/.test(value)
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderTokenSwatches(tokens) {
  const used = new Set()
  const sections = GROUPS.map((group) => {
    const inGroup = tokens.filter((t) => group.match(t.name) && !used.has(t.name))
    inGroup.forEach((t) => used.add(t.name))
    if (inGroup.length === 0) return ''
    const rows = inGroup
      .map((t) => {
        const swatch = isColorLike(t.value)
          ? `<span class="pv-swatch" style="background:var(${t.name})"></span>`
          : `<span class="pv-swatch pv-swatch-empty" aria-hidden="true"></span>`
        return `<div class="pv-token-row"><span class="pv-token-name">${esc(t.name)}</span>${swatch}<span class="pv-token-value">${esc(t.value)}</span></div>`
      })
      .join('')
    return `<section class="pv-group"><h3>${esc(group.title)}</h3><div class="pv-token-list">${rows}</div></section>`
  })
  const rest = tokens.filter((t) => !used.has(t.name))
  const restRows = rest
    .map(
      (t) =>
        `<div class="pv-token-row"><span class="pv-token-name">${esc(t.name)}</span><span class="pv-swatch pv-swatch-empty" aria-hidden="true"></span><span class="pv-token-value">${esc(t.value)}</span></div>`
    )
    .join('')
  const restSection = rest.length > 0 ? `<section class="pv-group"><h3>Other</h3><div class="pv-token-list">${restRows}</div></section>` : ''
  return sections.join('') + restSection
}

const PREVIEW_CSS = `
  .pv-page { max-width: 1200px; margin: 0 auto; padding: 32px; display: grid; gap: 32px; }
  .pv-h1 { font: 600 24px/1.2 var(--font-display); letter-spacing: -0.02em; margin: 0 0 4px; }
  .pv-h1-sub { color: var(--ink-2); font: 400 13px var(--font-body); margin: 0 0 24px; }
  .pv-groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .pv-group { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); padding: 14px 16px; }
  .pv-group h3 { font: 600 13px var(--font-body); margin: 0 0 10px; }
  .pv-token-list { display: grid; gap: 6px; }
  .pv-token-row { display: grid; grid-template-columns: 1fr 24px 1fr; align-items: center; gap: 8px; font: 12px var(--font-mono); }
  .pv-token-name { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pv-swatch { width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border-2); display: block; }
  .pv-swatch-empty { background: repeating-linear-gradient(45deg, var(--surface-2), var(--surface-2) 3px, var(--surface) 3px, var(--surface) 6px); }
  .pv-token-value { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pv-section-title { font: 600 15px var(--font-body); margin: 0 0 12px; }
  .pv-type-demo { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); box-shadow: var(--shadow), var(--card-highlight); padding: 20px; display: grid; gap: 16px; }
  .pv-type-title { font: 600 24px/1.2 var(--font-display); letter-spacing: -0.02em; color: var(--ink); }
  .pv-type-numeral { font: 600 32px/1 var(--font-display); letter-spacing: -0.02em; color: var(--ink); font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; }
  .pv-type-body { font: 400 13px/19.5px var(--font-body); color: var(--ink); max-width: 60ch; }
  .pv-type-label { font: 600 12px var(--font-body); color: var(--ink-2); }
  .pv-type-mono { font: 12px var(--font-mono); color: var(--ink-3); }
  .pv-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .pv-demo-card-wrap { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .pv-demo-focus { outline: 2px solid var(--ring); outline-offset: 2px; }
  .pv-demo-hover { background: var(--bg-2); }
  .pv-status-list { display: grid; gap: 8px; }
  .pv-bars { display: grid; gap: 8px; }
  .pv-bar-row { display: grid; grid-template-columns: 80px 1fr; align-items: center; gap: 10px; }
  .pv-bar-track { height: 10px; border-radius: 999px; background: var(--data-track); overflow: hidden; }
  .pv-bar-fill { height: 100%; border-radius: 999px; }
  .pv-primitive-block { margin-top: 20px; }
  .pv-primitive-label { font: 600 12px var(--font-body); color: var(--ink-2); margin: 0 0 10px; }
  .pv-flow { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
`

/**
 * Real markup from the four plan 3.5c / 3.6 / 6.10b primitives, so Tony sees exactly what
 * countryCell()/flagStrip(), connectorRow()/connectorGroup(), dataTable({variant:'card'}) and
 * alertBadge() render rather than a hand-typed stand-in that could drift from the real functions.
 */
function renderPrimitivesDemo({ primitives, connectors, dataTable, icons }) {
  const countryDemo = `<div class="pv-flow">
    <div>${primitives.countryCell('CA')}</div>
    <div>${primitives.countryCell('US', { secondary: 'San Francisco, CA' })}</div>
    <div>${primitives.countryCell('FR', {
      secondary: 'Paris',
      stats: { region: 'EMEA', seats: 6, live: 4, asks: 74, timeSaved: '3.2h' }
    })}</div>
    <div>${primitives.countryCell(null)}</div>
  </div>
  <div class="pv-primitive-block">${primitives.flagStrip(['CA', 'US', 'FR', 'DE', 'GB', 'JP', 'AU', 'BR', 'IN'])}</div>`

  const attentionRows = [
    {
      id: 'conn_slack',
      kind: 'slack',
      label: 'Slack',
      transport: 'rest',
      status: 'attention',
      action: 'Fix',
      auth: 'oauth2-auth-code',
      reason: 'Test failed 2 hours ago'
    },
    {
      id: 'conn_hubspot',
      kind: 'hubspot',
      label: 'HubSpot',
      transport: 'rest',
      status: 'pending',
      action: 'Authenticate',
      auth: 'oauth2-auth-code'
    }
  ]
  const connectedRows = [
    { id: 'conn_notion', kind: 'notion', label: 'Notion', transport: 'mcp', status: 'connected', action: 'Test', auth: 'custom-mcp', toolsCount: 8 },
    { id: 'conn_linear', kind: 'linear', label: 'Linear', transport: 'rest', status: 'connected', action: 'Test', auth: 'api-key', toolsCount: 0 },
    { id: 'conn_github', kind: 'github', label: 'GitHub', transport: 'rest', status: 'connected', action: 'Test', auth: 'oauth2-auth-code', toolsCount: 12 },
    { id: 'conn_jira', kind: 'jira', label: 'Jira', transport: 'rest', status: 'connected', action: 'Test', auth: 'api-key', toolsCount: 5 },
    { id: 'conn_airtable', kind: 'airtable', label: 'Airtable', transport: 'rest', status: 'untested', action: 'Test', auth: 'api-key' },
    { id: 'conn_zendesk', kind: 'zendesk', label: 'Zendesk', transport: 'rest', status: 'connected', action: 'Test', auth: 'oauth2-auth-code', toolsCount: 3 },
    { id: 'conn_asana', kind: 'asana', label: 'Asana', transport: 'rest', status: 'connected', action: 'Test', auth: 'oauth2-auth-code', toolsCount: 7 }
  ]
  const connectorDemo = `<div class="pv-demo-card-wrap">
    ${connectors.connectorGroup('Needs attention', attentionRows)}
    ${connectors.connectorGroup('Connected', connectedRows)}
  </div>`

  const cardTableDemo = dataTable.dataTable({
    variant: 'card',
    columns: [
      { key: 'name', label: 'Account', sortable: true, sortDirection: 'asc' },
      { key: 'seats', label: 'Seats', numeric: true, sortable: true },
      { key: 'asks', label: 'Asks 24h', numeric: true, sortable: true, sortDirection: 'desc' },
      { key: 'status', label: 'Status' }
    ],
    rows: [
      { cells: { name: 'Acme Corp', seats: '18', asks: '241', status: primitives.statusDot({ state: 'live', label: 'Live' }) } },
      {
        cells: { name: 'Globex', seats: '52', asks: '903', status: primitives.statusDot({ state: 'live', label: 'Live' }) },
        selected: true
      },
      { cells: { name: 'Initech', seats: '6', asks: '74', status: primitives.statusDot({ state: 'idle', label: 'Idle' }) } }
    ],
    emptyTitle: 'No accounts yet',
    footer: '3 accounts'
  })

  const alertBadgeDemo = `<div class="pv-row">
    ${primitives.alertBadge({ variant: 'ok', icon: icons.NAV_ICON_PATHS['badge-check'], label: 'All systems operational' })}
    ${primitives.alertBadge({
      variant: 'danger',
      icon: icons.NAV_ICON_PATHS.bell,
      label: 'Major incident: ingestion delayed',
      action: { label: 'Details', href: '#' }
    })}
    ${primitives.alertBadge({ variant: 'info', label: 'Scheduled maintenance Sunday 02:00 UTC' })}
  </div>`

  return `<div>
    <h2 class="pv-section-title">New primitives (plan 3.5c, 3.6, 6.10b)</h2>
    <div class="pv-primitive-block">
      <h3 class="pv-primitive-label">countryCell() / flagStrip() -- plan 3.6</h3>
      ${countryDemo}
    </div>
    <div class="pv-primitive-block">
      <h3 class="pv-primitive-label">connectorRow() / connectorGroup() -- plan 6.10b</h3>
      ${connectorDemo}
    </div>
    <div class="pv-primitive-block">
      <h3 class="pv-primitive-label">dataTable({ variant: 'card' }) -- plan 3.5c</h3>
      ${cardTableDemo}
    </div>
    <div class="pv-primitive-block">
      <h3 class="pv-primitive-label">alertBadge() -- plan 3.5c</h3>
      ${alertBadgeDemo}
    </div>
  </div>`
}

function renderPage(theme, tokenSectionsHtml, css, primitivesDemoHtml) {
  return `<!doctype html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8">
<title>Metis Operator tokens (${theme})</title>
<style>${css}</style>
<style>${PREVIEW_CSS}</style>
</head>
<body>
<div class="pv-page">
  <div>
    <h1 class="pv-h1">Metis Operator design tokens</h1>
    <p class="pv-h1-sub">Plan metis-portal-wow.md section 3.2, ${theme} theme. Every token in operator/src/spa/css.ts's token blocks, grouped, with a swatch when the value is a colour.</p>
  </div>

  <div class="pv-groups">
    ${tokenSectionsHtml}
  </div>

  <div>
    <h2 class="pv-section-title">Type scale (plan 3.3)</h2>
    <div class="pv-type-demo">
      <div class="pv-type-title">Overview</div>
      <div class="pv-type-numeral">1,284</div>
      <div class="pv-type-body">Body copy at 13px/19.5px Inter, weight 400. This is the paragraph text every card, drawer and table cell in the console renders with, over the page canvas or a card surface.</div>
      <div class="pv-type-label">LABEL AND BUTTON TEXT, 12PX WEIGHT 600</div>
      <div class="pv-type-mono">req_8f2c1a4b0e -- mono ids, last4, hashes, request ids</div>
    </div>
  </div>

  <div>
    <h2 class="pv-section-title">Card, buttons, input</h2>
    <div class="pv-demo-card-wrap">
      <div class="card">
        <h3>Seats</h3>
        <div class="pv-type-numeral" style="margin: 8px 0;">142</div>
        <p class="pv-type-body">A card: --surface, 1px --border, --shadow, inset top highlight in light only.</p>
      </div>
      <div class="pv-group" style="display: grid; gap: 12px;">
        <div class="pv-row">
          <button type="button">Default</button>
          <button type="button" class="pv-demo-hover">Hover</button>
          <button type="button" class="pv-demo-focus">Focus</button>
          <button type="button" disabled>Disabled</button>
        </div>
        <div class="pv-row">
          <button type="button" class="primary">Primary</button>
          <button type="button" class="danger">Danger</button>
        </div>
        <input type="text" placeholder="Search seats, events" style="max-width: 260px;">
      </div>
    </div>
  </div>

  <div>
    <h2 class="pv-section-title">Table (4 rows)</h2>
    <table>
      <thead><tr><th>Country</th><th>Seats</th><th>Asks 24h</th><th>Status</th></tr></thead>
      <tbody>
        <tr><td>Canada</td><td>18</td><td>241</td><td><span class="status-dot status-dot-live"><i></i><span>Live</span></span></td></tr>
        <tr><td>United States</td><td>52</td><td>903</td><td><span class="status-dot status-dot-live"><i></i><span>Live</span></span></td></tr>
        <tr><td>France</td><td>6</td><td>74</td><td><span class="status-dot status-dot-idle"><i></i><span>Idle</span></span></td></tr>
        <tr><td>Germany</td><td>3</td><td>0</td><td><span class="status-dot status-dot-failed"><i></i><span>Failed</span></span></td></tr>
      </tbody>
    </table>
  </div>

  <div>
    <h2 class="pv-section-title">Status dots</h2>
    <div class="pv-status-list">
      <span class="status-dot status-dot-live"><i></i><span>Live, updated 3s ago</span></span>
      <span class="status-dot status-dot-idle"><i></i><span>Idle</span></span>
      <span class="status-dot status-dot-pending"><i></i><span>Pending approval</span></span>
      <span class="status-dot status-dot-failed"><i></i><span>Failed</span></span>
      <span class="status-dot status-dot-revoked"><i></i><span>Revoked</span></span>
    </div>
  </div>

  <div>
    <h2 class="pv-section-title">Data colours (plan 3.2: violet, blue, teal, amber)</h2>
    <div class="pv-bars">
      <div class="pv-bar-row"><span class="pv-type-mono">--data-1</span><div class="pv-bar-track"><div class="pv-bar-fill" style="width: 88%; background: var(--data-1);"></div></div></div>
      <div class="pv-bar-row"><span class="pv-type-mono">--data-2</span><div class="pv-bar-track"><div class="pv-bar-fill" style="width: 63%; background: var(--data-2);"></div></div></div>
      <div class="pv-bar-row"><span class="pv-type-mono">--data-3</span><div class="pv-bar-track"><div class="pv-bar-fill" style="width: 41%; background: var(--data-3);"></div></div></div>
      <div class="pv-bar-row"><span class="pv-type-mono">--data-4</span><div class="pv-bar-track"><div class="pv-bar-fill" style="width: 25%; background: var(--data-4);"></div></div></div>
    </div>
  </div>

  ${primitivesDemoHtml}
</div>
</body>
</html>
`
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const rawCss = await loadConsoleCss()
  const css = makeFontsStandalone(rawCss)
  const lightSectionsHtml = renderTokenSwatches(extractLightTokens(rawCss))
  const darkSectionsHtml = renderTokenSwatches(extractDarkTokens(rawCss))

  const [primitives, connectors, dataTable, icons] = await Promise.all([
    bundleRenderModule(join(OPERATOR_ROOT, 'src', 'render', 'primitives.ts')),
    bundleRenderModule(join(OPERATOR_ROOT, 'src', 'render', 'connectors-list.ts')),
    bundleRenderModule(join(OPERATOR_ROOT, 'src', 'render', 'data-table.ts')),
    bundleRenderModule(join(OPERATOR_ROOT, 'src', 'render', 'icons.ts'))
  ])
  const primitivesDemoHtml = renderPrimitivesDemo({ primitives, connectors, dataTable, icons })

  const lightPath = join(OUT_DIR, 'tokens-light.html')
  const darkPath = join(OUT_DIR, 'tokens-dark.html')
  writeFileSync(lightPath, makeAssetPathsStandalone(renderPage('light', lightSectionsHtml, css, primitivesDemoHtml)))
  writeFileSync(darkPath, makeAssetPathsStandalone(renderPage('dark', darkSectionsHtml, css, primitivesDemoHtml)))
  console.log(`preview-tokens: wrote ${lightPath}`)
  console.log(`preview-tokens: wrote ${darkPath}`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
