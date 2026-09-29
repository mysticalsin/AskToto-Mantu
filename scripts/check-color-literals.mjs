#!/usr/bin/env node
/**
 * Renderer colour discipline (M2-0411).
 *
 * `src/renderer/src/tokens.css` is the one place colour, spacing and radius custom properties are
 * defined, and hex colour literals are a ratchet everywhere else:
 *
 *   - no `.css` file other than tokens.css may declare a design-token custom property
 *     (--color-*, --cl-*, --aw-*, --pass-*, --glass-*, --space-*, --radius-*, --shadow-*, --blur-*);
 *   - the number of lines carrying a hex colour literal in each renderer `.css` / `.tsx` file (tokens.css and
 *     tests excluded) may not exceed scripts/color-literal-baseline.json, and a file that drops below its
 *     baseline must lower it, so the count only ever moves down;
 *   - no stylesheet under the renderer may exceed MAX_STYLESHEET_LINES.
 *
 * Run: `node scripts/check-color-literals.mjs` (`--write` regenerates the baseline after a reduction).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MAX_STYLESHEET_LINES = 800
export const TOKENS_FILE = 'src/renderer/src/tokens.css'
const RENDERER_DIR = 'src/renderer/src'
const BASELINE_FILE = 'scripts/color-literal-baseline.json'
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/
const TOKEN_DECLARATION = /(?:^|[{;])\s*--(?:color|cl|aw|pass|glass|space|radius|shadow|blur)-[\w-]+\s*:/

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Lines of `text` that carry a hex colour literal. */
export function countHexLines(text) {
  return text.split('\n').filter((line) => HEX_LITERAL.test(line)).length
}

/** 1-based numbers of lines that declare a design-token custom property. */
export function tokenDeclarationLines(text) {
  const lines = []
  text.split('\n').forEach((line, index) => {
    if (TOKEN_DECLARATION.test(line)) lines.push(index + 1)
  })
  return lines
}

/**
 * @param {Array<{ path: string, text: string }>} files renderer .css/.tsx sources, repo-relative posix paths
 * @param {Record<string, number>} baseline hex-literal line count allowed per file
 * @returns {string[]} human-readable violations, empty when the tree is clean
 */
export function findViolations(files, baseline) {
  const violations = []
  const seen = new Set()
  for (const { path, text } of files) {
    if (path === TOKENS_FILE) continue
    seen.add(path)
    if (path.endsWith('.css')) {
      const declared = tokenDeclarationLines(text)
      if (declared.length > 0) {
        violations.push(`${path}: declares design tokens outside tokens.css (line ${declared.join(', ')})`)
      }
      const lineCount = text.replace(/\n$/, '').split('\n').length
      if (lineCount > MAX_STYLESHEET_LINES) {
        violations.push(`${path}: ${lineCount} lines exceeds the ${MAX_STYLESHEET_LINES}-line stylesheet limit`)
      }
    }
    const count = countHexLines(text)
    const allowed = baseline[path] ?? 0
    if (count > allowed) {
      violations.push(`${path}: ${count} hex colour literal line(s), baseline ${allowed} — use a token from tokens.css`)
    } else if (count < allowed) {
      violations.push(`${path}: ${count} hex colour literal line(s), baseline ${allowed} — lower it in ${BASELINE_FILE}`)
    }
  }
  for (const path of Object.keys(baseline)) {
    if (!seen.has(path)) violations.push(`${path}: listed in ${BASELINE_FILE} but no longer exists — remove it`)
  }
  return violations
}

function isCheckedSource(name) {
  return (name.endsWith('.css') || name.endsWith('.tsx')) && !/\.(test|spec|browser\.test)\.tsx$/.test(name)
}

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (isCheckedSource(entry.name)) {
      out.push({ path: relative(repoRoot, full).split(sep).join('/'), text: readFileSync(full, 'utf8').replace(/\r\n/g, '\n') })
    }
  }
  return out
}

export function scanRenderer() {
  return collect(join(repoRoot, RENDERER_DIR))
}

function main() {
  const files = scanRenderer()
  if (process.argv.includes('--write')) {
    const baseline = {}
    for (const { path, text } of files) {
      if (path === TOKENS_FILE) continue
      const count = countHexLines(text)
      if (count > 0) baseline[path] = count
    }
    const sorted = Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(join(repoRoot, BASELINE_FILE), `${JSON.stringify(sorted, null, 2)}\n`)
    console.log(`wrote ${BASELINE_FILE}`)
    return
  }
  const baseline = JSON.parse(readFileSync(join(repoRoot, BASELINE_FILE), 'utf8'))
  const violations = findViolations(files, baseline)
  if (violations.length > 0) {
    console.error(violations.map((v) => `  ✗ ${v}`).join('\n'))
    process.exit(1)
  }
  const total = Object.values(baseline).reduce((sum, n) => sum + n, 0)
  console.log(`color literals: ${total} hex line(s) across ${Object.keys(baseline).length} file(s), all within baseline`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
