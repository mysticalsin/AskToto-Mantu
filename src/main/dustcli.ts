import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { DustCliImport } from '@shared/ipc'
import { resolveBin } from './cli'
import { clearApiKey, setSettings } from './store'
import { DUST_KEYCHAIN_SERVICE, readDustSecret } from './dust-secret-store'

const exec = promisify(execFile)

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
    return { ok: false, error: 'Your Dust CLI session is incomplete. Run “Set up Dust” again to sign in.' }
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
          // On Windows the resolved bin is `dust.cmd`, which only runs through a shell — quote the path
          // for spaces. Best-effort either way: a nonzero exit/timeout is swallowed and we re-read.
          if (process.platform === 'win32') {
            await exec(`"${bin}" status`, [], { timeout: 25_000, env: { ...process.env, CI: '1' }, shell: true, windowsHide: true })
          } else {
            await exec(bin, ['status'], { timeout: 25_000, env: { ...process.env, CI: '1' } })
          }
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
