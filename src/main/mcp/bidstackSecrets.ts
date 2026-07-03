/**
 * bidstackSecrets.ts — storage for the BidStack CRM API key.
 *
 * BidStack is a CRM credential, not an LLM provider — it deliberately does NOT go through
 * store.ts's setApiKey/getApiKey/clearApiKey, which are typed to ProviderId (the LLM-routing
 * union). Adding 'bidstack' there would conflate a CRM push credential with the LLM provider
 * list used for ask-routing, model tiers, etc.
 *
 * Instead this module reuses the exact same on-disk primitive store.ts uses for provider keys —
 * secrets.ts's AES-256-GCM file backend, plus safeStorage on packaged builds where available —
 * under its own dedicated file (key-bidstack.bin in userData), so BidStack keys are stored with
 * identical at-rest protection without touching the ProviderId type.
 */

import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { useFileBackend, encryptSecret, decryptSecret } from '../secrets'
import { mainLog } from '../logger'

const KEY_FILE = 'key-bidstack.bin'
// Same marker convention as store.ts's AES_KEY_MARKER, distinct value so the two families never collide.
const AES_KEY_MARKER = Buffer.from('ATKBID1\n')

const keyPath = (): string => join(app.getPath('userData'), KEY_FILE)

let _cache: string | null = null

export function setBidstackApiKey(key: string): void {
  const trimmed = key.trim()
  const p = keyPath()
  if (!trimmed) {
    clearBidstackApiKey()
    return
  }
  let blob: Buffer
  if (useFileBackend()) {
    blob = Buffer.concat([AES_KEY_MARKER, encryptSecret(trimmed)])
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'Encryption is unavailable on this machine. AskToto cannot safely store the Polo Pre-Sales API key.'
      )
    }
    blob = safeStorage.encryptString(trimmed)
  }
  try {
    writeFileSync(p, blob, { mode: 0o600 })
  } catch (e) {
    throw new Error(
      `Couldn't save the Polo Pre-Sales API key — AskToto can't write to its data folder${
        e instanceof Error && e.message ? ` (${e.message})` : ''
      }.`
    )
  }
  _cache = trimmed
}

export function getBidstackApiKey(): string {
  if (_cache !== null) return _cache
  const p = keyPath()
  let key = ''
  try {
    const buf = readFileSync(p)
    if (buf.length > AES_KEY_MARKER.length && buf.subarray(0, AES_KEY_MARKER.length).equals(AES_KEY_MARKER)) {
      try {
        key = decryptSecret(buf.subarray(AES_KEY_MARKER.length))
      } catch {
        key = '' // corrupt or key rotated
      }
    } else if (safeStorage.isEncryptionAvailable()) {
      try {
        key = safeStorage.decryptString(buf)
      } catch {
        /* not a safeStorage blob for this OS user — unreadable */
      }
    }
  } catch {
    /* file missing or unreadable */
  }
  _cache = key
  return key
}

export function hasBidstackApiKey(): boolean {
  return getBidstackApiKey().length > 0
}

export function clearBidstackApiKey(): void {
  const p = keyPath()
  if (existsSync(p)) {
    try {
      rmSync(p)
    } catch (e) {
      mainLog.warn('[bidstack] could not delete key file', e)
    }
  }
  _cache = ''
}
