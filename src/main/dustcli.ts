import { spawn } from 'node:child_process'
import type { DustCliImport } from '@shared/ipc'
import { killWindowsProcessTree, resolveBin, resolveSpawnTarget } from './cli'
import { DUST_KEYCHAIN_SERVICE, readDustSecret } from './dust-secret-store'


/**
 * Read the local `@dust-tt/dust-cli` session so Métis can connect to Dust without the user copy-pasting a
 * key — for the user who already has the CLI installed and ran `dust login` themselves.
 *
 * This is a MIGRATION path, not the primary sign-in flow: the primary flow is main/dust-oauth.ts's native
 * OAuth device flow (no CLI, no system Node.js required). The Dust CLI stores its own session via keytar
 * under service `dust-cli` (accounts `access_token` / `workspace_sid` / `region`); the per-OS read lives
 * in dust-secret-store.ts (macOS Keychain, Windows Credential Manager, Linux libsecret) — all
 * native-module-free shell-outs. This module only imports and refreshes that existing session; it never
 * installs or launches the CLI itself.
 *
 * The access token is an OAuth token and is short-lived: it works now and survives restarts until it
 * expires, after which `dust status` (refreshDustCliSession) re-mints it with no re-login.
 */

const ACCESS_TOKEN = 'access_token'
const WORKSPACE = 'workspace_sid'
const REGION = 'region'

/** Dust CLI region id → API base URL. EU workspaces live on eu.dust.tt. */
function regionToBaseUrl(region: string | null): string {
  return region && /eu|europe/i.test(region) ? 'https://eu.dust.tt' : 'https://dust.tt'
}

/** Imported fields plus the bearer token (kept out of the renderer-facing DustCliImport). */
export type DustCliSession = DustCliImport & { token?: string }

export async function importDustCliSession(service: string = DUST_KEYCHAIN_SERVICE): Promise<DustCliSession> {
  // Read sequentially: a macOS permission dialog is per lookup, and parallel reads can stack prompts or
  // make a single denial look like a missing session. (Windows/Linux never prompt or deny — the reads
  // just resolve.) accessDenied is macOS-only; a genuinely missing session returns the setup prompt.
  const token = await readDustSecret(ACCESS_TOKEN, service)
  if (token.accessDenied) {
    return { ok: false, accessDenied: true, error: 'Allow Métis to access your Dust CLI session in Keychain, then try again.' }
  }
  if (!token.value) {
    return {
      ok: false,
      error: 'No Dust CLI session found. Click “Set up Dust” to install the CLI and sign in.'
    }
  }
  const workspace = await readDustSecret(WORKSPACE, service)
  if (workspace.accessDenied) {
    return { ok: false, accessDenied: true, error: 'Allow Métis to access your Dust CLI workspace in Keychain, then try again.' }
  }
  if (!workspace.value) {
    // access_token landed but workspace_sid never did — the browser OAuth step of `dust login` finished
    // but the separate interactive terminal workspace-picker step didn't. Flagged distinctly from "no
    // session at all" so callers can point the user back at that already-open terminal instead of
    // relaunching the whole install + login.
    return { ok: false, incomplete: true, error: 'Your Dust CLI session is incomplete. Finish picking your workspace in the Terminal window, or run “Set up Dust” again.' }
  }
  const region = await readDustSecret(REGION, service)
  if (region.accessDenied) {
    return { ok: false, accessDenied: true, error: 'Allow Métis to access your Dust CLI region in Keychain, then try again.' }
  }
  return { ok: true, token: token.value, workspaceId: workspace.value, baseUrl: regionToBaseUrl(region.value) }
}

/**
 * Force the local Dust CLI to mint a fresh access token, then re-read it from the keychain.
 *
 * The imported `access_token` is a short-lived OAuth token (~1h). The Dust CLI holds a long-lived
 * refresh token and rotates the access token whenever it talks to the API. Running `dust status`
 * (non-interactive — no browser, no prompt) exercises the CLI so it refreshes the keychain token;
 * we then re-read it. As long as the CLI session itself is valid (the user has not run `dust logout`),
 * this recovers a working token with no re-login. macOS only, matching importDustCliSession.
 *
 * Best-effort: a nonzero exit or timeout is swallowed — we always re-read whatever the CLI left in the
 * keychain, which is the freshest token available. A hard timeout keeps a hung CLI off the answer path.
 */
// Overlapping refreshes are dangerous, not just wasteful: Dust's OAuth refresh tokens rotate and are
// single-use, so two concurrent `dust status` runs (startup refresh racing a 401-triggered one) can
// burn a stale refresh token and invalidate the whole CLI session — the exact "why am I running
// `dust login` again" failure. Single-flight collapses concurrent callers onto one mint, and a short
// result cache absorbs bursts (several streams 401ing together) without re-spawning the CLI.
let refreshInflight: Promise<DustCliSession> | null = null
let lastRefresh: { at: number; session: DustCliSession } | null = null
const REFRESH_RESULT_TTL_MS = 30_000
const DUST_STATUS_TIMEOUT_MS = 25_000

/**
 * Run `dust status` to completion, tearing down the WHOLE process tree if it overruns.
 *
 * MQA-019: execFile's built-in `timeout` kills only the immediate child. On Windows the resolved bin is
 * `dust.cmd`, so that child is cmd.exe and the real `node …dust-cli status` is its grandchild — which
 * survived the timeout, still mid-refresh and still holding the single-use OAuth refresh token.
 * `refreshInflight` above tracks Métis's own promise, so it is blind to that orphan: the next refresh
 * presents the same rotating token, one rotation invalidates the other, and the whole Dust CLI session
 * dies — precisely the "why am I being asked to run `dust login` again" failure the single-flight guard
 * exists to prevent. killWindowsProcessTree (cli.ts, shared rather than copied so the two cannot drift)
 * recurses the tree.
 *
 * Never rejects: the caller re-reads the keychain regardless of how the CLI ended.
 */
function runDustStatus(target: ReturnType<typeof resolveSpawnTarget>): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn(target.command, target.args, {
      // CI=1 suppresses the spinner / update-check UI.
      env: { ...process.env, CI: '1', ...target.env },
      // SECURITY: never shell:true — resolveSpawnTarget routes a .cmd shim through cmd.exe as the target
      // *executable*, args stay an array, and cmd.exe never re-interprets a joined string.
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: target.windowsVerbatimArguments,
      // Nothing ever read this output; ignoring it also means a CLI that tries to read stdin gets EOF
      // immediately instead of hanging on a pipe no one writes to.
      stdio: 'ignore'
    })
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      killWindowsProcessTree(child.pid)
      child.kill('SIGTERM') // off-Windows there is no shim indirection, so this alone is sufficient
      finish()
    }, DUST_STATUS_TIMEOUT_MS)
    // 'close' rather than 'exit': it fires once the process has exited AND its stdio is torn down, so a
    // late kill can never race a child we already consider finished.
    child.once('close', finish)
    child.once('error', finish) // spawn failure is best-effort, same as a nonzero exit
  })
}

export async function refreshDustCliSession(): Promise<DustCliSession> {
  if (refreshInflight) return refreshInflight
  if (lastRefresh && lastRefresh.session.ok && Date.now() - lastRefresh.at < REFRESH_RESULT_TTL_MS) {
    return lastRefresh.session
  }
  refreshInflight = (async () => {
    try {
      const bin = await resolveBin('dust')
      if (bin) {
        try {
          // CI=1 suppresses the spinner / update-check UI; the timeout bounds the network round-trip.
          // On Windows the resolved bin is `dust.cmd`, a shim that can't be exec'd directly (SECURITY:
          // never use shell:true — resolveSpawnTarget routes a .cmd shim through cmd.exe as the target
          // *executable*, args stay an array, cmd.exe never re-interprets a joined string). Best-effort
          // either way: a nonzero exit/timeout is swallowed and we re-read.
          const spawnTarget = resolveSpawnTarget(bin, ['status'])
          await runDustStatus(spawnTarget)
        } catch {
          // ignore — fall through and re-read the session regardless of exit code
        }
      }
      const s = await importDustCliSession()
      lastRefresh = { at: Date.now(), session: s }
      return s
    } finally {
      refreshInflight = null
    }
  })()
  return refreshInflight
}
