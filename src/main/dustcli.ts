import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { DustCliImport } from '@shared/ipc'
import { killWindowsProcessTree, resolveBin, resolveSpawnTarget } from './cli'
import { clearApiKey, setSettings } from './store'
import { DUST_KEYCHAIN_SERVICE, readDustSecret } from './dust-secret-store'


/**
 * Read the local Dust CLI session so Métis can connect to Dust without the user copy-pasting a key.
 *
 * The Dust CLI (`@dust-tt/dust-cli`, command `dust login`) stores its session via keytar under service
 * `dust-cli` (accounts `access_token` / `workspace_sid` / `region`). The per-OS read lives in
 * dust-secret-store.ts (macOS Keychain, Windows Credential Manager, Linux libsecret) — all
 * native-module-free shell-outs. This module orchestrates import, refresh, and first-run setup on top,
 * identically on every platform.
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

// macOS `.command` installer (bash). Opening a `.command` runs it in Terminal with NO Automation
// permission (unlike osascript). `dust login` needs a browser OAuth, so it must run in a visible window.
const MAC_SETUP_SCRIPT =
  [
    '#!/bin/bash',
    'clear',
    'echo "Métis — Dust setup"',
    'echo "==================="',
    'echo',
    'if ! command -v npm >/dev/null 2>&1; then',
    '  echo "✗ npm / Node.js not found. Install Node from https://nodejs.org, then run this again."',
    '  echo; echo "Press any key to close."; read -n 1 -s; exit 1',
    'fi',
    'echo "Step 1/2  Installing the Dust CLI (npm i -g @dust-tt/dust-cli)…"',
    'if ! npm i -g @dust-tt/dust-cli; then',
    '  echo; echo "✗ Install failed (often a permissions issue with global npm)."',
    '  echo "  Try:  sudo npm i -g @dust-tt/dust-cli   then run this again."',
    '  echo; echo "Press any key to close."; read -n 1 -s; exit 1',
    'fi',
    'echo; echo "Step 2/2  Signing in to Dust (a browser window will open)…"',
    'echo "After the browser sign-in, THIS window will ask you to pick your workspace — use the arrow"',
    'echo "keys, press Enter, and wait for \\"Authentication and workspace selection complete!\\" before"',
    'echo "closing this window."',
    'dust login',
    'echo; echo "✓ Done. Return to Métis — it will connect automatically after login."',
    'echo "You can close this window."'
  ].join('\n') + '\n'

// Windows `.cmd` installer (batch). Opening a `.cmd` runs it in a console window; `pause` keeps it open.
// Plain ASCII only — the default console codepage mangles accents/emoji. `^(` escapes parens for echo.
const WIN_SETUP_SCRIPT =
  [
    '@echo off',
    'title Metis - Dust setup',
    'cls',
    'echo Metis - Dust setup',
    'echo ===================',
    'echo.',
    'where npm >nul 2>nul',
    'if errorlevel 1 (',
    '  echo npm / Node.js not found. Install Node from https://nodejs.org, then run this again.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo Step 1/2  Installing the Dust CLI ^(npm i -g @dust-tt/dust-cli^)...',
    'call npm i -g @dust-tt/dust-cli',
    'if errorlevel 1 (',
    '  echo.',
    '  echo Install failed. Try running this window as Administrator, then run it again.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo.',
    'echo Step 2/2  Signing in to Dust ^(a browser window will open^)...',
    'echo After the browser sign-in, THIS window will ask you to pick your workspace -- use the arrow',
    'echo keys, press Enter, and wait for "Authentication and workspace selection complete!" before',
    'echo closing this window.',
    'call dust login',
    'echo.',
    'echo Done. Return to Metis - it will connect automatically after login.',
    'echo You can close this window.',
    'pause'
  ].join('\r\n') + '\r\n'

/**
 * Kick off the Dust CLI setup for a user with no session yet: write an installer script (install the
 * CLI, then run the interactive `dust login`) and open it so a terminal window walks the user through it.
 * Cross-platform — macOS `.command`, Windows `.cmd`; after login the poll (index.ts) auto-imports on
 * every platform. Linux terminal-launching is DE-specific, so there we point the user at the two commands.
 */
export async function setupDustCli(): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return {
      ok: false,
      error: 'On Linux, run `npm i -g @dust-tt/dust-cli && dust login` in a terminal, then reopen Métis.'
    }
  }
  try {
    const isWin = process.platform === 'win32'
    const script = isWin ? WIN_SETUP_SCRIPT : MAC_SETUP_SCRIPT
    const ext = isWin ? 'cmd' : 'command'
    const scriptPath = join(app.getPath('temp'), `asktoto-dust-setup-${randomBytes(8).toString('hex')}.${ext}`)
    // 0o755 (exec bit) matters on macOS; Windows ignores mode and runs `.cmd` by extension.
    writeFileSync(scriptPath, script, { mode: 0o755, flag: 'wx' })
    const err = await shell.openPath(scriptPath) // opens in Terminal/Console and runs it
    if (err) return { ok: false, error: err }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
