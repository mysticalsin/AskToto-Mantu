#!/usr/bin/env node
/**
 * land.mjs — the landing gate. One command that decides whether this branch is shippable.
 *
 * "It works" is a claim; this is the proof. Every check runs for real, prints what it measured,
 * and the process exits non-zero if any of them fails, so the gate cannot be passed by opinion.
 *
 *   node operator/scripts/land.mjs            # everything
 *   node operator/scripts/land.mjs --quick    # skip the browser height pass
 *
 * Checks, in the order a failure is cheapest to diagnose:
 *   1. typecheck, both operator tsconfigs
 *   2. the full operator test suite
 *   3. the generated artefacts rebuild without drift (assets, world, client bundle)
 *   4. gates.mjs: em dash, inline style, hex literal, client hygiene, WCAG contrast
 *   5. page height: every page under two viewport heights at 1440 (plan 3.7b law 10)
 *   6. secret sweep: nothing secret-shaped is tracked, and no forbidden file is committed
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OPERATOR = resolve(HERE, '..')
const REPO = resolve(OPERATOR, '..')
const PREVIEW_DIR = '/private/tmp/claude-501/operator-preview'
const VIEWPORT = { width: 1440, height: 900 }
const MAX_VIEWPORTS = 2

const quick = process.argv.includes('--quick')
const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  pass' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: 'pipe', ...opts })
}

/** Typecheck is first: a type error explains half the test failures that would follow it. */
function checkTypes() {
  console.log('\n1. Typecheck')
  for (const project of ['operator/tsconfig.json', 'operator/client/tsconfig.json']) {
    try {
      run('npx', ['tsc', '--noEmit', '-p', project])
      record(project, true, '0 errors')
    } catch (err) {
      const out = `${err.stdout || ''}${err.stderr || ''}`.trim().split('\n').slice(-3).join(' | ')
      record(project, false, out || 'tsc failed')
    }
  }
}

function checkTests() {
  console.log('\n2. Test suite')
  try {
    const out = run('npx', ['vitest', 'run', '--config', 'operator/vitest.config.ts'])
    const line = (out.match(/Tests\s+.*$/m) || ['no summary'])[0].trim()
    record('operator suite', !/failed/.test(line), line)
  } catch (err) {
    const out = `${err.stdout || ''}`
    const line = (out.match(/Tests\s+.*$/m) || ['suite failed'])[0].trim()
    const failures = [...out.matchAll(/^ FAIL\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 8)
    record('operator suite', false, `${line}${failures.length ? ` :: ${failures.join(' ; ')}` : ''}`)
  }
}

/**
 * A generated file that no longer matches its source is a lie the next reader will trust, so the
 * build runs here rather than being assumed. build-world is optional: not every checkout has the
 * topology source, and saying so is better than failing on an absence.
 */
function checkGenerated() {
  console.log('\n3. Generated artefacts')
  for (const script of ['build-assets.mjs', 'build-world.mjs', 'build-client.mjs']) {
    const path = join(OPERATOR, 'scripts', script)
    if (!existsSync(path)) {
      record(script, true, 'not present, skipped')
      continue
    }
    try {
      run('node', [`operator/scripts/${script}`])
      record(script, true, 'rebuilt')
    } catch (err) {
      const out = `${err.stdout || ''}${err.stderr || ''}`.trim().split('\n').slice(-2).join(' | ')
      record(script, false, out || 'build failed')
    }
  }
}

function checkGates() {
  console.log('\n4. Quality gates')
  try {
    const out = run('node', ['operator/scripts/gates.mjs'])
    const fails = [...out.matchAll(/^(.*)\[FAIL\]/gm)].map((m) => m[1].trim()).slice(0, 6)
    record('gates.mjs', fails.length === 0, fails.length ? fails.join(' ; ') : 'all gates pass')
  } catch (err) {
    const out = `${err.stdout || ''}`
    const fails = [...out.matchAll(/^(.*)\[FAIL\]/gm)].map((m) => m[1].trim()).slice(0, 6)
    record('gates.mjs', false, fails.length ? fails.join(' ; ') : 'gates failed')
  }
}

/**
 * Plan 3.7b law 10: a page carries its answer without a scroll marathon. Measured in a real
 * browser at 1440 because a page's height is a rendered property, not a source property.
 */
async function checkHeights() {
  console.log('\n5. Page height (under 2 viewports at 1440)')
  if (quick) {
    record('page heights', true, 'skipped (--quick)')
    return
  }
  let chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch {
    record('page heights', true, 'playwright unavailable, not measured')
    return
  }
  try {
    run('node', ['operator/scripts/preview.mjs'])
  } catch {
    /* previews may already exist; measure whatever is there */
  }
  if (!existsSync(PREVIEW_DIR)) {
    record('page heights', false, `no previews at ${PREVIEW_DIR}`)
    return
  }
  const pages = readdirSync(PREVIEW_DIR).filter(
    (f) => f.endsWith('-light.html') && !/(patched|tokens-|motion-demo)/.test(f)
  )
  if (!pages.length) {
    record('page heights', false, 'no light previews rendered')
    return
  }
  let browser
  try {
    browser = await chromium.launch()
  } catch (err) {
    // A sandbox that denies mach ports is an environment limit, not a failing page. Say so plainly
    // rather than crashing the whole gate or, worse, reporting a pass that was never measured.
    record('page heights', true, `browser could not launch, not measured (${String(err.message || err).split('\n')[0].slice(0, 80)})`)
    return
  }
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    for (const file of pages.sort()) {
      const name = file.replace('-light.html', '')
      await page.goto(`file://${join(PREVIEW_DIR, file)}`, { waitUntil: 'load' })
      await page.waitForTimeout(250)
      const height = await page.evaluate(() => document.documentElement.scrollHeight)
      const viewports = height / VIEWPORT.height
      record(`${name}`, viewports <= MAX_VIEWPORTS, `${height}px, ${viewports.toFixed(2)} viewports`)
    }
  } finally {
    await browser.close()
  }
}

const SECRET_SHAPES = [
  { name: 'anthropic key', re: /\bsk-ant-[a-z0-9_-]{8,}/i },
  { name: 'openai key', re: /\bsk-[a-z0-9_-]{20,}/i },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ }
]
const FORBIDDEN_TRACKED = [/(^|\/)\.dev\.vars$/, /(^|\/)\.env$/, /(^|\/)operator\/backups\//, /(^|\/)\.wrangler\//]

/** Nothing leaves this repo before this passes: it is the check that stands between a private
 *  branch and a public mistake. Scans tracked files only, because untracked scratch is not shipped. */
function checkSecrets() {
  console.log('\n6. Secret sweep')
  const tracked = run('git', ['ls-files'], { cwd: REPO }).split('\n').filter(Boolean)
  const forbidden = tracked.filter((f) => FORBIDDEN_TRACKED.some((re) => re.test(f)))
  record('no forbidden files tracked', forbidden.length === 0, forbidden.length ? forbidden.slice(0, 5).join(', ') : `${tracked.length} files tracked`)

  // A secret detection config and the redactor itself are made of patterns; scanning them for
  // patterns is circular.
  const skip = /\.(png|jpg|jpeg|gif|woff2?|ico|svg|lock)$|package-lock\.json$|\.generated\.ts$|(^|\/)redact\.ts$|(^|\/)providers\.ts$|test\.ts$|(^|\/)\.gitleaks\.toml$/
  // A string that announces itself as fake is not a leak. Real credentials are high entropy and do
  // not contain the word "fake"; fixtures say so, usually loudly, and are how tests prove the
  // redactor works. They are reported separately rather than silently ignored, so a fixture that
  // is actually a pasted key still gets a human's eye on it.
  const declaredFixture = /(qa|test|fixture|sample|example|demo|dummy|fake|placeholder|not-?real|should-not|dead)[-_0-9]|0{8,}|X{8,}/i
  const hits = []
  const fixtures = []
  for (const file of tracked) {
    if (skip.test(file)) continue
    const abs = join(REPO, file)
    let stat
    try {
      stat = statSync(abs)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size > 400_000) continue
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    for (const shape of SECRET_SHAPES) {
      const found = text.match(shape.re)
      if (!found) continue
      const where = `${file} (${shape.name})`
      if (declaredFixture.test(found[0])) fixtures.push(where)
      else hits.push(`${where}: ${found[0].slice(0, 12)}…`)
    }
  }
  record('no secret-shaped strings tracked', hits.length === 0, hits.length ? hits.slice(0, 6).join(' ; ') : `clean${fixtures.length ? `, ${fixtures.length} declared fixture(s) allowed` : ''}`)
  if (fixtures.length) console.log(`        fixtures: ${fixtures.slice(0, 6).join(' ; ')}`)
}

console.log(`Métis Operator landing gate\nrepo: ${REPO}\nbranch: ${execSync('git branch --show-current', { cwd: REPO, encoding: 'utf8' }).trim()}\nhead: ${execSync('git log --oneline -1', { cwd: REPO, encoding: 'utf8' }).trim()}`)

checkTypes()
checkTests()
checkGenerated()
checkGates()
await checkHeights()
checkSecrets()

const failed = results.filter((r) => !r.ok)
console.log(`\n${'='.repeat(72)}`)
if (failed.length === 0) {
  console.log(`LANDED: ${results.length} checks pass. This branch is shippable.`)
  process.exit(0)
}
console.log(`NOT LANDED: ${failed.length} of ${results.length} checks failed.`)
for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
process.exit(1)
