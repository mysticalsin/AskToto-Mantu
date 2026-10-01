#!/usr/bin/env node
/**
 * Packaged proof for M2-0412, row POLICY-01. Stands up a local, TLS-terminated stand-in "test
 * Operator" (a real HMAC-signed `/v1/model-policy` document, same canonical format and signature as
 * the production Worker and `src/main/model-policy-client.ts` — see src/shared/model-policy.ts),
 * launches the installed packaged app pointed at it via `METIS_OPERATOR_URL`/
 * `METIS_OPERATOR_INGEST_SECRET`, and proves the running app's cached fleet model policy switches to
 * a NEW version the test Operator starts serving mid-run, within 60 s, through nothing but its own
 * 30s policy poll — never a restart, never a fake result.
 *
 * TLS: the app's Operator client only ever accepts `https://` (resolveOperatorBaseUrl), so the test
 * Operator needs a real certificate even though it is local-only. Minted on the fly with the `openssl`
 * CLI already present on GitHub's hosted macOS/Windows runners (no new dependency). When `openssl` is
 * not on PATH (a from-scratch dev machine, an unusual runner image), this reports BLOCKED_EXTERNAL
 * with the exact unblock step and exits 0 — a missing local prerequisite must never fail the smoke
 * lane, same rule sidecar-boot-reaper.mjs's own BLOCKED_EXTERNAL rows follow.
 *
 * Usage:
 *   node scripts/qa/policy-smoke.mjs <installed app> <report.json>
 *
 * Exit 0 PASS or PASS-with-BLOCKED_EXTERNAL · 1 FAIL · 2 usage/precondition. The report is
 * content-free: versions, timings, and booleans only — no paths, secrets, or payload content.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { seedOnboardedProfile } from './packaged-smoke.mjs'

const TEST_SECRET = 'policy-smoke-test-secret-do-not-use-in-prod'
const CAPABILITIES = ['askChat', 'commandAgent', 'recap', 'stt', 'tts', 'embeddings', 'localModel']
const CACHE_FILE = 'model-policy-cache.json'
// One heartbeat cycle (<=60s per M2-0412 acceptance) plus generous boot jitter for a cold packaged
// launch on a shared hosted runner.
const FIRST_APPLY_TIMEOUT_MS = 90_000
// The acceptance bound itself (<=60s) plus a small margin for the poll granularity below.
const SWITCH_TIMEOUT_MS = 65_000
const POLL_MS = 2_000

class Precondition extends Error {}
class BlockedExternal extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function fullCapabilities(provider, model) {
  return Object.fromEntries(CAPABILITIES.map((c) => [c, { provider, model, fallbacks: [] }]))
}

/** Byte-for-byte the same format as canonicalModelPolicyPayload (src/shared/model-policy.ts) — a
 *  deliberate, deliberately small duplication so this QA tool has zero build/import coupling to a
 *  TypeScript module, verified against that exact function by src/shared/model-policy.test.ts. */
function canonicalPayload(policy) {
  const capString = CAPABILITIES.map((k) => {
    const e = policy.capabilities[k]
    const fb = (e.fallbacks || []).map((f) => `${f.provider}:${f.model}`).join(',')
    return `${k}=${e.provider}:${e.model}[${fb}]`
  }).join('|')
  return `metis-model-policy.v1.${policy.version}.${policy.updatedAt}.${policy.updatedBy}.${capString}`
}

function sign(policy) {
  return createHmac('sha256', TEST_SECRET).update(canonicalPayload(policy)).digest('hex')
}

function policyDoc(version, provider, model) {
  return { version, updatedAt: version, updatedBy: 'policy-smoke@example.test', capabilities: fullCapabilities(provider, model) }
}

function mintSelfSignedCert(dir) {
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1'],
      { stdio: 'ignore' }
    )
  } catch (e) {
    throw new BlockedExternal(`openssl is not available to mint a local TLS cert for the test Operator (${e?.message ?? e}). Unblock: install OpenSSL on PATH (present by default on GitHub's hosted macOS/Windows runners under Git Bash).`)
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) }
}

/** Minimal stand-in Operator: serves whatever policy `state.current` points to, signed for
 *  TEST_SECRET, over HTTPS. Never verifies the caller's own HMAC headers (a real Worker's own
 *  auth/signature contract is proven by operator/src/routes/model-policy.test.ts) — its only job here
 *  is to be a correctly-signed, mutable source the packaged app polls. */
function startTestOperator(tls) {
  const state = { current: policyDoc(1, 'anthropic', 'claude-haiku-4-5-20251001') }
  const server = createHttpsServer(tls, (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/model-policy' && req.method === 'GET') {
      const policy = state.current
      res.end(JSON.stringify({ ok: true, policy, signature: sign(policy) }))
      return
    }
    if (req.url === '/v1/heartbeat' && req.method === 'POST') {
      req.resume()
      req.on('end', () => {
        res.end(JSON.stringify({
          ok: true,
          retry: [],
          fundedProviders: [],
          approved: true,
          tier: 'metis-light',
          entitlements: { ask: false, listen: false, recap: false, crm_push: false, operator_keys: false, intelligence: false, integrations: false },
          integrationsVersion: 0
        }))
      })
      return
    }
    // Anything else (skills manifest, integrations) — a harmless, generic ok so the client's other
    // background calls never log noisy failures against this stand-in.
    req.resume()
    res.end(JSON.stringify({ ok: true }))
  })
  return { server, state }
}

function readCachedPolicyVersion(profile) {
  try {
    const raw = JSON.parse(readFileSync(join(profile, CACHE_FILE), 'utf8'))
    return raw?.policy?.version ?? null
  } catch {
    return null
  }
}

async function waitForVersion(profile, targetVersion, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const startedAt = Date.now()
  while (Date.now() < deadline) {
    if (readCachedPolicyVersion(profile) === targetVersion) return Date.now() - startedAt
    await sleep(POLL_MS)
  }
  return null
}

function killTree(child) {
  if (!child || child.pid == null) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(child.pid, 'SIGKILL')
    }
  } catch {
    /* already gone */
  }
}

function report(reportPath, body) {
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(body, null, 2)}\n`)
}

async function main() {
  const [target, reportPath] = process.argv.slice(2)
  if (!target || !reportPath || (process.platform !== 'darwin' && process.platform !== 'win32')) {
    console.error('usage: node scripts/qa/policy-smoke.mjs <installed app> <report.json>')
    process.exit(2)
  }

  const platform = process.platform
  let executable
  if (platform === 'darwin') {
    const installRoot = realpathSync.native(target)
    executable = join(installRoot, 'Contents', 'MacOS', basename(installRoot, '.app'))
  } else {
    executable = realpathSync.native(target)
  }
  if (!existsSync(executable)) {
    console.error(`policy-smoke: executable not found at ${executable}`)
    process.exit(2)
  }

  let profile = null
  let certDir = null
  let child = null
  let httpsServer = null

  try {
    certDir = mkdtempSync(join(tmpdir(), 'policy-smoke-cert-'))
    const tls = mintSelfSignedCert(certDir)
    const port = await freeLoopbackPort()
    const { server, state } = startTestOperator(tls)
    httpsServer = server
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })

    profile = mkdtempSync(join(tmpdir(), 'metis-policy-smoke-'))
    seedOnboardedProfile(profile)

    const env = {
      ...process.env,
      ASKTOTO_USERDATA: profile,
      METIS_OPERATOR_URL: `https://127.0.0.1:${port}`,
      METIS_OPERATOR_INGEST_SECRET: TEST_SECRET,
      // The test Operator's cert is self-signed and local-only; this only ever affects this one
      // spawned QA process, never a real user's app, and never a real network destination.
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    }
    for (const key of Object.keys(env)) if (/_API_KEY$/i.test(key)) delete env[key]

    child = spawn(executable, [], { env, stdio: 'ignore' })
    let launchFailed = false
    child.once('error', () => {
      launchFailed = true
    })

    const firstApplyMs = launchFailed ? null : await waitForVersion(profile, state.current.version, FIRST_APPLY_TIMEOUT_MS)
    if (launchFailed) throw new Precondition('the packaged app failed to launch')
    if (firstApplyMs === null) {
      throw new Error(`the app never cached the initial fleet model policy within ${FIRST_APPLY_TIMEOUT_MS}ms`)
    }

    // Change the policy on the test Operator mid-run — no restart, no re-launch.
    state.current = policyDoc(2, 'openai', 'gpt-5')
    const switchMs = await waitForVersion(profile, 2, SWITCH_TIMEOUT_MS)

    report(reportPath, {
      ok: switchMs !== null,
      row: 'POLICY-01',
      platform,
      firstApplyMs,
      switchMs,
      switchBoundMs: 60_000,
      // Observed: the verified policy version the running app cached. NOT observed: the model an ask then
      // used — the packaged app exposes no non-interactive ask hook and an ask needs a live provider
      // credential (BLOCKED_EXTERNAL; the per-call routing is covered by the desktop unit/contract tests).
      evidence: 'cached-policy-version',
      modelUsedObserved: false,
      passed: switchMs !== null && switchMs <= 60_000
    })
    process.exit(switchMs !== null && switchMs <= 60_000 ? 0 : 1)
  } catch (e) {
    if (e instanceof BlockedExternal) {
      report(reportPath, { ok: true, row: 'POLICY-01', blockedExternal: true, reason: e.message })
      process.exit(0)
    }
    if (e instanceof Precondition) {
      report(reportPath, { ok: false, row: 'POLICY-01', precondition: e.message })
      process.exit(2)
    }
    report(reportPath, { ok: false, row: 'POLICY-01', error: e?.message ?? String(e) })
    process.exit(1)
  } finally {
    killTree(child)
    try {
      httpsServer?.close()
    } catch {
      /* best effort */
    }
    if (profile) rmSync(profile, { recursive: true, force: true })
    if (certDir) rmSync(certDir, { recursive: true, force: true })
  }
}

void main()
