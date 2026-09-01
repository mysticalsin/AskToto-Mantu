#!/usr/bin/env node
/**
 * Tony 6:17 PM ET quality bar.
 *
 * After every Operator change: run Operator tests AND prove overlay chrome,
 * login, map request.cf contract, and token-free events did not regress.
 * Overlay Island/Hide is frozen. If a map/sidebar fix would edit these paths,
 * stop and report. Do not pack. READY TO MERGE stays no.
 *
 * Run: npm run test:operator:quality-bar
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Frozen Overlay Island / Hide / Bar chrome. Do not edit from an Operator slice. */
export const FROZEN_OVERLAY_CHROME = [
  'src/shared/overlay-chrome.ts',
  'src/shared/overlay-chrome.test.ts',
  'src/renderer/src/components/OverlayChromePicker.tsx',
  'src/renderer/src/components/OverlayChromePicker.test.ts',
  'src/renderer/src/components/OverlayPeek.tsx',
  'src/renderer/src/components/OverlayPeek.test.ts',
  'src/renderer/src/lib/overlay-motion.ts',
  'src/renderer/src/lib/overlay-motion.test.ts',
  'src/renderer/src/lib/overlay-autohide.ts',
  'src/renderer/src/lib/overlay-autohide.test.ts',
  'src/main/overlay-placement.contract.test.ts',
  'src/main/island/cursor-watch.ts',
  'src/main/island/cursor-watch.test.ts',
  'src/main/island/geometry.ts',
  'src/main/island/geometry.test.ts',
  'src/main/island/hover-hit-band.test.ts',
  'src/main/island/mac-hide-island.proof.test.ts',
  'src/main/island/metrics.ts',
  'src/main/island/metrics.test.ts'
]

const OVERLAY_CHROME_TESTS = [
  'src/shared/overlay-chrome.test.ts',
  'src/renderer/src/components/OverlayChromePicker.test.ts',
  'src/renderer/src/components/OverlayPeek.test.ts',
  'src/renderer/src/lib/overlay-motion.test.ts',
  'src/renderer/src/lib/overlay-autohide.test.ts',
  'src/main/overlay-placement.contract.test.ts',
  'src/main/island/geometry.test.ts',
  'src/main/island/hover-hit-band.test.ts',
  'src/main/island/mac-hide-island.proof.test.ts',
  'src/main/island/cursor-watch.test.ts',
  'src/main/island/metrics.test.ts'
]

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe']
  })
}

function gitLines(args) {
  const out = run('git', args).trim()
  return out ? out.split('\n').filter(Boolean) : []
}

function resolveMergeBase() {
  const preferred = process.env.OPERATOR_QUALITY_BASE || 'origin/cursor/operator-dashboard-9ecc'
  const fallbacks = [preferred, 'origin/main', 'main']
  for (const ref of fallbacks) {
    try {
      const base = run('git', ['merge-base', 'HEAD', ref]).trim()
      if (base) return { ref, base }
    } catch {
      /* try next */
    }
  }
  throw new Error('quality-bar: could not resolve a merge-base for overlay freeze check')
}

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

const OPERATOR_SLICE = ['operator/', 'docs/design/OPERATOR.md']

function checkOverlayFrozen() {
  const missing = FROZEN_OVERLAY_CHROME.filter((p) => !existsSync(join(ROOT, p)))
  if (missing.length) fail(`frozen overlay path missing (do not delete): ${missing.join(', ')}`)

  const { ref, base } = resolveMergeBase()
  const overlayVsBase = gitLines(['diff', '--name-only', base, 'HEAD', '--', ...FROZEN_OVERLAY_CHROME])
  const operatorVsBase = gitLines(['diff', '--name-only', base, 'HEAD', '--', ...OPERATOR_SLICE])
  const overlayDirty = [
    ...gitLines(['diff', '--name-only', '--', ...FROZEN_OVERLAY_CHROME]),
    ...gitLines(['diff', '--cached', '--name-only', '--', ...FROZEN_OVERLAY_CHROME])
  ]
  const operatorDirty = [
    ...gitLines(['diff', '--name-only', '--', ...OPERATOR_SLICE]),
    ...gitLines(['diff', '--cached', '--name-only', '--', ...OPERATOR_SLICE])
  ]
  const overlayTouched = [...new Set([...overlayVsBase, ...overlayDirty])].map((p) =>
    relative(ROOT, resolve(ROOT, p))
  )
  const operatorTouched = operatorVsBase.length + operatorDirty.length > 0
  if (overlayTouched.length && operatorTouched) {
    console.error('✗ Operator slice mixed with overlay chrome. Stop and report. Do not edit Island/Hide from a map/sidebar fix.')
    console.error(`  merge-base ${base.slice(0, 8)} (${ref})`)
    for (const p of overlayTouched) console.error(`  ${p}`)
    process.exit(1)
  }
  if (overlayTouched.length) {
    console.log(`✓ Overlay chrome changed without an Operator mix (${ref}). Separate slice is allowed.`)
    return
  }
  console.log(`✓ Overlay chrome frozen vs ${ref} (${base.slice(0, 8)}). Island/Hide files untouched.`)
}

function runVitest(label, args) {
  console.log(`\n→ ${label}`)
  try {
    run('npx', ['vitest', 'run', ...args], { stdio: 'inherit' })
  } catch {
    fail(`${label} failed`)
  }
}

function probeLiveLogin() {
  const host = process.env.OPERATOR_LIVE_HOST || 'https://metis-operator.tony-walteur.workers.dev'
  try {
    const health = run('curl', ['-sS', '-o', '-', '-w', '\n%{http_code}', `${host}/health`]).trim()
    const healthLines = health.split('\n')
    const healthCode = healthLines.at(-1)
    const healthBody = healthLines.slice(0, -1).join('\n')
    if (healthCode !== '200' || !healthBody.includes('"service":"metis-operator"')) {
      fail(`live /health must stay 200 without Access (got ${healthCode})`)
    }
    const root = run('curl', ['-sS', '-D', '-', '-o', '-', `${host}/`])
    if (!/content-type:\s*text\/html/i.test(root) || !/data-login="1"/.test(root) || !/type="password"/.test(root)) {
      fail(`live / must be text/html login, not JSON Access required`)
    }
    if (/"ok":\s*false/.test(root) && /Access required/.test(root) && !/data-login/.test(root)) {
      fail(`live / first paint is still JSON 401`)
    }
    const api = run('curl', ['-sS', '-D', '-', '-o', '-', `${host}/v1/admin/dashboard`])
    if (!/HTTP\/\S+\s+401/.test(api) || !/application\/json/i.test(api) || !/Access required/.test(api)) {
      fail(`live /v1/admin/dashboard must stay 401 JSON without identity`)
    }
    console.log(`✓ Live login contract: ${host}/health 200, ${host}/ text/html login, ${host}/v1/admin/dashboard 401 JSON`)
  } catch (err) {
    fail(`live login probe failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

checkOverlayFrozen()
runVitest('overlay chrome tests (Island/Hide, no Operator mix)', OVERLAY_CHROME_TESTS)
runVitest('Operator tests (login, map request.cf, token-free events)', [
  '--config',
  'operator/vitest.config.ts'
])
probeLiveLogin()
console.log('\n✓ Quality bar: overlay chrome, login, map data contract, token-free events.')
