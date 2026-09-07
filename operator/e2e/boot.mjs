/**
 * Boots a REAL `metis-operator` Worker for the e2e suite: generates the local-only secrets a
 * `wrangler dev --local` run needs, starts it on a free port, waits for `/health`, applies the real
 * migrations and the QA fixture against the same local D1, and mints an admin console session
 * cookie the same way `operator/scripts/dev-session.mjs` documents for local dev without Access.
 *
 * No Cloudflare account, no `wrangler login`, no network dependency beyond the one-time npm fetch of
 * the `wrangler` package and workerd's own one-time `request.cf` trace lookup (cached under
 * `$SCRATCH/home`, reused across runs). Never deploys, never touches `--remote`.
 *
 * A secret's VALUE is never logged; only booleans/lengths and "generated" ever reach stdout.
 */
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './lib/http.mjs'
import { freePort } from './lib/ports.mjs'
import { loadHmac } from './lib/hmac.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const OPERATOR_DIR = join(__dirname, '..')
export const REPO_ROOT = join(OPERATOR_DIR, '..')
export const SCRATCH_DIR =
  process.env.METIS_QA_SCRATCH ||
  '/private/tmp/claude-501/-Users-tony-Library-CloudStorage-OneDrive-MantuGroup-Documents-Chief-of-Staff-Apps-Source-Metis-Portal/7883530c-5678-450a-aef0-46d1bc798bfd/scratchpad'
const DEV_VARS_PATH = join(OPERATOR_DIR, '.dev.vars')
const HEALTH_TIMEOUT_MS = 60_000
const HEALTH_POLL_MS = 300

function b64Secret(bytes = 32) {
  return randomBytes(bytes).toString('base64')
}

function ed25519PrivateKeyB64() {
  const { privateKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  })
  return Buffer.from(privateKey, 'utf8').toString('base64')
}

function devVarsText(secrets) {
  return [
    `OPERATOR_INGEST_SECRET=${secrets.ingestSecret}`,
    `OPERATOR_PROMPT_KEY=${secrets.promptKey}`,
    `OPERATOR_VAULT_KEY=${secrets.vaultKey}`,
    `OPERATOR_SKILL_PRIVATE_KEY=${secrets.skillPrivateKeyB64}`,
    'OPERATOR_ENV=e2e',
    `OPERATOR_BUILT_AT=${new Date().toISOString()}`,
    ''
  ].join('\n')
}

/** Waits only for the HTTP server itself to accept a connection and answer SOMETHING — even a 500.
 *  `/health` legitimately 500s before migrations run (its `lastIngestAt`/`lastCronAt` helpers query
 *  `seats`/`audit` directly, unguarded, when D1 is bound but has no schema yet), so this cannot wait
 *  for a clean 200 the way `waitForHealth` below does. This only proves "the Worker process is up
 *  and routing requests", which is all boot needs before it runs the real migrations. */
async function waitForReachable(baseUrl, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
      return
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
  }
  throw new Error(`boot.mjs: Worker never accepted a connection within ${timeoutMs}ms${lastErr ? `: ${lastErr.message}` : ''}`)
}

async function waitForHealth(baseUrl, { timeoutMs = HEALTH_TIMEOUT_MS, requireSchemaOk = false } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const body = await res.json()
        if (body?.ok === true && (!requireSchemaOk || body.schema === 'ok')) return body
        lastErr = new Error(`health not ready yet: ${JSON.stringify(body)}`)
      } else {
        lastErr = new Error(`health responded ${res.status}`)
      }
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
  }
  throw new Error(`boot.mjs: /health never became ready within ${timeoutMs}ms${lastErr ? `: ${lastErr.message}` : ''}`)
}

function runNode(scriptRelPath, args, cwd, env, logLines) {
  const out = execFileSync(process.execPath, [join(OPERATOR_DIR, scriptRelPath), ...args], {
    cwd,
    encoding: 'utf8',
    env
  })
  logLines.push(`$ node ${scriptRelPath} ${args.join(' ')}`, out)
  return out
}

/**
 * `wrangler dev --local` (already running) and the separate `wrangler d1 execute --local` processes
 * `migrate.mjs`/`seed-local.mjs` shell out to (once per statement) both open the same local D1 sqlite
 * file concurrently. That occasionally races: an "other side closed" error from the dev server's own
 * D1 session coordinator, or worse, a `CREATE TABLE` that reports success but does not survive (the
 * very next statement then fails "no such table") — a real environment race, not a product defect,
 * and not always visible as a nonzero exit from either script alone. So this does not just retry
 * `migrate.mjs`/`seed-local.mjs` independently; it retries the WHOLE migrate-then-seed cycle and,
 * critically, verifies the result against `/health`'s real `schema` status each time — the one signal
 * that can't be fooled by a script exiting 0 over a table that quietly didn't stick.
 */
async function migrateAndSeedWithRetry(baseUrl, env, record, attempts = 4) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      const migrateLog = []
      runNode('scripts/migrate.mjs', ['--local'], OPERATOR_DIR, env, migrateLog)
      const seedLog = []
      runNode('scripts/seed-local.mjs', [], OPERATOR_DIR, env, seedLog)
      const health = await waitForHealth(baseUrl, { requireSchemaOk: true, timeoutMs: 15_000 })
      if (i > 1) record(`boot: migrate+seed succeeded on attempt ${i}/${attempts}`)
      return health
    } catch (err) {
      lastErr = err
      record(`boot: migrate+seed attempt ${i}/${attempts} failed (${err.message?.split('\n')[0]}), retrying`)
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  throw new Error(`boot: migrate+seed never produced a healthy schema after ${attempts} attempts: ${lastErr?.message}`)
}

/**
 * Boots the Worker and returns a ready-to-use test context. Callers MUST call `ctx.stop()` in a
 * `finally` block, even on failure, so no `wrangler dev`/workerd process or temp `.dev.vars` survives
 * the run.
 */
export async function bootWorker({ log = () => {} } = {}) {
  const bootLog = []
  const record = (line) => {
    bootLog.push(line)
    log(line)
  }

  await mkdir(SCRATCH_DIR, { recursive: true })
  const homeDir = join(SCRATCH_DIR, 'home')
  await mkdir(homeDir, { recursive: true })

  const secrets = {
    ingestSecret: b64Secret(32),
    promptKey: b64Secret(32),
    vaultKey: b64Secret(32),
    skillPrivateKeyB64: ed25519PrivateKeyB64()
  }
  record('boot: generated OPERATOR_INGEST_SECRET, OPERATOR_PROMPT_KEY, OPERATOR_VAULT_KEY, OPERATOR_SKILL_PRIVATE_KEY (values never logged)')

  const hadExistingDevVars = existsSync(DEV_VARS_PATH)
  const existingDevVars = hadExistingDevVars ? await readFile(DEV_VARS_PATH, 'utf8') : null
  await writeFile(DEV_VARS_PATH, devVarsText(secrets), 'utf8')
  record(`boot: wrote temp ${DEV_VARS_PATH} (removed on teardown${hadExistingDevVars ? ', prior content restored' : ''})`)

  const port = await freePort()
  const inspectorPort = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`

  const childEnv = {
    ...process.env,
    HOME: homeDir, // wrangler/miniflare write ~/Library/Preferences/.wrangler/logs; sandbox denies the real HOME
    CI: '1' // suppress wrangler's interactive update-check / metrics prompts
  }

  const child = spawn(
    'npx',
    [
      'wrangler@4',
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      String(inspectorPort),
      '--show-interactive-dev-session=false'
    ],
    { cwd: OPERATOR_DIR, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const wranglerLog = []
  const pushLog = (buf) => {
    for (const line of buf.toString('utf8').split('\n')) {
      if (line.trim()) wranglerLog.push(line)
    }
    if (wranglerLog.length > 500) wranglerLog.splice(0, wranglerLog.length - 500)
  }
  child.stdout.on('data', pushLog)
  child.stderr.on('data', pushLog)
  let exited = null
  child.on('exit', (code, signal) => {
    exited = { code, signal }
  })
  record(`boot: spawned "npx wrangler@4 dev --local --port ${port}" (pid ${child.pid}, cwd ${OPERATOR_DIR})`)

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (child.pid && exited === null) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
      }
      const killDeadline = Date.now() + 5000
      while (exited === null && Date.now() < killDeadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (exited === null) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }
    }
    try {
      if (hadExistingDevVars && existingDevVars !== null) {
        await writeFile(DEV_VARS_PATH, existingDevVars, 'utf8')
      } else {
        await rm(DEV_VARS_PATH, { force: true })
      }
    } catch {
      /* best effort */
    }
    try {
      await rm(join(OPERATOR_DIR, '.wrangler'), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    record('boot: stopped wrangler dev, removed temp .dev.vars and .wrangler state')
  }

  try {
    // wrangler dev can die immediately on a config/port error; fail fast with the real log rather
    // than waiting out the full health timeout.
    const earlyDeath = new Promise((resolve) => {
      const check = setInterval(() => {
        if (exited !== null) {
          clearInterval(check)
          resolve(exited)
        }
      }, 200)
      setTimeout(() => {
        clearInterval(check)
        resolve(null)
      }, HEALTH_TIMEOUT_MS)
    })
    const reachablePromise = waitForReachable(baseUrl)
    const raced = await Promise.race([
      reachablePromise.then(() => ({ kind: 'reachable' })),
      earlyDeath.then((e) => (e ? { kind: 'died', e } : null))
    ])
    if (raced?.kind === 'died') {
      throw new Error(`boot: wrangler dev exited early (code=${raced.e.code} signal=${raced.e.signal})\n${wranglerLog.slice(-60).join('\n')}`)
    }
    await reachablePromise
    record('boot: Worker process is up and routing requests')
    // Miniflare's local D1 binding lazily finishes settling its on-disk storage shortly after the
    // Worker's first real D1 touch (triggered by the reachability probe's own /health call above); a
    // separate `wrangler d1 execute` CLI process racing that can otherwise create tables that don't
    // survive (observed as "no such table" on the very next statement). A short settle delay here
    // costs nothing and removes most of that race outright; the whole-cycle retry below is the real
    // backstop for whatever it doesn't.
    await new Promise((r) => setTimeout(r, 750))

    const finalHealth = await migrateAndSeedWithRetry(baseUrl, childEnv, record)
    record(`boot: schema ok, d1 ${finalHealth.d1}`)

    const hmac = await loadHmac(SCRATCH_DIR)

    const devSessionMod = await import(join(OPERATOR_DIR, 'scripts/dev-session.mjs'))
    const adminEmail = 'tony.walteur@gmail.com'
    const iat = Date.now()
    const sessionSecret = await devSessionMod.deriveSessionSecretNode({ explicit: undefined, promptKey: secrets.promptKey })
    const sessionToken = await devSessionMod.mintSessionTokenNode(adminEmail, iat, sessionSecret)
    const cookieName = devSessionMod.SESSION_COOKIE
    record('boot: minted admin console session cookie (dev-session.mjs algorithm; value never logged)')

    return {
      baseUrl,
      port,
      adminEmail,
      cookieName,
      cookieValue: sessionToken,
      cookieHeader: `${cookieName}=${sessionToken}`,
      ingestSecret: secrets.ingestSecret,
      promptKey: secrets.promptKey,
      vaultKey: secrets.vaultKey,
      hmac,
      scratchDir: SCRATCH_DIR,
      operatorDir: OPERATOR_DIR,
      getBootLog: () => [...bootLog, ...wranglerLog.slice(-80)],
      stop
    }
  } catch (err) {
    await stop()
    throw err
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  // Manual debug entry point: boot, print connection info, wait for Ctrl+C.
  bootWorker({ log: (l) => console.log(l) })
    .then((ctx) => {
      console.log(`\nWorker up at ${ctx.baseUrl}`)
      console.log(`Cookie: ${ctx.cookieHeader}`)
      console.log('Press Ctrl+C to stop.')
      process.on('SIGINT', async () => {
        await ctx.stop()
        process.exit(0)
      })
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
