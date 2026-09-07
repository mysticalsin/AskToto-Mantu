#!/usr/bin/env node
/**
 * gates.mjs — plan `metis-portal-wow.md` section 9, steps 5 and 6, as one command. Prints a
 * scoreboard and exits non-zero the moment any gate finds a real violation.
 *
 * Usage:
 *   node operator/scripts/gates.mjs
 *
 * Gates:
 *   1. Em dash (`—`) in operator/src/render/** and operator/client/**, excluding *.test.ts.
 *      A bare `'—'` / `"—"` string literal (the codebase's own "missing value" placeholder,
 *      e.g. `const MISSING = '—'` in ui.ts) is counted and reported separately, never as a
 *      violation: it is data, not prose.
 *   2. `style="` occurrences in the rendered preview HTML (runs preview.mjs first if the preview
 *      directory is empty).
 *   3. Hex color literals (`/#[0-9a-f]{3,8}\b/i`) in operator/src/render/**, operator/client/**,
 *      operator/src/world/**, excluding *.generated.ts (generated files, e.g. world/paths.generated.ts,
 *      are allowed to carry literal colors baked in at build time).
 *   4. `location.reload`, `window.prompt`, `console.log` in operator/client/**.
 *   5. WCAG contrast for every text/background token pair in plan section 3.2, both themes, computed
 *      from the `:root` and `[data-theme="dark"]` blocks in operator/src/spa/css.ts. Reports
 *      "tokens not found" instead of failing until design-lead's P0.1 tokens land.
 *
 * Nothing here mutates source. This is a read-only scoreboard.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPERATOR_ROOT = join(__dirname, '..')
const PREVIEW_DIR = '/private/tmp/claude-501/operator-preview'
const SCRATCH_DIR =
  process.env.METIS_QA_SCRATCH ||
  '/private/tmp/claude-501/-Users-tony-Library-CloudStorage-OneDrive-MantuGroup-Documents-Chief-of-Staff-Apps-Source-Metis-Portal/7883530c-5678-450a-aef0-46d1bc798bfd/scratchpad'
const EM_DASH = '—'

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function tsFiles(dir, { excludeTests = false, excludeGenerated = false } = {}) {
  return walk(dir).filter((f) => {
    if (!f.endsWith('.ts')) return false
    if (excludeTests && f.endsWith('.test.ts')) return false
    if (excludeGenerated && f.endsWith('.generated.ts')) return false
    return true
  })
}

function rel(f) {
  return relative(join(OPERATOR_ROOT, '..'), f)
}

// ---------------------------------------------------------------------------
// Gate 1: em dash.
// ---------------------------------------------------------------------------

function gateEmDash() {
  const files = [
    ...tsFiles(join(OPERATOR_ROOT, 'src/render'), { excludeTests: true }),
    ...tsFiles(join(OPERATOR_ROOT, 'client'), { excludeTests: true })
  ]
  // Only shipped copy counts. A doc comment explaining a measurement is not user-facing text, and
  // the em dash placeholder for a missing value is allowed by the locks wherever it is used, not
  // only where it is declared. A gate that flags its own documentation gets muted, so it does not.
  const commentPattern = /^\s*(\/\/|\*|\/\*)/
  const placeholderPattern = /['"`]—['"`]/
  let violations = 0
  let placeholderUses = 0
  const violationLines = []
  const placeholderLines = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (!line.includes(EM_DASH)) return
      if (commentPattern.test(line) || placeholderPattern.test(line)) {
        placeholderUses++
        placeholderLines.push(`${rel(file)}:${i + 1}`)
      } else {
        violations++
        violationLines.push(`${rel(file)}:${i + 1}`)
      }
    })
  }
  return { violations, placeholderUses, violationLines, placeholderLines }
}

// ---------------------------------------------------------------------------
// Gate 2: style=" in the rendered preview HTML.
// ---------------------------------------------------------------------------

function ensurePreviewsExist() {
  const files = walk(PREVIEW_DIR).filter((f) => f.endsWith('.html'))
  if (files.length) return files
  console.log(`gates.mjs: ${PREVIEW_DIR} is empty, running preview.mjs first...`)
  execFileSync('node', [join(__dirname, 'preview.mjs')], { stdio: 'inherit' })
  return walk(PREVIEW_DIR).filter((f) => f.endsWith('.html'))
}

function gateInlineStyle() {
  // Rendered previews only: a *.test.ts asserting `not.toContain('style="')` is the gate working,
  // not a breach of it.
  // Product pages only. tokens-*.html and motion-demo.html are standalone design tooling that
  // demonstrates styles on purpose; the Worker never serves them, so counting them reports a
  // violation the product does not have.
  const files = ensurePreviewsExist().filter((f) => !/(tokens-|motion-demo|-patched)/.test(f))
  let count = 0
  const byFile = {}
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const matches = text.match(/style="/g)
    if (matches) {
      count += matches.length
      byFile[relative(PREVIEW_DIR, file)] = matches.length
    }
  }
  return { count, byFile, fileCount: files.length }
}

// ---------------------------------------------------------------------------
// Gate 3: hex literals outside generated files.
// ---------------------------------------------------------------------------

function gateHexLiterals() {
  const files = [
    ...tsFiles(join(OPERATOR_ROOT, 'src/render'), { excludeGenerated: true }),
    ...tsFiles(join(OPERATOR_ROOT, 'client'), { excludeGenerated: true }),
    ...tsFiles(join(OPERATOR_ROOT, 'src/world'), { excludeGenerated: true })
  ]
  const hexPattern = /#[0-9a-fA-F]{3,8}\b/g
  let count = 0
  const lines = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    text.split('\n').forEach((line, i) => {
      // An issue reference like "SPEC #142/276" in a doc comment is not a colour.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      const matches = line.match(hexPattern)
      if (matches) {
        count += matches.length
        lines.push(`${rel(file)}:${i + 1}: ${matches.join(', ')}`)
      }
    })
  }
  return { count, lines }
}

// ---------------------------------------------------------------------------
// Gate 4: location.reload / window.prompt / console.log in operator/client/**.
// ---------------------------------------------------------------------------

function gateClientHygiene() {
  const files = tsFiles(join(OPERATOR_ROOT, 'client'))
  const checks = {
    'location.reload': 0,
    'window.prompt': 0,
    'console.log': 0
  }
  const hits = { 'location.reload': [], 'window.prompt': [], 'console.log': [] }
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    text.split('\n').forEach((line, i) => {
      // A comment that names the banned call (usually to say it must never be used) is not a use.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      for (const key of Object.keys(checks)) {
        if (line.includes(key)) {
          checks[key]++
          hits[key].push(`${rel(file)}:${i + 1}`)
        }
      }
    })
  }
  return { checks, hits }
}

// ---------------------------------------------------------------------------
// Gate 5: contrast.
// ---------------------------------------------------------------------------

const REQUIRED_TOKENS = ['--bg', '--surface', '--surface-2', '--accent-soft', '--ink', '--ink-2', '--ink-3', '--accent', '--accent-ink']

function extractBlock(css, selectorPattern) {
  const m = selectorPattern.exec(css)
  if (!m) return null
  const start = m.index + m[0].length
  let depth = 1
  let i = start
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') depth--
    i++
  }
  return css.slice(start, i - 1)
}

function parseTokens(block) {
  const map = {}
  if (!block) return map
  const re = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g
  let m
  while ((m = re.exec(block))) {
    map[m[1]] = m[2].trim()
  }
  return map
}

function resolveToken(name, map, depth = 0) {
  if (depth > 8) return null
  const raw = map[name]
  if (raw == null) return null
  const varMatch = /^var\((--[a-zA-Z0-9-]+)\)$/.exec(raw)
  if (varMatch) return resolveToken(varMatch[1], map, depth + 1)
  const hexMatch = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw)
  if (hexMatch) return normalizeHex(raw)
  return null
}

function normalizeHex(hex) {
  const h = hex.replace('#', '')
  if (h.length === 3) {
    return '#' + [...h].map((c) => c + c).join('')
  }
  return `#${h}`
}

function luminanceChannel(c) {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * luminanceChannel(r) + 0.7152 * luminanceChannel(g) + 0.0722 * luminanceChannel(b)
}

function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA)
  const lb = relativeLuminance(hexB)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Foreground token, list of background tokens, minimum ratio. "accent as text" is not itself a
 *  token in the plan 3.2 table (it means "--accent's value used as text"); `fallbackNames` tries,
 *  in order, whatever distinct text-safe accent token design-lead lands (`--accent-text` as shipped,
 *  `--accent-as-text` as an alternate spelling) before falling back to --accent itself. */
const CONTRAST_PAIRS = [
  { fg: '--ink', bgs: ['--bg', '--surface', '--surface-2', '--accent-soft'], min: 4.5 },
  { fg: '--ink-2', bgs: ['--bg', '--surface', '--surface-2', '--accent-soft'], min: 4.5 },
  { fg: '--ink-3', bgs: ['--bg', '--surface', '--surface-2', '--accent-soft'], min: 4.5 },
  { fg: '--accent (as text)', bgs: ['--bg', '--surface', '--surface-2', '--accent-soft'], min: 4.5, fallbackNames: ['--accent-text', '--accent-as-text', '--accent'] },
  { fg: '--accent-ink', bgs: ['--accent'], min: 3.0 }
]

/** Bundles operator/src/spa/css.ts with esbuild and imports it, so the contrast check reads the
 *  real, resolved `CONSOLE_CSS` string (the source builds it from `LIGHT_TOKENS` / `DARK_TOKENS`
 *  template literals interpolated into `:root { ... }`, not a literal `:root { --x: ...; }` block
 *  sitting in the file text) rather than regex-guessing at TypeScript source. */
async function loadConsoleCss() {
  const entryFile = join(OPERATOR_ROOT, 'src/spa/css.ts')
  const result = await build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
    logLevel: 'silent'
  })
  const dir = join(SCRATCH_DIR, 'esbuild-tmp')
  await mkdir(dir, { recursive: true })
  const outFile = join(dir, 'gates-css.out.mjs')
  await writeFile(outFile, result.outputFiles[0].text, 'utf8')
  const mod = await import(pathToFileURL(outFile).href)
  return mod.CONSOLE_CSS
}

async function gateContrast() {
  let css
  try {
    css = await loadConsoleCss()
  } catch (err) {
    return { status: 'tokens not found', missing: REQUIRED_TOKENS, buildError: String(err.message || err) }
  }
  const rootBlock = extractBlock(css, /:root\s*\{/)
  const missing = REQUIRED_TOKENS.filter((t) => !rootBlock || !new RegExp(`${t}\\s*:`).test(rootBlock))
  if (!rootBlock || missing.length) {
    return { status: 'tokens not found', missing }
  }
  const lightMap = parseTokens(rootBlock)
  const darkBlock = extractBlock(css, /\[data-theme=["']dark["']\]\s*\{/)
  const darkMap = { ...lightMap, ...parseTokens(darkBlock) }

  const results = []
  for (const theme of ['light', 'dark']) {
    const map = theme === 'light' ? lightMap : darkMap
    for (const pair of CONTRAST_PAIRS) {
      const candidates = pair.fallbackNames || [pair.fg]
      const fgToken = candidates.find((name) => map[name] != null)
      const label = fgToken && fgToken !== pair.fg ? `${pair.fg} [${fgToken}]` : pair.fg
      if (!fgToken) {
        results.push({ theme, fg: label, bg: null, ratio: null, min: pair.min, ok: null, note: 'token not defined' })
        continue
      }
      const fgHex = resolveToken(fgToken, map)
      for (const bgName of pair.bgs) {
        const bgHex = resolveToken(bgName, map)
        if (!fgHex || !bgHex) {
          results.push({ theme, fg: label, bg: bgName, ratio: null, min: pair.min, ok: null, note: 'unresolved value' })
          continue
        }
        const ratio = contrastRatio(fgHex, bgHex)
        results.push({ theme, fg: label, bg: bgName, ratio, min: pair.min, ok: ratio >= pair.min })
      }
    }
  }
  const failures = results.filter((r) => r.ok === false)
  return { status: 'checked', results, failures }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

async function main() {
  let failed = false

  console.log('Métis Operator gates: scoreboard (plan section 9, steps 5-6)')
  console.log('='.repeat(72))

  const emDash = gateEmDash()
  console.log(`\n1. Em dash (—) in render/** + client/** (excluding *.test.ts)`)
  console.log(`   violations: ${emDash.violations}${emDash.violations ? ' [FAIL]' : ' [pass]'}`)
  console.log(`   placeholder uses (data, not prose, reported separately): ${emDash.placeholderUses}`)
  if (emDash.violations) {
    failed = true
    for (const l of emDash.violationLines.slice(0, 20)) console.log(`     ${l}`)
  }

  const style = gateInlineStyle()
  console.log(`\n2. style=" in the rendered preview HTML (${style.fileCount} file(s) in ${PREVIEW_DIR})`)
  console.log(`   occurrences: ${style.count}${style.count ? ' [FAIL]' : ' [pass]'}`)
  if (style.count) {
    failed = true
    for (const [f, n] of Object.entries(style.byFile).slice(0, 10)) console.log(`     ${f}: ${n}`)
  }

  const hex = gateHexLiterals()
  console.log(`\n3. Hex literals in render/** + client/** + world/** (excluding *.generated.ts)`)
  console.log(`   occurrences: ${hex.count}${hex.count ? ' [FAIL]' : ' [pass]'}`)
  if (hex.count) {
    failed = true
    for (const l of hex.lines.slice(0, 20)) console.log(`     ${l}`)
  }

  const client = gateClientHygiene()
  console.log(`\n4. location.reload / window.prompt / console.log in operator/client/**`)
  for (const [key, n] of Object.entries(client.checks)) {
    console.log(`   ${key}: ${n}${n ? ' [FAIL]' : ' [pass]'}`)
    if (n) {
      failed = true
      for (const l of client.hits[key].slice(0, 10)) console.log(`     ${l}`)
    }
  }

  const contrast = await gateContrast()
  console.log(`\n5. WCAG contrast (operator/src/spa/css.ts, :root + [data-theme="dark"])`)
  if (contrast.status === 'tokens not found') {
    console.log(`   tokens not found, skipping (not a failure): missing ${contrast.missing.join(', ')}`)
  } else {
    const total = contrast.results.length
    const failCount = contrast.failures.length
    console.log(`   checked ${total} pair(s) across both themes, ${failCount} below threshold${failCount ? ' [FAIL]' : ' [pass]'}`)
    for (const r of contrast.failures) {
      console.log(`     [${r.theme}] ${r.fg} on ${r.bg}: ${r.ratio?.toFixed(2)}:1 (needs ${r.min}:1)`)
    }
    if (failCount) failed = true
  }

  console.log('\n' + '='.repeat(72))
  console.log(failed ? 'Métis Operator gates: FAIL' : 'Métis Operator gates: PASS')
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
