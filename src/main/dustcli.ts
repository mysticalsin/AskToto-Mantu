import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { DustCliImport } from '@shared/ipc'
import { resolveBin } from './cli'
import { clearApiKey, setSettings } from './store'

const exec = promisify(execFile)

/**
 * Read the local Dust CLI session so Métis can connect to Dust without the user copy-pasting a key.
 *
 * The official Dust CLI (`@dust-tt/dust-cli`, command `dust login`) stores its session in the OS
 * keychain via keytar under service `dust-cli`, accounts: `access_token`, `workspace_sid`, `region`.
 *   - macOS: read those generic-password items with the built-in `security` tool.
 *   - Windows: keytar writes generic credentials whose target name is `<service>/<account>` and whose
 *     CredentialBlob is the UTF-8 bytes of the value; we read them with a short PowerShell script that
 *     P/Invokes advapi32 CredReadW. Both paths use a built-in OS tool — no native module, no rebuild.
 * (On macOS, reading another app's keychain item triggers a one-time "allow access" prompt.)
 *
 * The access token is an OAuth token and is short-lived: it works now and survives restarts until it
 * expires, after which the user re-runs the import (the CLI refreshes it on its next use).
 */

const ACCESS_TOKEN = 'access_token'
const WORKSPACE = 'workspace_sid'
const REGION = 'region'

/** Service name the Dust CLI (keytar) uses. Overridable only so the integration test can exercise the
 *  real read path against a throwaway entry without touching the user's real Dust session. */
function service(): string {
  return process.env.DUST_CLI_KEYCHAIN_SERVICE || 'dust-cli'
}

interface KeychainRead {
  value: string | null
  accessDenied: boolean
}

function keychainAccessDenied(error: unknown): boolean {
  const e = error as { stderr?: string; message?: string }
  return /user interaction is not allowed|authorization.*denied|errsec(authfailed|interactionnotallowed)|\b-2529[13]\b/i.test(
    `${e?.stderr || ''}\n${e?.message || ''}`
  )
}

async function keychainGet(account: string): Promise<KeychainRead> {
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
    return { value: v || null, accessDenied: false }
  } catch (error) {
    return { value: null, accessDenied: keychainAccessDenied(error) }
  }
}

/** Dust CLI region id → API base URL. EU workspaces live on eu.dust.tt. */
function regionToBaseUrl(region: string | null): string {
  return region && /eu|europe/i.test(region) ? 'https://eu.dust.tt' : 'https://dust.tt'
}

// ─── Windows credential-manager read (keytar layout) ───────────────────────────────────────────
// Absolute System32 path for powershell.exe — never trust PATH for a security-sensitive spawn, matching
// the trust posture in cli.ts (pin Windows system tools to their System32 location).
function windowsPowershell(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Read the Dust CLI's three keytar credentials from Windows Credential Manager in one PowerShell call.
 * Returns nulls on ANY failure (no CLI session, blocked, malformed) so callers degrade to the manual
 * paste-key path exactly as before — this is strictly additive and never throws into the answer path.
 */
async function readDustSessionWin(): Promise<{ token: string | null; workspace: string | null; region: string | null }> {
  const svc = service()
  // Defensive: the service name is inlined into the PS script; only allow a safe identifier (prod value
  // is the constant 'dust-cli'; the test override is a throwaway). Anything else → no read.
  if (!/^[A-Za-z0-9._-]+$/.test(svc)) return { token: null, workspace: null, region: null }
  const ps = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type -TypeDefinition @"',
    'using System;using System.Runtime.InteropServices;using System.Text;',
    'public class MetisCred{',
    '[DllImport("advapi32",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CredReadW(string t,int y,int f,out IntPtr c);',
    '[DllImport("advapi32")] static extern void CredFree(IntPtr c);',
    '[StructLayout(LayoutKind.Sequential)] struct CREDENTIAL{public int Flags;public int Type;public IntPtr TargetName;public IntPtr Comment;public long LastWritten;public int BlobSize;public IntPtr Blob;public int Persist;public int AttrCount;public IntPtr Attrs;public IntPtr TargetAlias;public IntPtr UserName;}',
    'public static string Read(string target){IntPtr p;if(!CredReadW(target,1,0,out p))return null;try{var c=(CREDENTIAL)Marshal.PtrToStructure(p,typeof(CREDENTIAL));if(c.BlobSize==0)return "";byte[] b=new byte[c.BlobSize];Marshal.Copy(c.Blob,b,0,c.BlobSize);return Encoding.UTF8.GetString(b);}finally{CredFree(p);}}}',
    '"@',
    `$svc = '${svc}'`,
    '$o = [ordered]@{ token = [MetisCred]::Read("$svc/' + ACCESS_TOKEN + '"); workspace = [MetisCred]::Read("$svc/' + WORKSPACE + '"); region = [MetisCred]::Read("$svc/' + REGION + '") }',
    '[Console]::Out.Write(($o | ConvertTo-Json -Compress))'
  ].join('\n')
  try {
    const { stdout } = await exec(windowsPowershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
    const parsed = JSON.parse(stdout.trim() || '{}') as { token?: string | null; workspace?: string | null; region?: string | null }
    const norm = (v: string | null | undefined): string | null => (v && String(v).trim()) || null
    return { token: norm(parsed.token), workspace: norm(parsed.workspace), region: norm(parsed.region) }
  } catch {
    return { token: null, workspace: null, region: null }
  }
}

/** Imported fields plus the bearer token (kept out of the renderer-facing DustCliImport). */
export type DustCliSession = DustCliImport & { token?: string }

const WINDOWS_NEEDS_SETUP =
  'No Dust CLI session found. Use "Connect from Dust CLI" to install it and sign in — Métis connects automatically after login.'

export async function importDustCliSession(): Promise<DustCliSession> {
  if (process.platform === 'win32') {
    const s = await readDustSessionWin()
    if (!s.token) return { ok: false, error: WINDOWS_NEEDS_SETUP }
    if (!s.workspace) return { ok: false, error: 'Your Dust CLI session is incomplete. Run the Dust login again, then return to Métis.' }
    return { ok: true, token: s.token, workspaceId: s.workspace, baseUrl: regionToBaseUrl(s.region) }
  }
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: 'On this platform, paste your Dust API key or workspace link instead — Settings → AI → Dust.'
    }
  }
  // Read sequentially: a macOS permission dialog is per lookup, and parallel `security` calls can
  // stack prompts or make a single denial look like a missing Dust CLI session.
  const token = await keychainGet(ACCESS_TOKEN)
  if (token.accessDenied) {
    return { ok: false, error: 'Allow Métis to access your Dust CLI session in Keychain, then try again.' }
  }
  if (!token.value) {
    return {
      ok: false,
      error:
        'No Dust CLI session found. Run `npm i -g @dust-tt/dust-cli && dust login`; Métis connects automatically after login.'
    }
  }
  const workspace = await keychainGet(WORKSPACE)
  if (workspace.accessDenied) {
    return { ok: false, error: 'Allow Métis to access your Dust CLI workspace in Keychain, then try again.' }
  }
  if (!workspace.value) {
    return { ok: false, error: 'Your Dust CLI session is incomplete. Run `dust login` again, then return to Métis.' }
  }
  const region = await keychainGet(REGION)
  if (region.accessDenied) {
    return { ok: false, error: 'Allow Métis to access your Dust CLI region in Keychain, then try again.' }
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
 * this recovers a working token with no re-login.
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

/** Run `dust status` so the CLI rotates its keychain access token. Platform-specific spawn: a Windows
 *  `dust` is a `.cmd` shim that must be launched through cmd.exe (execFile can't run a batch directly). */
async function runDustStatusRefresh(): Promise<void> {
  const bin = await resolveBin('dust')
  if (!bin) return
  try {
    if (process.platform === 'win32') {
      const comspec = process.env.ComSpec || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
      // cmd /d /s /c ""<shim>" status" — the doubled outer quotes are cmd's own quoting rule; CI=1 mutes
      // the CLI's spinner/update UI; windowsHide keeps the console off-screen (this is a background mint).
      await exec(comspec, ['/d', '/s', '/c', `""${bin}" status"`], {
        timeout: 25_000,
        env: { ...process.env, CI: '1' },
        windowsHide: true
      })
    } else {
      await exec(bin, ['status'], { timeout: 25_000, env: { ...process.env, CI: '1' } })
    }
  } catch {
    // ignore — fall through and re-read whatever the CLI left in the keychain regardless of exit code
  }
}

export async function refreshDustCliSession(): Promise<DustCliSession> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return {
      ok: false,
      error: 'On this platform, paste your Dust API key or workspace link instead — Settings → AI → Dust.'
    }
  }
  if (refreshInflight) return refreshInflight
  if (lastRefresh && lastRefresh.session.ok && Date.now() - lastRefresh.at < REFRESH_RESULT_TTL_MS) {
    return lastRefresh.session
  }
  refreshInflight = (async () => {
    try {
      await runDustStatusRefresh()
      const s = await importDustCliSession()
      lastRefresh = { at: Date.now(), session: s }
      return s
    } finally {
      refreshInflight = null
    }
  })()
  return refreshInflight
}

/**
 * Kick off the Dust CLI setup for a user with no session yet: install the CLI, then run the interactive
 * `dust login`. We write a small EXECUTABLE script and open it — the OS runs it in a visible terminal so
 * the browser OAuth `dust login` can complete and the user can watch progress:
 *   - macOS:  a `.command` bash script (Finder opens `.command` in Terminal and runs it — no Automation
 *             permission needed, unlike driving Terminal via osascript).
 *   - Windows: a `.cmd` batch script (the shell "open" verb runs a batch in a console window; `pause`
 *             keeps it up so the user sees the result).
 * One click → a terminal window walks them through it. After login, the setup poll (index.ts) re-reads
 * the CLI session and connects Métis automatically.
 */
export async function setupDustCli(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (process.platform === 'win32') {
      const script =
        [
          '@echo off',
          'setlocal',
          'title Metis - Dust CLI setup',
          'echo Metis - Dust CLI setup',
          'echo ========================',
          'echo.',
          'where npm >nul 2>nul',
          'if errorlevel 1 (',
          '  echo npm / Node.js not found. Install Node from https://nodejs.org then run this again.',
          '  echo.',
          '  pause',
          '  exit /b 1',
          ')',
          'echo Step 1/2  Installing the Dust CLI ^(npm i -g @dust-tt/dust-cli^)...',
          'call npm i -g @dust-tt/dust-cli',
          'if errorlevel 1 (',
          '  echo.',
          '  echo Install failed ^(often a permissions issue with global npm^).',
          '  echo Try re-running this as Administrator, then run it again.',
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
      const scriptPath = join(app.getPath('temp'), `asktoto-dust-setup-${randomBytes(8).toString('hex')}.cmd`)
      writeFileSync(scriptPath, script, { flag: 'wx' })
      const err = await shell.openPath(scriptPath) // runs the .cmd in a console window (open verb)
      if (err) return { ok: false, error: err }
      return { ok: true }
    }
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        error: 'On this platform, paste your Dust API key or workspace link instead — Settings → AI → Dust.'
      }
    }
    const script =
      [
        '#!/bin/bash',
        'clear',
        'echo "Métis — Dust CLI setup"',
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
        'echo; echo "✓ Done. Return to Métis — it will connect automatically after login."',
        'echo "You can close this window."'
      ].join('\n') + '\n'
    const scriptPath = join(app.getPath('temp'), `asktoto-dust-setup-${randomBytes(8).toString('hex')}.command`)
    writeFileSync(scriptPath, script, { mode: 0o755, flag: 'wx' })
    const err = await shell.openPath(scriptPath) // opens in Terminal and runs it; no Automation permission
    if (err) return { ok: false, error: err }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
