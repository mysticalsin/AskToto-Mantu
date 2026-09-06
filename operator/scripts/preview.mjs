#!/usr/bin/env node
/**
 * preview.mjs — renders `renderConsole(fixtureDashboard(), { theme })` (the real render path, the
 * real fixture, no hand written HTML) to a standalone file that opens in any browser with no
 * Worker, no D1 and no Cloudflare Access in front of it.
 *
 * Usage:
 *   node operator/scripts/preview.mjs                       every nav page, both themes
 *   node operator/scripts/preview.mjs --page overview        one page, both themes
 *   node operator/scripts/preview.mjs --page overview --theme dark
 *
 * Output: /private/tmp/claude-501/operator-preview/<page>-<theme>.html (plan section 8, "Section
 * review cadence": this exact path is the one every agent and the orchestrator use).
 *
 * How it works: the Worker source (operator/src/**) is plain TypeScript with no bundler step of
 * its own for the server render path, so this script bundles a tiny virtual entry that re-exports
 * `renderConsole`, `fixtureDashboard`, `NAV_IDS`, `SPA_JS` and `SPA_CSS` with esbuild (already a
 * transitive devDependency here, the same one operator/scripts/build-client.mjs uses) and dynamic
 * `import()`s the bundle. Nothing here re-implements render logic: it calls the real functions.
 *
 * The CSS `<link>` and JS `<script src>` tags renderConsole emits point at `/assets/...`, which
 * does not exist on disk: this script inlines the actual CSS/JS text instead, and sets
 * `location.hash` to the requested page so the client router shows the right section the moment
 * the file is opened (the server also patches the `hidden` attribute directly, so the right
 * section is visible even with JavaScript disabled).
 */
import { build } from 'esbuild'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPERATOR_ROOT = join(__dirname, '..')
const SCRATCH_DIR =
  process.env.METIS_QA_SCRATCH ||
  '/private/tmp/claude-501/-Users-tony-Library-CloudStorage-OneDrive-MantuGroup-Documents-Chief-of-Staff-Apps-Source-Metis-Portal/7883530c-5678-450a-aef0-46d1bc798bfd/scratchpad'
const OUT_DIR = '/private/tmp/claude-501/operator-preview'
const PUBLIC_FONTS_DIR = join(OPERATOR_ROOT, 'public', 'fonts')

async function bundleAndImport(virtualEntrySource, tag) {
  const dir = join(SCRATCH_DIR, 'esbuild-tmp')
  await mkdir(dir, { recursive: true })
  const entryFile = join(dir, `${tag}.entry.mjs`)
  await writeFile(entryFile, virtualEntrySource, 'utf8')
  const result = await build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
    logLevel: 'silent'
  })
  const outFile = join(dir, `${tag}.out.mjs`)
  await writeFile(outFile, result.outputFiles[0].text, 'utf8')
  return import(pathToFileURL(outFile).href)
}

async function loadOperatorModule() {
  const uiPath = join(OPERATOR_ROOT, 'src/ui.ts').replace(/\\/g, '/')
  const fixturePath = join(OPERATOR_ROOT, 'src/render/fixture.ts').replace(/\\/g, '/')
  const navPath = join(OPERATOR_ROOT, 'src/nav.ts').replace(/\\/g, '/')
  const manifestPath = join(OPERATOR_ROOT, 'src/spa/manifest.ts').replace(/\\/g, '/')
  const entry = `
    export { renderConsole } from ${JSON.stringify(uiPath)}
    export { fixtureDashboard } from ${JSON.stringify(fixturePath)}
    export { NAV_IDS } from ${JSON.stringify(navPath)}
    export { SPA_CSS, SPA_JS } from ${JSON.stringify(manifestPath)}
  `
  return bundleAndImport(entry, 'preview-operator')
}

/** Rewrite `/assets/fonts|flags|logos/<file>` references to an absolute `file://` path when that
 *  file already exists under operator/public/ (plan: "referenced by absolute file:// path when
 *  present" — none of these are wired into css.ts yet at the time this script was written, so this
 *  is a no-op today and starts working the moment design-lead lands the @font-face rule). */
function rewriteLocalAssetUrls(html) {
  return html.replace(/(["'(])\/assets\/(fonts|flags|logos)\/([^"')]+)(["')])/g, (whole, open, kind, file, close) => {
    const abs = join(OPERATOR_ROOT, 'public', kind, file)
    if (!existsSync(abs)) return whole
    return `${open}${pathToFileURL(abs).href}${close}`
  })
}

/** Inline the hashed CSS `<link>` and JS `<script src>` tags renderConsole emits, since a
 *  standalone file has no Worker behind `/assets/...` to serve them from. */
function inlineAssets(html, css, js) {
  const withCss = html.replace(/<link rel="stylesheet"[^>]*>/, `<style>\n${css}\n</style>`)
  return withCss.replace(/<script src="\/assets\/[^"]+"[^>]*><\/script>/, `<script>\n${js}\n</script>`)
}

/** Make `page` the one visible `data-page` section (server side, works even without JS), and
 *  inject a `location.hash` setter so the router (once its script runs) agrees. */
function selectPage(html, page) {
  let out = html.replace(/(<section class="page wrap" data-page="([a-z]+)")([^>]*)>/g, (whole, head, id, rest) => {
    // `\s+hidden\b` (whitespace required before "hidden") so this never touches `aria-hidden`.
    const withoutHidden = rest.replace(/\s+hidden\b(=("|')[^"']*\2)?/g, '')
    return id === page ? `${head}${withoutHidden}>` : `${head}${withoutHidden} hidden>`
  })
  out = out.replace('<body>', `<body>\n<script>location.hash = ${JSON.stringify(`#${page}`)};</script>`)
  return out
}

function parseArgs(argv) {
  const out = { page: null, theme: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--page') out.page = argv[++i]
    else if (argv[i] === '--theme') out.theme = argv[++i]
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const mod = await loadOperatorModule()
  const pages = args.page ? [args.page] : mod.NAV_IDS
  const themes = args.theme ? [args.theme] : ['light', 'dark']
  if (args.page && !mod.NAV_IDS.includes(args.page)) {
    console.error(`preview.mjs: unknown page "${args.page}". Known pages: ${mod.NAV_IDS.join(', ')}`)
    process.exit(1)
  }
  await mkdir(OUT_DIR, { recursive: true })

  const written = []
  for (const theme of themes) {
    const dashboard = await mod.fixtureDashboard()
    const rendered = mod.renderConsole(dashboard, { theme })
    for (const page of pages) {
      let html = selectPage(rendered, page)
      html = inlineAssets(html, mod.SPA_CSS, mod.SPA_JS)
      html = rewriteLocalAssetUrls(html)
      const outPath = join(OUT_DIR, `${page}-${theme}.html`)
      await writeFile(outPath, html, 'utf8')
      written.push(outPath)
    }
  }

  console.log(`Métis Operator preview: wrote ${written.length} file(s) to ${OUT_DIR}`)
  for (const f of written) console.log(`  ${f}`)

  const existing = await readdir(PUBLIC_FONTS_DIR).catch(() => [])
  if (existing.length) {
    console.log(`preview.mjs: found ${existing.length} font file(s) in ${PUBLIC_FONTS_DIR}; will be inlined as file:// once css.ts references them.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
