import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DustCliImport } from '@shared/ipc'

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
