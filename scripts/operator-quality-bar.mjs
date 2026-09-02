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
    const root = run('curl', ['-sS', '-D', '-', '-o', '/dev/null', `${host}/`])
    if (!/HTTP\/\S+\s+302/.test(root) || !/location:\s*.*login/i.test(root)) {
      fail(`live / must 302 to Cloudflare Access login, not an HTML password form`)
    }
    if (/data-login="1"/i.test(root) || /type="password"/i.test(root)) {
      fail(`live / still serves the homemade password form`)
    }
    const keys = run('curl', ['-sS', '-D', '-', '-o', '/dev/null', `${host}/keys`])
    if (!/HTTP\/\S+\s+302/.test(keys) || !/location:\s*.*login/i.test(keys)) {
      fail(`live /keys must 302 to Access login, not 404 JSON`)
    }
    const keysLoc = (keys.match(/location:\s*(\S+)/i) || [])[1] || ''
    const decodedKeys = decodeURIComponent(keysLoc)
    if (!decodedKeys.includes('/keys') && !/next=\/keys/.test(decodedKeys)) {
      fail(`live /keys Location must carry next=/keys or /keys (got ${keysLoc})`)
    }
    const api = run('curl', ['-sS', '-D', '-', '-o', '-', `${host}/v1/admin/dashboard`])
    if (!/HTTP\/\S+\s+401/.test(api) || !/application\/json/i.test(api) || !/Access required/.test(api)) {
      fail(`live /v1/admin/dashboard must stay 401 JSON without identity`)
    }
    const postKeys = run('curl', [
      '-sS',
      '-D',
      '-',
      '-o',
      '-',
      '-X',
      'POST',
      '-H',
      'content-type: application/json',
      '-d',
      '{}',
      `${host}/v1/admin/keys`
    ])
    if (!/HTTP\/\S+\s+401/.test(postKeys) || /HTTP\/\S+\s+404/.test(postKeys)) {
      fail(`live POST /v1/admin/keys must stay 401, not 404`)
    }
    const use = run('curl', [
      '-sS',
      '-D',
      '-',
      '-o',
      '-',
      '--max-redirs',
      '0',
      '-X',
      'POST',
      '-H',
      'content-type: application/json',
      '-d',
      '{}',
      `${host}/v1/use`
    ])
    if (/HTTP\/\S+\s+302/.test(use) && /cdn-cgi\/access\/login/i.test(use)) {
      fail('live POST /v1/use is wrapped by Cloudflare Access')
    }
    if (!/HTTP\/\S+\s+401/.test(use) || !/missing HMAC/.test(use)) {
      fail('live POST /v1/use must be HMAC 401 JSON, not Access HTML')
    }
    const spaMeta = JSON.parse(
      run('npx', [
        'tsx',
        '-e',
        "import { SPA_JS_PATH, SPA_JS } from './operator/src/spa/manifest.ts'; process.stdout.write(JSON.stringify({ path: SPA_JS_PATH, bytes: SPA_JS.length, route: SPA_JS.includes('window.route = route') }))"
      ])
    )
    const hashed = run('curl', [
      '-sS',
      '-D',
      '-',
      '-o',
      '-',
      '--max-redirs',
      '0',
      `${host}${spaMeta.path}`
    ])
    const hashedLen = Number((hashed.match(/content-length:\s*(\d+)/i) || [])[1] || 0)
    if (!/HTTP\/\S+\s+200/.test(hashed)) {
      fail(`live ${spaMeta.path} must be 200 real JS, not Access 302`)
    }
    if (!/content-type:\s*.*javascript/i.test(hashed)) {
      fail(`live ${spaMeta.path} must be application/javascript`)
    }
    if (hashedLen <= 97 || !/window\.route = route/.test(hashed) || !/Overview/.test(hashed)) {
      fail(`live ${spaMeta.path} is still the 97-byte stub (len=${hashedLen})`)
    }
    const hashedBody = hashed.split(/\r?\n\r?\n/).slice(1).join('\n\n')
    try {
      // eslint-disable-next-line no-new-func
      new Function(hashedBody)
    } catch (err) {
      fail(`live ${spaMeta.path} must parse (pathname strip regex regress): ${err instanceof Error ? err.message : String(err)}`)
    }
    const index = run('curl', [
      '-sS',
      '-D',
      '-',
      '-o',
      '-',
      '--max-redirs',
      '0',
      `${host}/assets/index.js`
    ])
    const indexLen = Number((index.match(/content-length:\s*(\d+)/i) || [])[1] || 0)
    if (/HTTP\/\S+\s+302/.test(index) && /cdn-cgi\/access\/login/i.test(index)) {
      fail('live /assets/index.js is wrapped by Cloudflare Access')
    }
    if (/HTTP\/\S+\s+404/.test(index)) {
      fail('live /assets/index.js must be 200 real JS, not 404 JSON')
    }
    if (!/HTTP\/\S+\s+200/.test(index) || !/content-type:\s*.*javascript/i.test(index)) {
      fail('live /assets/index.js must be 200 application/javascript')
    }
    if (indexLen <= 97 || (/self\.METIS_OPERATOR =/.test(index) && indexLen < 500)) {
      fail(`live /assets/index.js is still the 97-byte stub (len=${indexLen})`)
    }
    if (!/window\.route = route/.test(index)) {
      fail('live /assets/index.js must assign window.route')
    }
    const indexBody = index.split(/\r?\n\r?\n/).slice(1).join('\n\n')
    try {
      // eslint-disable-next-line no-new-func
      new Function(indexBody)
    } catch (err) {
      fail(`live /assets/index.js must parse: ${err instanceof Error ? err.message : String(err)}`)
    }
    const unknown = run('curl', [
      '-sS',
      '-D',
      '-',
      '-o',
      '-',
      '--max-redirs',
      '0',
      `${host}/assets/client.js`
    ])
    if (!/HTTP\/\S+\s+404/.test(unknown)) {
      fail('live /assets/client.js must 404 (unknown name), not another stub')
    }
    console.log(`✓ Live login contract: ${host}/health 200, ${host}/ and ${host}/keys 302 Access, ${host}/assets/index.js ${indexLen} js ≫ 97, ${host}${spaMeta.path} 200 js ≫ 97, POST /v1/admin/keys 401 JSON`)
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
