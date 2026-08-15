/**
 * mcpSecrets.ts — storage for MCP connection API keys (BidStack CRM, Plane, …), keyed by connectionId.
 *
 * These are CRM/task-manager push credentials, not LLM providers — they deliberately do NOT go through
 * store.ts's setApiKey/getApiKey/clearApiKey, which are typed to ProviderId (the LLM-routing union).
 * Adding them there would conflate a push credential with the LLM provider list used for ask-routing,
 * model tiers, etc.
 *
 * Instead this module reuses the exact same on-disk primitive store.ts uses for provider keys —
 * secrets.ts's AES-256-GCM file backend, plus safeStorage on packaged builds where available — under a
 * per-connection file (key-mcp-<connectionId>.bin in userData), so MCP keys are stored with identical
 * at-rest protection without touching the ProviderId type.
 *
 * Legacy compatibility: connectionId 'bidstack' used to be the ONLY connection this module supported,
 * stored under key-bidstack.bin with marker ATKBID1. getMcpApiKey('bidstack') falls back to reading that
 * file when key-mcp-bidstack.bin doesn't exist yet, so an existing user's saved BidStack key keeps
 * working with no re-entry. The next setMcpApiKey('bidstack', …) (reconnect/save) writes to the new path
 * only — the old file is left on disk (harmless, matches the settings-migration policy in main/store.ts:
 * no active cleanup, no permanent dual-read branch that grows).
 */

import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { useFileBackend, encryptSecret, decryptSecret, prepareFileKeyForWrite } from '../secrets'
import { mainLog } from '../logger'

// Same marker convention as store.ts's AES_KEY_MARKER, distinct value so the two families never collide.
// A single marker works for every connectionId — AES-GCM encryption is already keyed to the file itself.
const AES_KEY_MARKER = Buffer.from('ATKMCP1\n')

const LEGACY_BIDSTACK_KEY_FILE = 'key-bidstack.bin'
const LEGACY_BIDSTACK_MARKER = Buffer.from('ATKBID1\n')

const keyPath = (connectionId: string): string => join(app.getPath('userData'), `key-mcp-${connectionId}.bin`)

// One in-memory cache per connectionId — mirrors bidstackSecrets.ts's single-slot `_cache`, generalized
// to a Map now that more than one connection can hold a key.
const cache = new Map<string, string>()

export function setMcpApiKey(connectionId: string, key: string): void {
  const trimmed = key.trim()
  const p = keyPath(connectionId)
  if (!trimmed) {
    clearMcpApiKey(connectionId)
    return
  }
  // Fail closed before overwriting: an existing ATKMCP1 blob may be encrypted under a file key this
  // machine can no longer unwrap (Windows DPAPI bound to another account), and those bytes are the
  // only copy. No-op on a profile that has no file key. Mirrors store.ts's setApiKey.
  prepareFileKeyForWrite()
  let blob: Buffer
  if (useFileBackend()) {
    blob = Buffer.concat([AES_KEY_MARKER, encryptSecret(trimmed)])
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Encryption is unavailable on this machine. Métis cannot safely store this API key.')
    }
    blob = safeStorage.encryptString(trimmed)
  }
  try {
    writeFileSync(p, blob, { mode: 0o600 })
  } catch (e) {
    throw new Error(
      `Couldn't save the API key — Métis can't write to its data folder${
        e instanceof Error && e.message ? ` (${e.message})` : ''
      }.`
    )
  }
  cache.set(connectionId, trimmed)
}

function readKeyFile(p: string, marker: Buffer): string {
  let key = ''
  try {
    const buf = readFileSync(p)
    if (buf.length > marker.length && buf.subarray(0, marker.length).equals(marker)) {
      try {
        key = decryptSecret(buf.subarray(marker.length))
      } catch {
        key = '' // corrupt or key rotated
      }
    } else if (!process.env.ASKTOTO_LOCAL_KEYSTORE && safeStorage.isEncryptionAvailable()) {
      try {
        key = safeStorage.decryptString(buf)
      } catch {
        /* not a safeStorage blob for this OS user — unreadable */
      }
    }
  } catch {
    /* file missing or unreadable */
  }
  return key
}

export function getMcpApiKey(connectionId: string): string {
  const cached = cache.get(connectionId)
  if (cached !== undefined) return cached
  let key = readKeyFile(keyPath(connectionId), AES_KEY_MARKER)
  // Legacy fallback: an existing BidStack connection whose key still lives at the pre-generalization
  // path. Only consulted when the new-path file has nothing readable — a real key-mcp-bidstack.bin
  // always wins.
  if (!key && connectionId === 'bidstack') {
    key = readKeyFile(join(app.getPath('userData'), LEGACY_BIDSTACK_KEY_FILE), LEGACY_BIDSTACK_MARKER)
  }
  cache.set(connectionId, key)
  return key
}

export function hasMcpApiKey(connectionId: string): boolean {
  return getMcpApiKey(connectionId).length > 0
}

/** Returns false if the on-disk key file could not be deleted (the in-memory cache is always cleared) —
 *  so the disconnect handler can tell the user their key wasn't actually removed instead of falsely
 *  reporting success while the secret survives on disk. */
export function clearMcpApiKey(connectionId: string): boolean {
  const p = keyPath(connectionId)
  let ok = true
  if (existsSync(p)) {
    try {
      rmSync(p)
    } catch (e) {
      mainLog.warn(`[mcp:${connectionId}] could not delete key file`, e)
      ok = false
    }
  }
  // A disconnect must actually remove the secret — leaving the pre-generalization key-bidstack.bin
  // behind would let a later getMcpApiKey('bidstack') resurrect the "cleared" key from the legacy file
  // once the in-memory cache is gone (e.g. after a restart), silently undoing the disconnect.
  if (connectionId === 'bidstack') {
    const legacy = join(app.getPath('userData'), LEGACY_BIDSTACK_KEY_FILE)
    if (existsSync(legacy)) {
      try {
        rmSync(legacy)
      } catch (e) {
        mainLog.warn('[mcp:bidstack] could not delete legacy key file', e)
        ok = false
      }
    }
  }
  if (!ok) {
    // Invalidate only — don't assert the key is empty. An encrypted file may still be on disk with the
    // real secret, so the next read should recompute from disk instead of lying "no key".
    cache.delete(connectionId)
    return false
  }
  cache.set(connectionId, '')
  return true
}
