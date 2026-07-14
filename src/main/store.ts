import { app, safeStorage } from 'electron'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
  readdirSync,
  mkdtempSync
} from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  DUST_BASE_AGENT_ID,
  BaseSettingsSchema,
  SettingsSchema,
  type Settings,
  type DustAgentsResponse
} from '@shared/ipc'
import { PROVIDERS, PROVIDER_IDS, dustAgentVision, type ProviderId } from '@shared/providers'
import { mainLog } from './logger'
import {
  KeychainKeyRecoveryError,
  decryptSecret,
  encryptSecret,
  prepareFileKeyForWrite,
  resetSecretKeyCache,
  useFileBackend
} from './secrets'
// Static (eager) imports — dynamic import() throws under the bytecode-compiled main (electron-vite
// bytecodePlugin). These SDKs are already eager-loaded by the streaming modules (llm/anthropic|dust|openai),
// so this adds no startup cost; it just makes the key-test + Dust-agent-list paths bytecode-safe.
import { DustAPI } from '@dust-tt/client'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

const dir = () => app.getPath('userData')
const settingsPath = () => join(dir(), 'settings.json')
const keyPath = (provider: ProviderId) => join(dir(), `key-${provider}.bin`)

const PROFILE_RECOVERY_FIXED_FILES = new Set([
  'secret-key.bin',
  'secret-key.bin.migrate.tmp',
  'settings.json',
  'settings.json.tmp',
  'auth-session.bin',
  'auth-configured.flag',
  'msal-cache.bin',
  'google-session.bin'
])

function encryptedProfileFiles(): string[] {
  const d = dir()
  if (!existsSync(d)) return []
  return readdirSync(d, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) return false
      return PROFILE_RECOVERY_FIXED_FILES.has(entry.name) || /^key-.+\.bin(?:\.tmp)?$/.test(entry.name)
    })
    .map((entry) => entry.name)
}

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
  mistral: 'MISTRAL_API_KEY',
  grok: 'XAI_API_KEY',
  dust: 'DUST_API_KEY',
  'claude-cli': '',
  'codex-cli': '',
  gemini: 'GEMINI_API_KEY',
  local: '', // keyless — Métis Local's per-session sidecar key lives only in local-runtime.ts memory
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
    const raw = obj?.allowedProviders
    // An explicit empty array is a real deny-all policy, not "no policy" — only an absent/non-array
    // key means null (no restriction). Collapsing the two let `"allowedProviders": []` fail open.
    if (!Array.isArray(raw)) return null
    return [...new Set(raw.filter((x): x is string => typeof x === 'string'))]
  } catch {
    return null
  }
}

/** Machine-wide org-policy location IT can deploy (admin-only write). */
function adminManagedPath(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/Métis/managed-config.json'
  if (process.platform === 'win32')
    return join(process.env.ProgramData || 'C:\\ProgramData', 'Métis', 'managed-config.json')
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
    } catch (e) {
      mainLog.warn('[store] settings.json undecryptable (AES-GCM); falling back to defaults', e)
      return {} // Corrupt or key rotated — don't brick the app
    }
  }

  // ── Legacy safeStorage format (ATKENC1) — migrate to file backend on next write ──
  if (buf.length >= ENC_MARKER_V1.length && buf.subarray(0, ENC_MARKER_V1.length).equals(ENC_MARKER_V1)) {
    // Only touch safeStorage (the Keychain) when the file backend is NOT in force. On a keystore-forced
    // build, reading a legacy V1 blob would re-open the very Keychain prompt we route around at boot — so
    // treat it as unreadable and fall back to defaults (a one-time re-onboard), never a blocking prompt.
    if (!useFileBackend() && safeStorage.isEncryptionAvailable()) {
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
  } catch (e) {
    throw new Error(
      `Encryption unavailable — refusing to write settings as plaintext (${e instanceof Error ? e.message : String(e)})`
    )
  }
  throw new Error('Encryption unavailable — refusing to write settings as plaintext')
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
  const managed = validatedManaged()
  const base = { ...DEFAULT_SETTINGS, ...managed }
  const raw = readUserRaw()
  // Migration: 'together' and 'fireworks' were removed as LLM providers. A settings.json written before
  // the removal may still name one as the active provider — coerce it back to the default so a stale
  // value never resurfaces a provider the UI no longer offers. (managed-config is already filtered
  // through validKeysOnly() above, via validatedManaged(), so it can't carry a stale provider through.)
  // Any saved key file for that provider is left untouched on disk; it's simply never surfaced again.
  if (raw.provider === 'together' || raw.provider === 'fireworks') raw.provider = DEFAULT_SETTINGS.provider
  // NOTE: no contentProtection→privateView migration here. An earlier build briefly repointed the bar's
  // eye button at the new privateView flag, which would have made a pre-split contentProtection=false
  // ("window visible") silently mean something else — a migration guarded that. The eye now controls
  // contentProtection again (its original meaning), so old values are correct as-is and NO remap is
  // needed. The migration was also actively harmful: its `!('privateView' in raw)` guard re-fired on
  // every legitimate contentProtection=false write (privateView is rarely in the sparse user layer),
  // deleting the change and snapping the window back to hidden — the "visible toggle is broken" bug.
  // Locked keys are authoritative on READ too, not just on write: a value persisted before a lock (or a
  // hand-edited settings.json) must not override the managed/default value. Strip locked keys from the
  // user layer so org policy always wins.
  const lockedKeys = getLockedKeys()
  if (lockedKeys.length) for (const k of lockedKeys) delete (raw as Record<string, unknown>)[k]
  // Task MI-5 (hardened — QA #9): publishBrainPages is EXPLICIT opt-in only (schema default false). It is
  // deliberately NEVER derived from `!encryptTranscripts`. Deriving it meant turning at-rest encryption
  // OFF (an unrelated action) silently flipped publishing ON and materialized a full Dust-readable wiki
  // mirror with no consent dialog. Publishing a readable intelligence mirror to OneDrive is its own
  // decision, made only through the native consent gate in main/index.ts's settings:set handler.
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
  // A user-initiated save is the safe time to recover a legacy Keychain-wrapped
  // file key. This happens before readUserRaw() so an existing encrypted
  // profile is merged rather than silently replaced with onboarding defaults.
  try {
    prepareFileKeyForWrite()
  } catch (e) {
    if (e instanceof KeychainKeyRecoveryError) throw e
    throw new Error(
      `Couldn't save settings — Métis can't write to its data folder${
        e instanceof Error && e.message ? ` (${e.message})` : ''
      }. Check that the disk isn't full and the folder is writable.`
    )
  }
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
  // Invariant enforced at the persistence boundary (not just in the Settings UI): the Dust base agent
  // must never persist blank — isDustReady() and every task that cascades into Dust require it. Covers
  // per-keystroke UI commits, IPC callers, and hand-rolled patches alike.
  const pm = allowed.providerModels as Record<string, unknown> | undefined
  if (pm && typeof pm === 'object' && 'dust' in pm && !String(pm.dust ?? '').trim()) {
    pm.dust = DUST_BASE_AGENT_ID
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
      `Couldn't save settings — Métis can't write to its data folder${
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

export interface EncryptedProfileArchive {
  backupDir: string
  files: string[]
}

/**
 * Archive the current encrypted profile before starting a fresh local profile.
 *
 * This is intentionally explicit and reversible: the old key, settings, provider keys, and auth
 * caches are moved (never deleted or overwritten) into a hidden directory under userData. Meeting
 * files remain where they are so they can be read again if the original Keychain access is restored
 * and the archived files are put back in the root.
 */
export function archiveEncryptedProfile(): EncryptedProfileArchive {
  ensureDir()
  const d = dir()
  const files = encryptedProfileFiles()
  if (!files.length) {
    throw new Error('No encrypted profile files were found to archive.')
  }

  const backupDir = mkdtempSync(join(d, '.metis-recovery-'))
  const moved: string[] = []
  try {
    for (const name of files) {
      renameSync(join(d, name), join(backupDir, name))
      moved.push(name)
    }
  } catch (error) {
    let rollbackFailed = false
    for (const name of [...moved].reverse()) {
      try {
        renameSync(join(backupDir, name), join(d, name))
      } catch {
        rollbackFailed = true
      }
    }
    if (!rollbackFailed) {
      try {
        rmSync(backupDir, { recursive: false, force: true })
      } catch {
        /* best-effort cleanup; no profile file was intentionally discarded */
      }
    }
    if (rollbackFailed) {
      throw new Error(
        `Could not finish the profile archive. The partial recovery copy was left at ${backupDir}; no files were deleted.`
      )
    }
    throw error
  }

  resetSecretKeyCache()
  _settingsCache = null
  _apiKeyCache.clear()
  return { backupDir, files: moved }
}

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
    prepareFileKeyForWrite()
    blob = Buffer.concat([AES_KEY_MARKER, encryptSecret(trimmed)])
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'Encryption is unavailable on this machine. Métis cannot safely store your API key. ' +
          'Grant keychain access or set the key via the environment variable instead.'
      )
    }
    blob = safeStorage.encryptString(trimmed)
  }
  // Atomic write: a crash mid-write must not leave a truncated/corrupt key file (which would silently
  // read back as "no key"). Mirrors the tmp-file + rename pattern already used in setSettings.
  const tmp = `${p}.tmp`
  try {
    writeFileSync(tmp, blob, { mode: 0o600 })
    renameSync(tmp, p)
  } catch (e) {
    try {
      if (existsSync(tmp)) rmSync(tmp) // don't leave an orphaned .tmp behind
    } catch {
      /* ignore */
    }
    throw new Error(
      `Couldn't save your API key — Métis can't write to its data folder${
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
  // Org allowlist (data-residency / governance policy) — the SAME gate attempt() enforces at ask time
  // (index.ts). Without this, a genuinely valid key for a blocked provider passed the live network call
  // below and showed "Key is valid and working." in Settings, only to be refused at chat time.
  const allowed = getAllowedProviders()
  if (allowed && !allowed.includes(provider)) {
    return { ok: false, error: `${def.label} is not on your organization's approved provider list.` }
  }
  const settings = getSettings()
  try {
    if (def.kind === 'dust') {
      if (!settings.dustWorkspaceId) {
        return { ok: false, error: 'Add your Dust workspace ID in the Dust setup below first.' }
      }
      const api = new DustAPI(
        { url: settings.dustBaseUrl || def.baseUrl },
        { workspaceId: settings.dustWorkspaceId, apiKey: trimmed },
        console
      )
      // No `view` needed here — this call only checks r.isErr() to validate the credentials, it never
      // reads r.value, so an empty/restricted agent list (the bug fixed in listDustAgents below) is harmless.
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
    const api = new DustAPI(
      { url: settings.dustBaseUrl || PROVIDERS.dust.baseUrl },
      { workspaceId: settings.dustWorkspaceId, apiKey: key },
      console
    )
    // `view: 'list'` is REQUIRED — without it @dust-tt/client 1.2.6 only appends `view` to the querystring
    // when it's a string, and the Dust endpoint then returns a restricted/empty set for no `view` param,
    // leaving the picker with no agents to show (falls back to a bare text box). 'list' is the "all agents
    // this user can pick" view (see node_modules/@dust-tt/client/dist/types.d.ts AgentConfigurationViewSchema).
    const r = await api.getAgentConfigurations({ view: 'list' })
    if (r.isErr()) return { ok: false, error: r.error.message }
    const agents = (r.value as {
      sId?: string
      name?: string
      description?: string
      status?: string
      model?: { providerId?: string; modelId?: string }
    }[])
      .filter((a) => a && a.sId && (a.status === undefined || a.status === 'active'))
      .map((a) => ({
        sId: a.sId as string,
        name: a.name || (a.sId as string),
        description: a.description || '',
        modelProviderId: a.model?.providerId,
        modelId: a.model?.modelId
      }))
      .sort((x, y) => x.name.localeCompare(y.name))
    // Cache each agent's vision capability by sId so the ask path can route a Dust screen question
    // natively (upload the screenshot) only when the SELECTED agent's model can actually read it — no
    // extra Dust round-trip at ask time (see dustSelectedAgentVision).
    for (const a of agents) _dustAgentVision.set(a.sId, dustAgentVision(a))
    return { ok: true, agents }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Vision capability per Dust agent sId, populated on every agent list (listDustAgents above).
const _dustAgentVision = new Map<string, boolean>()

/**
 * Vision capability of the currently-selected Dust base agent, from the last agent list. Unknown (cache
 * cold, or the agent was never listed this session) → true: try Dust natively rather than dead-end a
 * screen question. The native path fails over on any real upload/stream error, so an optimistic default
 * degrades gracefully in both directions.
 */
export function dustSelectedAgentVision(sId: string | undefined): boolean {
  if (!sId) return true
  return _dustAgentVision.get(sId) ?? true
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
      } catch (e) {
        mainLog.warn('[store] key file undecryptable for', provider, e)
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
