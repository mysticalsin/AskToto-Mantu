/**
 * The production clearers: what each credential in the inventory means in this build (Métis 2.12 G20).
 *
 * `productionClearers()` maps every credential the inventory can ask to clear onto the real function that removes
 * it, through the owning module's own API so its in-memory cache goes with the file (a key deleted from disk but
 * kept in a cache would keep working after "sign out"). File credentials are found by the inventory's own file
 * matchers over the profile folder, so a key file for a provider or connection added later is cleared without
 * editing this file. Settings credentials are reset to their schema defaults for exactly the keys the inventory
 * lists. A clearer reports `cleared`, `nothing` (nothing was there), `refused` (a stored value could not be read to
 * decide) or throws, which the executor records as failed. None of them logs a value, a path or an error message.
 */
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { credentialEntry, type CredentialEntry, type CredentialId } from '@shared/credential-inventory'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'
import type { ProviderId } from '@shared/providers'
import { invalidateSpeechAuthLease } from './auth'
import type { CredentialClearOutcome, CredentialClearers } from './credential-cleanup'
import { lastCredentialReadRefusal } from './credential-read-denial'
import { clearSeededDustCliSession, seededDustTokenForDisconnect } from './dust-cli-chat'
import { retireDustOAuthSession } from './dust-oauth'
import { clearLicenseCache } from './license/secret-store'
import { resetHeadroom } from './llm/usage-headroom'
import { resetProviderHealth } from './llm/provider-health'
import { auditLog } from './logger'
import { clearMcpApiKey, clearMcpClientSecret, clearMcpRefreshToken } from './mcp/mcpSecrets'
import { clearOperatorSeat } from './operator-license-service'
import { clearApiKey, clearDustRefreshToken, clearSonioxApiKey, getApiKey, getSettings, setSettings } from './store'

/** Disconnect one provider: remove its key, its health and budget memory, and for Dust the whole credential pair. */
export async function disconnectProvider(provider: ProviderId): Promise<{ dustRefreshRemoved: boolean }> {
  // Read the seeded token BEFORE the key is cleared; a session imported from the user's own CLI is never cleaned.
  const seeded =
    provider === 'dust' ? seededDustTokenForDisconnect(getSettings().dustSessionOrigin, getApiKey('dust')) : ''
  clearApiKey(provider)
  resetProviderHealth(provider) // the old key's verdict and remaining budget mean nothing for a new key
  resetHeadroom(provider)
  // Dust's credential is a PAIR (key + refresh token) and Spotlight seeds the key into the shared dust-cli keychain.
  let dustRefreshRemoved = true
  if (provider === 'dust') {
    dustRefreshRemoved = retireDustOAuthSession()
    void clearSeededDustCliSession(seeded)
  }
  auditLog('key.removed', { provider, ...(provider === 'dust' ? { dustRefreshRemoved } : {}) })
  return { dustRefreshRemoved }
}

/** Profile-folder file names the inventory assigns to this credential. */
async function profileFiles(id: CredentialId): Promise<string[]> {
  const holder = credentialEntry(id).holder
  if (holder.kind !== 'keystore-file') return []
  let names: string[] = []
  try {
    names = await readdir(app.getPath('userData'))
  } catch {
    return []
  }
  return names.filter((name) => holder.files.some((file) => file.match.test(name)))
}

/** `key-mcp-plane-refresh.bin` -> `plane`; the pre-generalisation `key-bidstack.bin` -> `bidstack`. */
const connectionIdOf = (name: string): string =>
  name === 'key-bidstack.bin' ? 'bidstack' : name.replace(/^key-mcp-/, '').replace(/(?:-refresh|-client)?\.bin$/, '')

const settled = (ok: boolean, any: boolean): CredentialClearOutcome => (!ok ? 'failed' : any ? 'cleared' : 'nothing')

/** The settings patch that returns an entry's secret and companion keys to their schema defaults. */
function settingsResetPatch(entries: readonly CredentialEntry[]): Partial<Settings> {
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  for (const entry of entries) {
    for (const key of [...entry.secretSettingsKeys, ...entry.companionSettingsKeys]) {
      if (Object.hasOwn(defaults, key)) patch[key] = defaults[key]
    }
  }
  return patch as Partial<Settings>
}

/** Keys in a patch whose current value differs from the patch: what a reset would actually change. */
function changedBy(patch: Partial<Settings>): boolean {
  const current = getSettings() as unknown as Record<string, unknown>
  return Object.entries(patch).some(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value))
}

async function removeFiles(id: CredentialId): Promise<CredentialClearOutcome> {
  const names = await profileFiles(id)
  for (const name of names) await rm(join(app.getPath('userData'), name), { force: true })
  return settled((await profileFiles(id)).length === 0, names.length > 0)
}

export function productionClearers(): CredentialClearers {
  const operatorEntries = (['operator-licence', 'operator-reporting-token', 'operator-ingest-secret'] as const).map(
    credentialEntry
  )
  const clearOperatorSettings = (): CredentialClearOutcome => {
    // The three Operator entries share one patch and one runtime restart, so this clearer is shared and runs once.
    const patch = settingsResetPatch(operatorEntries)
    if (!changedBy(patch)) return 'nothing'
    clearOperatorSeat(patch)
    return 'cleared'
  }
  const clearMemberLicenceSettings = (): CredentialClearOutcome => {
    const patch = settingsResetPatch([credentialEntry('member-licence-key')])
    if (!changedBy(patch)) return 'nothing'
    setSettings(patch)
    return 'cleared'
  }
  const clearMcp =
    (id: 'mcp-api-key' | 'mcp-oauth-refresh' | 'mcp-oauth-client-secret') =>
    async (): Promise<CredentialClearOutcome> => {
      const names = await profileFiles(id)
      let ok = true
      for (const name of names) {
        const connection = connectionIdOf(name)
        if (id === 'mcp-api-key') ok = clearMcpApiKey(connection) && ok
        else if (id === 'mcp-oauth-refresh') ok = clearMcpRefreshToken(connection) && ok
        else ok = clearMcpClientSecret(connection) && ok
      }
      if (id === 'mcp-api-key' && names.length > 0) {
        // The connection list must not claim a connection whose key is gone.
        const s = getSettings()
        if (s.mcpConnections.some((c) => c.connected || c.tools.length > 0))
          setSettings({ mcpConnections: s.mcpConnections.map((c) => ({ ...c, connected: false, tools: [] })) })
      }
      return settled(ok, names.length > 0)
    }

  return {
    'provider-api-key': async () => {
      const names = await profileFiles('provider-api-key')
      for (const name of names) await disconnectProvider(name.slice('key-'.length, -'.bin'.length) as ProviderId)
      return settled((await profileFiles('provider-api-key')).length === 0, names.length > 0)
    },
    'soniox-api-key': async () => {
      if ((await profileFiles('soniox-api-key')).length === 0) return 'nothing'
      clearSonioxApiKey() // throws when the file survives; the executor records that as failed
      return 'cleared'
    },
    'msal-cache': () => removeFiles('msal-cache'),
    'auth-session': () => removeFiles('auth-session'),
    'legacy-google-session': () => removeFiles('legacy-google-session'),
    'speech-auth-lease': () => {
      invalidateSpeechAuthLease()
      return 'cleared'
    },
    'operator-licence': clearOperatorSettings,
    'operator-reporting-token': clearOperatorSettings,
    'operator-ingest-secret': clearOperatorSettings,
    'dust-oauth-refresh': async () => {
      if ((await profileFiles('dust-oauth-refresh')).length === 0) return 'nothing'
      return clearDustRefreshToken() ? 'cleared' : 'failed'
    },
    'dust-cli-seed': async () => {
      const token = seededDustTokenForDisconnect(getSettings().dustSessionOrigin, getApiKey('dust'))
      if (!token) return lastCredentialReadRefusal('provider-api-key', 'dust') ? 'refused' : 'nothing'
      return (await clearSeededDustCliSession(token)).cleared ? 'cleared' : 'nothing'
    },
    'mcp-api-key': clearMcp('mcp-api-key'),
    'mcp-oauth-refresh': clearMcp('mcp-oauth-refresh'),
    'mcp-oauth-client-secret': clearMcp('mcp-oauth-client-secret'),
    'member-licence-key': clearMemberLicenceSettings,
    'member-licence-cache': async () => {
      if ((await profileFiles('member-licence-cache')).length === 0) return 'nothing'
      clearLicenseCache()
      return 'cleared'
    }
  }
}
