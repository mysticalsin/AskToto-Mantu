#!/usr/bin/env node
/**
 * Builds every static asset operator/src/spa/css.ts references and Workers Static Assets
 * serves under /assets/fonts/*, /assets/flags/*, /assets/logos/* (plan D5, B8, 3.3, 3.6).
 *
 * 1. Fonts: copies the latin variable woff2 of @fontsource-variable/space-grotesk and
 *    @fontsource-variable/inter into operator/public/fonts/ with a content-hashed name, and
 *    writes operator/src/spa/fonts.generated.ts so css.ts can reference the real file names.
 *    If either package is missing (offline install), no font files are written and
 *    fonts.generated.ts exports `fileName: null` for that font -- css.ts falls back to the
 *    system stack rather than ever pointing at a CDN (plan lock 8).
 * 2. Flags: copies every 4x3 SVG from flag-icons into operator/public/flags/<code>.svg.
 * 3. Logos: for every connector kind in operator/src/connectors/logo-slugs.ts, writes
 *    operator/public/logos/<kind>.svg -- the real brand mark (simple-icons path, brand hex as
 *    `fill`) when the slug exists in the installed simple-icons version, otherwise a generated
 *    monogram (first letter of the label, 600 weight, --accent-soft square, --accent ink).
 *    Exits non-zero if a kind has neither a resolvable slug nor a label to build a monogram
 *    from (should never happen -- every kind in the map has a label).
 * 4. Contrast gate: checks the real text/background pairs the token sheet (plan 3.2, css.ts)
 *    puts on screen against WCAG AA (4.5:1, 3:1 only for text actually rendered at 18px+).
 *    Fails the build on any pair below its threshold, except the two pairs the plan itself
 *    already documents as an accepted trade-off (see CONTRAST_ADVISORY below) -- those are
 *    printed as a warning, never silently hidden, never a hard failure.
 *
 * Run directly: `node operator/scripts/build-assets.mjs`.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPERATOR_ROOT = join(__dirname, '..')
const REPO_ROOT = join(OPERATOR_ROOT, '..')
const PUBLIC_DIR = join(OPERATOR_ROOT, 'public')
const FONTS_OUT_DIR = join(PUBLIC_DIR, 'fonts')
const FLAGS_OUT_DIR = join(PUBLIC_DIR, 'flags')
const LOGOS_OUT_DIR = join(PUBLIC_DIR, 'logos')
/** Source input (not generated): drop an official brand SVG here and it wins over the
 *  generated brand/monogram logo for that kind. See copyBrandOverrides() and the README next
 *  to this directory. */
const LOGOS_BRAND_DIR = join(OPERATOR_ROOT, 'assets', 'logos-brand')
const FONTS_GENERATED_FILE = join(OPERATOR_ROOT, 'src', 'spa', 'fonts.generated.ts')

const require = createRequire(import.meta.url)

function ensureEmptyDir(dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

function contentHash8(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 8)
}

// -- 1. Fonts --------------------------------------------------------------

/** Latin-only variable-weight woff2 for each family (see @fontsource-variable's own index.css:
 *  the `-latin-wght-normal` file is the plain weight-axis latin subset, no optical-size split). */
const FONT_SOURCES = [
  {
    key: 'spaceGrotesk',
    pkg: '@fontsource-variable/space-grotesk',
    file: 'files/space-grotesk-latin-wght-normal.woff2',
    family: 'Space Grotesk Variable',
    weightRange: '300 700',
    outBase: 'space-grotesk-variable'
  },
  {
    key: 'inter',
    pkg: '@fontsource-variable/inter',
    file: 'files/inter-latin-wght-normal.woff2',
    family: 'Inter Variable',
    weightRange: '100 900',
    outBase: 'inter-variable'
  }
]

function resolveFontFile(source) {
  try {
    const pkgJsonPath = require.resolve(`${source.pkg}/package.json`)
    const pkgDir = dirname(pkgJsonPath)
    const filePath = join(pkgDir, source.file)
    if (!existsSync(filePath)) return null
    return filePath
  } catch {
    return null
  }
}

function buildFonts() {
  mkdirSync(FONTS_OUT_DIR, { recursive: true })
  const generated = []
  const report = []
  for (const source of FONT_SOURCES) {
    const filePath = resolveFontFile(source)
    if (!filePath) {
      report.push(`  ${source.family}: NOT FOUND (${source.pkg} not installed) -- css.ts falls back to the system stack`)
      generated.push({ ...source, fileName: null, bytes: 0 })
      continue
    }
    const buf = readFileSync(filePath)
    const hash = contentHash8(buf)
    const fileName = `${source.outBase}-${hash}.woff2`
    writeFileSync(join(FONTS_OUT_DIR, fileName), buf)
    report.push(`  ${source.family}: ${fileName} (${buf.length} bytes)`)
    generated.push({ ...source, fileName, bytes: buf.length })
  }
  writeFileSync(FONTS_GENERATED_FILE, renderFontsGeneratedFile(generated))
  return report
}

function renderFontsGeneratedFile(generated) {
  const entries = generated
    .map(
      (f) => `  ${f.key}: {
    family: ${JSON.stringify(f.family)},
    weightRange: ${JSON.stringify(f.weightRange)},
    fileName: ${f.fileName ? JSON.stringify(f.fileName) : 'null'}
  }`
    )
    .join(',\n')
  return `/**
 * GENERATED FILE. Do not edit by hand.
 * Run \`node operator/scripts/build-assets.mjs\` to regenerate.
 * Latin variable woff2 files copied from @fontsource-variable/{space-grotesk,inter} into
 * operator/public/fonts/ with a content-hashed name (plan 3.3, D5). A null fileName means the
 * package was not installed at build time; css.ts falls back to the system stack for that
 * family rather than ever loading a CDN font (plan lock 8).
 */

export interface GeneratedFont {
  family: string
  weightRange: string
  fileName: string | null
}

export const GENERATED_FONTS: { spaceGrotesk: GeneratedFont; inter: GeneratedFont } = {
${entries}
}
`
}

// -- 2. Flags ----------------------------------------------------------------

function buildFlags() {
  ensureEmptyDir(FLAGS_OUT_DIR)
  let flagsDir
  try {
    const pkgJsonPath = require.resolve('flag-icons/package.json')
    flagsDir = join(dirname(pkgJsonPath), 'flags', '4x3')
  } catch {
    return ['  flag-icons not installed -- no flags copied']
  }
  const files = readdirSync(flagsDir).filter((f) => f.endsWith('.svg'))
  for (const file of files) {
    writeFileSync(join(FLAGS_OUT_DIR, file), readFileSync(join(flagsDir, file)))
  }
  return [`  ${files.length} flag SVGs copied from flag-icons (4x3)`]
}

// -- 3. Connector logos --------------------------------------------------------

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** First letter of the label, uppercased. Never fabricated -- the same letter a person would
 *  read off the label themselves. */
function monogramLetter(label) {
  const trimmed = label.trim()
  return trimmed ? trimmed[0].toUpperCase() : '?'
}

/**
 * Real, publicly documented brand colours for the connector kinds Simple Icons dropped (Tony,
 * 2026-09-06: "make monograms good"). Best-effort at the time this was written -- Tony can
 * override any of these (or any brand logo at all) by dropping the vendor's own SVG in
 * operator/assets/logos-brand/<kind>.svg, which build-assets.mjs always prefers (see
 * copyBrandOverrides() below). custom-mcp / custom-rest have no real brand, so they keep the
 * original --accent-soft / --accent monogram instead of a fabricated "brand colour".
 *
 * Four of these (salesforce, pipedrive, monday, freshdesk) are darkened from the literal,
 * commonly-cited brand hex: the literal value is too light for a legible white 600-weight
 * initial (white-on-fill measured 2.4-3.5:1, under WCAG AA's 4.5:1). Each is darkened by the
 * smallest amount that clears 4.5:1, same hue, same brand family -- not a different colour, a
 * readable shade of the same one. The other six pass at the literal brand hex already.
 */
const MONOGRAM_BRAND_COLORS = {
  salesforce: '#007EAF', // literal #00A1E0 is 2.93:1 with white; darkened 22% -> 4.56:1
  pipedrive: '#1A8757', // literal #24BC79 is 2.46:1 with white; darkened 28% -> 4.52:1
  dynamics365: '#0078D4',
  attio: '#1A1B25',
  close: '#1D2138',
  monday: '#DB344B', // literal #FF3D57 is 3.47:1 with white; darkened 14% -> 4.56:1
  freshdesk: '#1A874E', // literal #25C16F is 2.35:1 with white; darkened 30% -> 4.55:1
  sharepoint: '#038387',
  slack: '#4A154B',
  microsoftteams: '#6264A7'
}

/** Plan 3.6 / P0.3 brief / Tony 2026-09-06 ("make monograms good"): a rounded square, 6px
 *  radius. A kind with a real, documented brand colour (MONOGRAM_BRAND_COLORS) gets that colour
 *  with a white 600-weight initial; a kind with no real brand (custom-mcp, custom-rest) keeps
 *  the original --accent-soft background with --accent ink. Generated, not hand-drawn -- literal
 *  hex here is either the token sheet's own light values or a documented brand colour, baked
 *  into a static asset file (not operator/src/spa/css.ts), so the "no hex outside the token
 *  blocks" gate does not apply to this generated-SVG script. */
function monogramSvg(label, kind) {
  const letter = monogramLetter(label)
  const brand = kind ? MONOGRAM_BRAND_COLORS[kind] : undefined
  const bg = brand || '#f1e6fb'
  const ink = brand ? '#ffffff' : '#7f00da'
  return `<svg role="img" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><title>${escapeXml(label)}</title><rect width="32" height="32" rx="6" fill="${bg}"/><text x="16" y="21" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="600" fill="${ink}" text-anchor="middle">${escapeXml(letter)}</text></svg>`
}

function brandSvg(icon) {
  return `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>${escapeXml(icon.title)}</title><path fill="#${icon.hex}" d="${icon.path}"/></svg>`
}

async function loadSimpleIconsBySlug() {
  try {
    const mod = await import('simple-icons')
    const icons = mod.default ?? mod
    const bySlug = new Map()
    for (const value of Object.values(icons)) {
      if (value && typeof value === 'object' && typeof value.slug === 'string') {
        bySlug.set(value.slug, value)
      }
    }
    return bySlug
  } catch {
    return new Map()
  }
}

async function buildLogos() {
  ensureEmptyDir(LOGOS_OUT_DIR)
  const shared = await import(pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'operator-connectors.ts')).href).catch(
    () => readSharedConnectorsSource()
  )
  const { LOGO_SLUGS } = await import(
    pathToFileURL(join(OPERATOR_ROOT, 'src', 'connectors', 'logo-slugs.ts')).href
  ).catch(() => readLogoSlugsSource())
  const CONNECTOR_KINDS = shared.CONNECTOR_KINDS
  const CONNECTOR_CATALOG_CORE = shared.CONNECTOR_CATALOG_CORE
  const bySlug = await loadSimpleIconsBySlug()
  const report = []
  let brandCount = 0
  let monogramCount = 0
  // The shared catalog core (src/shared/operator-connectors.ts) is the canonical kind list --
  // every kind in it must resolve to a LOGO_SLUGS entry (a string slug or an explicit null for
  // "no brand, always monogram"). A kind missing from LOGO_SLUGS entirely is a real gap, not an
  // intentional monogram, so it fails the build rather than silently falling back to a monogram.
  for (const kind of CONNECTOR_KINDS) {
    if (!(kind in LOGO_SLUGS)) {
      console.error(`build-assets: connector kind "${kind}" (from src/shared/operator-connectors.ts) has no entry in operator/src/connectors/logo-slugs.ts's LOGO_SLUGS`)
      process.exit(1)
    }
    const label = CONNECTOR_CATALOG_CORE[kind]?.label ?? kind
    const slug = LOGO_SLUGS[kind]
    const icon = slug ? bySlug.get(slug) : undefined
    const svg = icon ? brandSvg(icon) : monogramSvg(label, kind)
    writeFileSync(join(LOGOS_OUT_DIR, `${kind}.svg`), svg)
    if (icon) {
      brandCount++
    } else {
      monogramCount++
      report.push(`  ${kind}: monogram (no simple-icons entry for slug ${JSON.stringify(slug)})`)
    }
  }
  const overridden = copyBrandOverrides(CONNECTOR_KINDS)
  for (const kind of overridden) report.push(`  ${kind}: overridden by operator/assets/logos-brand/${kind}.svg`)
  report.unshift(`  ${brandCount} brand logos + ${monogramCount} monograms (${overridden.length} overridden) = ${CONNECTOR_KINDS.length} total`)
  return report
}

/**
 * Plan brief (Tony, 2026-09-06): "add an override path... so Tony can drop official brand SVGs
 * in and they win." Any file at operator/assets/logos-brand/<kind>.svg is copied verbatim over
 * the generated logo for that kind, after every brand/monogram logo above has already been
 * written -- so an override always wins regardless of whether Simple Icons had that slug.
 */
function copyBrandOverrides(kinds) {
  const overridden = []
  for (const kind of kinds) {
    const overridePath = join(LOGOS_BRAND_DIR, `${kind}.svg`)
    if (existsSync(overridePath)) {
      writeFileSync(join(LOGOS_OUT_DIR, `${kind}.svg`), readFileSync(overridePath))
      overridden.push(kind)
    }
  }
  return overridden
}

/** Fallback reader for src/shared/operator-connectors.ts, used only if a future Node/loader
 *  combination cannot import the .ts module directly (see buildLogos above). Parses
 *  CONNECTOR_KINDS (a string array literal) and CONNECTOR_CATALOG_CORE's per-kind `label` field
 *  out of the source text with narrow, well-tested regexes rather than a full TS parser. */
function readSharedConnectorsSource() {
  const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'operator-connectors.ts'), 'utf8')
  const kindsMatch = src.match(/export const CONNECTOR_KINDS = \[([\s\S]*?)\] as const/)
  if (!kindsMatch) throw new Error('build-assets: could not find CONNECTOR_KINDS in src/shared/operator-connectors.ts')
  const CONNECTOR_KINDS = [...kindsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  const CONNECTOR_CATALOG_CORE = {}
  for (const kind of CONNECTOR_KINDS) {
    const entryMatch = src.match(new RegExp(`['"]?${kind}['"]?:\\s*\\{([\\s\\S]*?)\\n  \\}`))
    const labelMatch = entryMatch && entryMatch[1].match(/label:\s*'([^']*)'/)
    CONNECTOR_CATALOG_CORE[kind] = { label: labelMatch ? labelMatch[1] : kind }
  }
  return { CONNECTOR_KINDS, CONNECTOR_CATALOG_CORE }
}

/** Fallback reader for operator/src/connectors/logo-slugs.ts, used only if a future Node/loader
 *  combination cannot import the .ts module directly (see buildLogos above). Parses the
 *  LOGO_SLUGS object literal out of the source text with a narrow, well-tested regex rather
 *  than a full TS parser -- this file's shape is owned by this same task, so the format is
 *  stable. */
function readLogoSlugsSource() {
  const src = readFileSync(join(OPERATOR_ROOT, 'src', 'connectors', 'logo-slugs.ts'), 'utf8')
  const marker = 'export const LOGO_SLUGS'
  const start = src.indexOf(marker)
  if (start < 0) throw new Error('build-assets: could not find LOGO_SLUGS in logo-slugs.ts')
  const braceStart = src.indexOf('{', start)
  const braceEnd = src.indexOf('\n}', braceStart)
  const body = src.slice(braceStart + 1, braceEnd)
  const LOGO_SLUGS = {}
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*(?:'([^']+)'|([a-zA-Z0-9_-]+)):\s*(null|'[^']*')/)
    if (!m) continue
    const key = m[1] ?? m[2]
    const rawValue = m[3]
    LOGO_SLUGS[key] = rawValue === 'null' ? null : rawValue.slice(1, -1)
  }
  return { LOGO_SLUGS }
}

// -- 4. Contrast gate --------------------------------------------------------

function hexToRgb(hex) {
  const clean = hex.replace('#', '')
  const num = parseInt(clean, 16)
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
}

function srgbToLinear(c) {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(hexA, hexB) {
  const a = relativeLuminance(hexA)
  const b = relativeLuminance(hexB)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Mirrors operator/src/spa/css.ts's two token blocks (plan 3.2). Duplicated here on purpose:
 *  this is a plain Node script, not a TypeScript loader, and the token sheet is small enough
 *  that keeping a literal copy for the contrast gate is simpler and more auditable than parsing
 *  css.ts's template string. If css.ts's tokens move, update this table in the same commit. */
const THEMES = {
  light: {
    bg: '#f8f6fd', surface: '#ffffff', surface2: '#f5f1fc',
    ink: '#170826', ink2: '#5c5273', ink3: '#66607d',
    accentFill: '#7f00da', accentInk: '#ffffff', accentSoft: '#f1e6fb', accentText: '#7f00da'
  },
  dark: {
    bg: '#0b0813', surface: '#120e1c', surface2: '#1a1526',
    ink: '#f3eefb', ink2: '#a99fc0', ink3: '#89809e',
    accentFill: '#8a2be2', accentInk: '#ffffff', accentSoft: '#231437', accentText: '#b98cff'
  }
}

/** Real text/background pairs the token sheet puts on screen, with the WCAG threshold that
 *  actually applies given the type scale (plan 3.3): everything here renders well under 18px,
 *  so every pair needs 4.5:1, never the 3:1 large-text exemption. Includes every surface a
 *  caption or label can sit on, --accent-soft included (QA's gates.mjs caught ink3-on-accentSoft
 *  missing from an earlier version of this list -- accent-soft is lighter than surface2 in dark
 *  mode, so it is the hardest background to clear, not an edge case to skip). --accent-ink on
 *  --accent-fill is a hard failure here too, not an advisory: the roles were split 2026-09-06
 *  specifically so button/badge fills always clear AA (plan --accent itself stays reserved for
 *  rings and selected states, never paired with --accent-ink text). */
const CONTRAST_PAIRS = [
  ['ink', 'bg', 'body text on the page canvas'],
  ['ink', 'surface', 'body text on cards'],
  ['ink2', 'bg', 'secondary text/labels on the page canvas'],
  ['ink2', 'surface', 'secondary text/labels on cards'],
  ['ink3', 'bg', 'captions on the page canvas'],
  ['ink3', 'surface', 'captions on cards'],
  ['ink3', 'surface2', 'captions on nested cards'],
  ['ink3', 'accentSoft', 'captions on an accent chip background'],
  ['accentText', 'bg', 'links/active nav text on the page canvas'],
  ['accentText', 'surface', 'links/active nav text on cards'],
  ['accentText', 'accentSoft', 'active nav text on its own chip background'],
  ['accentInk', 'accentFill', 'button/badge label on its own fill']
]

function checkContrast() {
  const failures = []
  for (const [themeName, tokens] of Object.entries(THEMES)) {
    for (const [fgKey, bgKey, note] of CONTRAST_PAIRS) {
      const ratio = contrastRatio(tokens[fgKey], tokens[bgKey])
      if (ratio < 4.5) {
        failures.push(`${themeName}: ${fgKey} (${tokens[fgKey]}) on ${bgKey} (${tokens[bgKey]}) = ${ratio.toFixed(2)}:1 -- ${note}`)
      }
    }
  }
  return { failures }
}

// -- main ---------------------------------------------------------------------

async function main() {
  console.log('build-assets: fonts')
  for (const line of buildFonts()) console.log(line)

  console.log('build-assets: flags')
  for (const line of buildFlags()) console.log(line)

  console.log('build-assets: logos')
  for (const line of await buildLogos()) console.log(line)

  console.log('build-assets: contrast gate (WCAG AA, 4.5:1)')
  const { failures } = checkContrast()
  if (failures.length > 0) {
    console.error('build-assets: contrast gate failed')
    for (const f of failures) console.error(`  FAIL: ${f}`)
    process.exit(1)
  }
  console.log('  all curated text/background pairs pass 4.5:1 in both themes')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

export { buildFonts, buildFlags, buildLogos, checkContrast, contrastRatio }
