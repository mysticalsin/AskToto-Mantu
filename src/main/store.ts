import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import {
  DEFAULT_SETTINGS,
  BaseSettingsSchema,
  SettingsSchema,
  type Settings,
  type DustAgentsResponse
} from '@shared/ipc'
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from '@shared/providers'
import { mainLog } from './logger'
import { useFileBackend, encryptSecret, decryptSecret } from './secrets'

const dir = () => app.getPath('userData')
const settingsPath = () => join(dir(), 'settings.json')
const keyPath = (provider: ProviderId) => join(dir(), `key-${provider}.bin`)

const ENV_VAR: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  dust: 'DUST_API_KEY',
  'claude-cli': '',
  'codex-cli': '',
  gemini: 'GEMINI_API_KEY',
  custom: 'ASKTOTO_CUSTOM_API_KEY'
}

function ensureDir(): void {
  const d = dir()
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
}

type Shape = Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>
const shape = (): Shape => BaseSettingsSchema.shape as unknown as Shape

/** Keep only the individually-valid keys of an arbitrary object against the settings schema. */
function validKeysOnly(obj: Record<string, unknown>): Record<string, unknown> {
  const s = shape()
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!s[k] || v === undefined) continue
    const r = s[k].safeParse(v)
    if (r.success) out[k] = r.data
  }
  return out
}

function readManagedFrom(p: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8'))
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) if (!k.startsWith('_')) clean[k] = v
    return validKeysOnly(clean) // drop malformed keys so a typo can't brick the app
  } catch {
    return {}
  }
}

function readLockedFrom(p: string): string[] {
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8'))
    const arr: unknown[] = Array.isArray(obj.locked) ? obj.locked : []
    return [...new Set(arr.filter((k): k is string => typeof k === 'string'))]
  } catch {
    return []
  }
}

/** Read the `allowedProviders` policy array straight from a raw managed-config file. It is NOT a settings
 *  key, so it must be read here rather than via validatedManaged() (which drops non-schema keys). */
function readAllowedFrom(p: string): string[] | null {
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8'))
    const arr: unknown[] = Array.isArray(obj?.allowedProviders) ? obj.allowedProviders : []
    const list = [...new Set(arr.filter((x): x is string => typeof x === 'string'))]
    return list.length ? list : null
  } catch {
    return null
  }
}

/** Machine-wide org-policy location IT can deploy (admin-only write). */
function adminManagedPath(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/AskToto/managed-config.json'
  if (process.platform === 'win32')
    return join(process.env.ProgramData || 'C:\\ProgramData', 'AskToto', 'managed-config.json')
  return '/etc/asktoto/managed-config.json'
}

/** Enterprise managed defaults: per-user (userData) overlaid by machine-wide admin policy. Validated. */
export function validatedManaged(): Record<string, unknown> {
  return {
    ...readManagedFrom(join(dir(), 'managed-config.json')),
    ...readManagedFrom(adminManagedPath()) // machine policy wins over the per-user file
  }
}

/** Keys that IT has locked; user edits to these are silently dropped. */
export function getLockedKeys(): string[] {
  const user = readLockedFrom(join(dir(), 'managed-config.json'))
  const machine = readLockedFrom(adminManagedPath())
  return [...new Set([...user, ...machine])]
}

/**
 * Optional org allowlist of LLM provider ids (data-residency / governance), from managed-config
 * `allowedProviders`. Null = no restriction (all providers allowed). Enforced in the main process before
 * any screen/transcript egress, so a policy can confine data to approved/DPA-backed providers.
 */
export function getAllowedProviders(): string[] | null {
  // Machine (admin) policy wins over the per-user managed file, mirroring validatedManaged() precedence.
  // Read from the raw JSON because `allowedProviders` is a policy key, not a settings-schema key.
  return readAllowedFrom(adminManagedPath()) ?? readAllowedFrom(join(dir(), 'managed-config.json'))
}

/** Providers whose key currently comes from an environment variable — for those, in-app 'Remove' is a
 *  no-op (the env still resolves), so the UI shows a 'set via environment variable' chip instead. */
export function getEnvKeyProviders(): string[] {
  return PROVIDER_IDS.filter((p) => !!process.env[ENV_VAR[p]])
}

// Sensitive user data (context docs = pasted reference material, profile = resume/JD/notes) lives in
// settings.json. Encrypt the whole user-overrides file at rest so it isn't readable as plaintext on disk.
//
// Two on-disk formats:
//   ATKENC2\n + AES-GCM blob  — written by the file backend (dev / ASKTOTO_LOCAL_KEYSTORE / no keychain)
//   ATKENC1\n + safeStorage   — legacy prod format; migrated to ATKENC2 on next read/write in file-backend
//   raw JSON                  — legacy plaintext; migrated to ATKENC2 on next write
const ENC_MARKER_V1 = Buffer.from('ATKENC1\n') // legacy: safeStorage (prod)
const ENC_MARKER_V2 = Buffer.from('ATKENC2\n') // new: AES-GCM file backend

/** Sparse user overrides (only keys the user actually changed). Decrypts at-rest encryption. */
function readUserRaw(): Record<string, unknown> {
  let buf: Buffer
  try {
    buf = readFileSync(settingsPath())
  } catch {
    return {} // no file yet
  }

  // ── New AES-GCM format (file backend) ────────────────────────────────────────
  if (buf.length >= ENC_MARKER_V2.length && buf.subarray(0, ENC_MARKER_V2.length).equals(ENC_MARKER_V2)) {
    try {
      return JSON.parse(decryptSecret(buf.subarray(ENC_MARKER_V2.length)))
    } catch {
      return {} // Corrupt or key rotated — don't brick the app
    }
  }

  // ── Legacy safeStorage format (ATKENC1) — migrate to file backend on next write ──
  if (buf.length >= ENC_MARKER_V1.length && buf.subarray(0, ENC_MARKER_V1.length).equals(ENC_MARKER_V1)) {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const data = JSON.parse(safeStorage.decryptString(buf.subarray(ENC_MARKER_V1.length)))
        // Best-effort migration: write the current backend format so subsequent reads don't need safeStorage.
        if (useFileBackend()) {
          try {
            const p = settingsPath()
            const tmp = `${p}.tmp`
            writeFileSync(tmp, serializeUserRaw(data), { mode: 0o600 })
            renameSync(tmp, p)
          } catch { /* migration is best-effort; old format still works */ }
        }
        return data
      } catch {
        return {} // Undecryptable (keychain/OS user changed) — fall back to defaults
      }
    }
    return {} // safeStorage unavailable + V1 file = unreadable; fall back to defaults
  }

  // ── Legacy plaintext ─────────────────────────────────────────────────────────
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return {}
  }
}

/** Serialize user overrides, encrypted at rest. */
function serializeUserRaw(obj: Record<string, unknown>): Buffer {
  const json = JSON.stringify(obj, null, 2)
  if (useFileBackend()) {
    return Buffer.concat([ENC_MARKER_V2, encryptSecret(json)])
  }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return Buffer.concat([ENC_MARKER_V1, safeStorage.encryptString(json)])
    }
  } catch {
    /* keychain not ready — write plaintext below */
  }
  return Buffer.from(json, 'utf8')
}

// ─── Settings memoisation ────────────────────────────────────────────────────────
// getSettings() is called on every IPC handler and every /ask. The full parse path includes an AES
// decrypt of settings.json + JSON parse + Zod validation — expensive at conversation pace.
// Strategy: cache the parsed result keyed on the mtimes of all three on-disk inputs so that:
//   • user writes (setSettings) are picked up via a changed settings.json mtime, and
//   • org-policy changes (IT edits managed-config) are picked up via changed managed-config mtimes
//     without requiring an app restart.
// Cache is also explicitly invalidated in setSettings / setApiKey / clearApiKey for safety.

function safeMtime(p: string): number {
  try { return statSync(p).mtimeMs } catch { return 0 }
}

interface SettingsCache {
  value: Settings
  userMtime: number
  managedMtime: number
  adminMtime: number
}
let _settingsCache: SettingsCache | null = null

function currentSettingsMtimes(): Pick<SettingsCache, 'userMtime' | 'managedMtime' | 'adminMtime'> {
  return {
    userMtime: safeMtime(settingsPath()),
    managedMtime: safeMtime(join(dir(), 'managed-config.json')),
    adminMtime: safeMtime(adminManagedPath())
  }
}

export function getSettings(): Settings {
  const m = currentSettingsMtimes()
  if (
    _settingsCache &&
    _settingsCache.userMtime === m.userMtime &&
    _settingsCache.managedMtime === m.managedMtime &&
    _settingsCache.adminMtime === m.adminMtime
  ) {
    return _settingsCache.value
  }

  // Layering: DEFAULT < managed (org policy, live) < user overrides.
  const base = { ...DEFAULT_SETTINGS, ...validatedManaged() }
  const raw = readUserRaw()
  // Locked keys are authoritative on READ too, not just on write: a value persisted before a lock (or a
  // hand-edited settings.json) must not override the managed/default value. Strip locked keys from the
  // user layer so org policy always wins.
  const lockedKeys = getLockedKeys()
  if (lockedKeys.length) for (const k of lockedKeys) delete (raw as Record<string, unknown>)[k]
  const whole = SettingsSchema.safeParse({ ...base, ...raw })
  let value: Settings
  if (whole.success) {
    value = whole.data
  } else {
    // Tolerant migration: base is already valid; keep only the user keys that still validate, then
    // repair the one cross-field invariant (provider:'custom' needs an https customBaseUrl) so a stale
    // settings.json can NEVER make getSettings throw and brick every IPC handler that reads it.
    const merged: Record<string, unknown> = { ...base, ...validKeysOnly(raw) }
    if (merged.provider === 'custom' && !/^https:\/\//i.test(String(merged.customBaseUrl ?? ''))) {
      // Reset to a provider-INDEPENDENT safe default — base.provider can itself be the invalid 'custom'
      // (e.g. from managed-config), which would make the repair a no-op and getSettings throw org-wide.
      merged.provider = DEFAULT_SETTINGS.provider
    }
    const repaired = SettingsSchema.safeParse(merged)
    value = repaired.success ? repaired.data : SettingsSchema.parse(DEFAULT_SETTINGS) // always valid
  }

  _settingsCache = { value, ...m }
  return value
}

export function setSettings(patch: Partial<Settings>): Settings {
  ensureDir()
  // Validate the incoming patch (drop malformed keys), then persist ONLY user overrides (sparse)
  // so managed-config stays a live default layer.
  const clean = validKeysOnly((patch ?? {}) as Record<string, unknown>)
  const locked = getLockedKeys()
  const allowed: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(clean)) {
    if (locked.includes(k)) {
      mainLog.warn(`[store] ignoring locked setting "${k}"`)
      continue
    }
    allowed[k] = v
  }
  const next = { ...readUserRaw(), ...allowed }
  // Atomic write: a crash mid-write must not corrupt settings.json and wipe every setting + context doc.
  // Encrypted at rest (context docs + profile PII never hit disk as plaintext).
  const p = settingsPath()
  const tmp = `${p}.tmp`
  try {
    writeFileSync(tmp, serializeUserRaw(next), { mode: 0o600 })
    renameSync(tmp, p)
  } catch (e) {
    try {
      if (existsSync(tmp)) rmSync(tmp) // don't leave an orphaned .tmp behind
    } catch {
      /* ignore */
    }
    throw new Error(
      `Couldn't save settings — AskToto can't write to its data folder${
        e instanceof Error && e.message ? ` (${e.message})` : ''
      }. Check that the disk isn't full and the folder is writable.`
    )
  }
  _settingsCache = null // invalidate so getSettings re-reads the just-written file
  return getSettings()
}

// Format marker prepended to AES-GCM encrypted key blobs (8 bytes, ASCII, no clash with safeStorage blobs).
const AES_KEY_MARKER = Buffer.from('ATKAES1\n')

// ─── API-key memoisation ─────────────────────────────────────────────────────────
// getApiKey() is called inside every IPC handler that needs the key (ask, test, dust agents…).
// Each call hits the filesystem + runs AES-GCM decryption. Cache per provider; invalidated on
// setApiKey / clearApiKey so a rotation is always reflected immediately.
const _apiKeyCache = new Map<ProviderId, string>()

export function setApiKey(provider: ProviderId, key: string): void {
  ensureDir()
  const trimmed = key.trim()
  const p = keyPath(provider)
  if (!trimmed) {
    // Empty input = clear the saved key (env keys are never written here).
    clearApiKey(provider)
    return
  }
  let blob: Buffer
  if (useFileBackend()) {
    // AES-GCM file backend — always available, never touches the keychain.
    blob = Buffer.concat([AES_KEY_MARKER, encryptSecret(trimmed)])
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'Encryption is unavailable on this machine. AskToto cannot safely store your API key. ' +
          'Grant keychain access or set the key via the environment variable instead.'
      )
    }
    blob = safeStorage.encryptString(trimmed)
  }
  try {
    writeFileSync(p, blob, { mode: 0o600 })
  } catch (e) {
    throw new Error(
      `Couldn't save your API key — AskToto can't write to its data folder${
        e instanceof Error && e.message ? ` (${e.message})` : ''
      }. Check that the disk isn't full and the folder is writable.`
    )
  }
  _apiKeyCache.delete(provider)
  _settingsCache = null
}

export function clearApiKey(provider: ProviderId): void {
  const p = keyPath(provider)
  if (!existsSync(p)) return
  try {
    rmSync(p)
  } catch (e) {
    mainLog.warn('[store] clearApiKey: could not delete key file for', provider, e)
  }
  _apiKeyCache.delete(provider)
  _settingsCache = null
}

export interface TestKeyResult {
  ok: boolean
  error?: string
}

export async function testApiKey(provider: ProviderId, key: string): Promise<TestKeyResult> {
  const trimmed = key.trim()
  if (!trimmed) return { ok: false, error: 'No API key provided.' }
  if (PROVIDERS[provider]?.kind === 'cli')
    return {
      ok: false,
      error: 'CLI providers do not use API keys — connect via Settings → CLI Integration.'
    }

  const def = PROVIDERS[provider]
  const settings = getSettings()
  try {
    if (def.kind === 'dust') {
      if (!settings.dustWorkspaceId) {
        return { ok: false, error: 'Add your Dust workspace ID in the Dust setup below first.' }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { DustAPI } = (await import('@dust-tt/client')) as any
      const api = new DustAPI(
        { url: settings.dustBaseUrl || def.baseUrl },
        { workspaceId: settings.dustWorkspaceId, apiKey: trimmed },
        console
      )
      const r = await api.getAgentConfigurations({})
      if (r.isErr()) return { ok: false, error: r.error.message }
    } else if (def.kind === 'anthropic') {
      const client = new Anthropic({ apiKey: trimmed })
      await client.messages.create({
        model: def.fastModel || def.defaultModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      })
    } else {
      const baseURL = provider === 'custom' ? settings.customBaseUrl : def.baseUrl
      if (provider === 'custom' && !baseURL) {
        return { ok: false, error: 'Custom provider requires a base URL in Advanced settings.' }
      }
      // Custom has no built-in model — use the user's chosen model id, or the test is meaningless.
      const model = def.fastModel || def.defaultModel || settings.providerModels[provider] || ''
      if (!model) {
        return { ok: false, error: 'Set a model id in Advanced first, then test.' }
      }
      const client = new OpenAI({ apiKey: trimmed, baseURL: baseURL || undefined })
      await client.chat.completions.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      })
    }
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

/** Always true — the AES-GCM file backend is always available as a fallback. */
export function encryptionAvailable(): boolean {
  return true
}

/** List the user's Dust agents (for the dummy-proof agent picker). Uses the saved Dust key. */
export async function listDustAgents(): Promise<DustAgentsResponse> {
  const settings = getSettings()
  const key = getApiKey('dust')
  if (!key) return { ok: false, error: 'Paste and Save your Dust API key first.' }
  if (!settings.dustWorkspaceId) return { ok: false, error: 'Add your Dust workspace ID first.' }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { DustAPI } = (await import('@dust-tt/client')) as any
    const api = new DustAPI(
      { url: settings.dustBaseUrl || PROVIDERS.dust.baseUrl },
      { workspaceId: settings.dustWorkspaceId, apiKey: key },
      console
    )
    const r = await api.getAgentConfigurations({})
    if (r.isErr()) return { ok: false, error: r.error.message }
    const agents = (r.value as { sId?: string; name?: string; description?: string; status?: string }[])
      .filter((a) => a && a.sId && (a.status === undefined || a.status === 'active'))
      .map((a) => ({ sId: a.sId as string, name: a.name || (a.sId as string), description: a.description || '' }))
      .sort((x, y) => x.name.localeCompare(y.name))
    return { ok: true, agents }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function getApiKey(provider: ProviderId): string {
  // Env-var keys bypass the cache — they're already an O(1) lookup and must stay live.
  const env = process.env[ENV_VAR[provider]]
  if (env) return env

  if (_apiKeyCache.has(provider)) return _apiKeyCache.get(provider)!

  // Compute from disk (file read + AES decrypt). All paths below land on a single `key` assignment
  // so we can cache the result regardless of which branch resolved it.
  let key = ''
  try {
    const buf = readFileSync(keyPath(provider))

    // ── Legacy plaintext (oldest format) ──────────────────────────────────────
    if (buf.subarray(0, 6).toString('utf8') === 'plain:') {
      const plain = buf.subarray(6).toString('utf8')
      // Migrate to current backend on first read (defense-in-depth for disk backups).
      // setApiKey will delete _apiKeyCache[provider]; we re-set it below.
      try { setApiKey(provider, plain) } catch { /* keep the plaintext file; key still works */ }
      key = plain
    } else if (buf.length > AES_KEY_MARKER.length && buf.subarray(0, AES_KEY_MARKER.length).equals(AES_KEY_MARKER)) {
      // ── New AES-GCM format (ATKAES1 marker) ────────────────────────────────
      try {
        key = decryptSecret(buf.subarray(AES_KEY_MARKER.length))
      } catch {
        key = '' // Corrupt or key rotated
      }
    } else if (safeStorage.isEncryptionAvailable()) {
      // ── Legacy safeStorage blob (no marker) — migrate to current backend ────
      try {
        const plain = safeStorage.decryptString(buf)
        // Best-effort migration: re-save with the current backend so future reads don't need keychain.
        try { setApiKey(provider, plain) } catch { /* keep the old blob; key still works */ }
        key = plain
      } catch {
        /* not a safeStorage blob for this OS user — unreadable */
      }
    }
  } catch {
    /* file missing or unreadable */
  }

  _apiKeyCache.set(provider, key)
  return key
}

export function hasApiKey(provider: ProviderId): boolean {
  return getApiKey(provider).length > 0
}

export function hasKeysMap(): Record<string, boolean> {
  const m: Record<string, boolean> = {}
  for (const p of PROVIDER_IDS) m[p] = hasApiKey(p)
  return m
}
