import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DustCliImport } from '@shared/ipc'
import { resolveBin } from './cli'

const exec = promisify(execFile)

/**
 * Read the local Dust CLI session so AskToto can connect to Dust without the user copy-pasting a key.
 *
 * The official Dust CLI (`@dust-tt/dust-cli`, command `dust login`) stores its session in the OS
 * keychain via keytar under service `dust-cli`, accounts: `access_token`, `workspace_sid`, `region`.
 * On macOS we read those generic-password items with the built-in `security` tool — no native module,
 * no rebuild. (Reading another app's keychain item triggers a one-time macOS "allow access" prompt.)
 *
 * The access token is an OAuth token and is short-lived: it works now and survives restarts until it
 * expires, after which the user re-runs the import (the CLI refreshes it on its next use).
 */

const ACCESS_TOKEN = 'access_token'
const WORKSPACE = 'workspace_sid'
const REGION = 'region'

/** Service name the Dust CLI (keytar) uses. Overridable only so the integration test can exercise the
 *  real `security` read path against a throwaway entry without touching the user's real Dust session. */
function service(): string {
  return process.env.DUST_CLI_KEYCHAIN_SERVICE || 'dust-cli'
}

async function keychainGet(account: string): Promise<string | null> {
  try {
    const { stdout } = await exec('security', [
      'find-generic-password',
      '-s',
      service(),
      '-a',
      account,
      '-w'
    ])
    const v = stdout.trim()
    return v || null
  } catch {
    // Item not present, or the user denied the keychain prompt.
    return null
  }
}

/** Dust CLI region id → API base URL. EU workspaces live on eu.dust.tt. */
function regionToBaseUrl(region: string | null): string {
  return region && /eu|europe/i.test(region) ? 'https://eu.dust.tt' : 'https://dust.tt'
}

/** Imported fields plus the bearer token (kept out of the renderer-facing DustCliImport). */
export type DustCliSession = DustCliImport & { token?: string }

export async function importDustCliSession(): Promise<DustCliSession> {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: 'Dust CLI import is macOS-only for now — paste your Dust API key + workspace ID manually.'
    }
  }
  const [token, workspaceId, region] = await Promise.all([
    keychainGet(ACCESS_TOKEN),
    keychainGet(WORKSPACE),
    keychainGet(REGION)
  ])
  if (!token || !workspaceId) {
    return {
      ok: false,
      error:
        'No Dust CLI session found. Run `npm i -g @dust-tt/dust-cli && dust login`, then click Connect again.'
    }
  }
  return { ok: true, token, workspaceId, baseUrl: regionToBaseUrl(region) }
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
export async function refreshDustCliSession(): Promise<DustCliSession> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Dust CLI refresh is macOS-only.' }
  }
  const bin = await resolveBin('dust')
  if (bin) {
    try {
      // CI=1 suppresses the spinner / update-check UI; the timeout bounds the network round-trip.
      await exec(bin, ['status'], { timeout: 25_000, env: { ...process.env, CI: '1' } })
    } catch {
      // ignore — fall through and re-read the keychain regardless of exit code
    }
  }
  return importDustCliSession()
}

/**
 * Kick off the Dust CLI setup for a user with no session yet. We write a small EXECUTABLE `.command`
 * script (install the CLI, then run the interactive `dust login`) and open it: macOS opens `.command`
 * files in Terminal and runs them directly, so this needs NO Automation permission (unlike telling
 * Terminal what to do via osascript, which silently fails until the user grants Automation access).
 * One click → a Terminal window walks them through it. `dust login` needs a browser OAuth, so it has to
 * run in a visible terminal. macOS only (matches importDustCliSession's keychain read).
 */
export async function setupDustCli(): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: 'Automatic setup is macOS-only for now. Run `npm i -g @dust-tt/dust-cli && dust login` in a terminal.'
    }
  }
  try {
    const script =
      [
        '#!/bin/bash',
        'clear',
        'echo "AskToto — Dust CLI setup"',
        'echo "========================"',
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
        'echo; echo "✓ Done. Go back to AskToto and click \\"Connect from Dust CLI\\" again."',
        'echo "You can close this window."'
      ].join('\n') + '\n'
    const scriptPath = join(app.getPath('temp'), 'asktoto-dust-setup.command')
    writeFileSync(scriptPath, script, { mode: 0o755 })
    const err = await shell.openPath(scriptPath) // opens in Terminal and runs it; no Automation permission
    if (err) return { ok: false, error: err }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
