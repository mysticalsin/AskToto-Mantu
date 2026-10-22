/**
 * The credential inventory (Métis 2.12 G20, CAP-35 / R092).
 *
 * One typed list of every credential the desktop app can hold. Each entry names where it lives, who may read it,
 * whether the renderer ever sees it, and what sign-out, an account switch and "Reset Métis" (the explicit profile
 * recovery, which archives the encrypted profile) must do with it. The cleanup code (main/credential-cleanup.ts),
 * the renderer-facing settings redaction, the profile-recovery file classifier and the contract tests all read
 * this list, so a credential cannot be added in one place and forgotten in another: a settings key that looks
 * like a credential and is in neither the inventory nor the reviewed non-secret list fails CI.
 *
 * Policy, labelled ASSUMED until the owner reviews it (every cell is data, not code, so flipping one is a
 * one-line change that the matrix tests then re-verify):
 *  - Sign-out ends one identity. It clears what is bound to that identity (Microsoft cache and session) and any
 *    copy that left Métis's own encrypted store (the Dust CLI keychain seed). Credentials a person pasted for
 *    themselves (provider keys, MCP keys) and the organisation's seat stay, because session expiry also signs
 *    the user out and must not make them re-enter every key.
 *  - An account switch (a different owner signs in than the one remembered) clears every credential the previous
 *    owner supplied, so the next person never inherits a key, seat or token. Their meetings and brain stay.
 *  - Reset archives (moves, never deletes) the encrypted profile files, which carries every file or settings
 *    credential with it, and clears the copies that live outside it.
 *  - Content keys and the owner-key salt are never cleared: they belong to the user's own saved data.
 *
 * Pure and Electron free: shared by main and the renderer's tests.
 */
import { PROVIDER_IDS } from './providers'

export type CredentialId =
  | 'provider-api-key'
  | 'soniox-api-key'
  | 'msal-cache'
  | 'auth-session'
  | 'speech-auth-lease'
  | 'operator-licence'
  | 'operator-reporting-token'
  | 'operator-ingest-secret'
  | 'operator-enrol-token'
  | 'dust-oauth-refresh'
  | 'dust-cli-seed'
  | 'mcp-api-key'
  | 'mcp-oauth-refresh'
  | 'mcp-oauth-client-secret'
  | 'member-licence-key'
  | 'member-licence-cache'
  | 'legacy-google-session'
  | 'content-key'
  | 'file-key'
  | 'owner-key-salt'
  | 'cli-provider-session'

/** What a lifecycle event does to a credential. `archive` moves the encrypted profile aside and never deletes. */
export type CredentialAction = 'keep' | 'clear' | 'archive'
export type CredentialTrigger = 'signOut' | 'accountSwitch' | 'reset'

export type CredentialHolder =
  /** A file in the profile folder, AES-256-GCM under the per-install file key or wrapped by the OS keystore. */
  | { kind: 'keystore-file'; files: readonly CredentialFile[] }
  /** Fields of settings.json, which is encrypted at rest as a whole (ATKENC2). */
  | { kind: 'encrypted-settings'; keys: readonly string[] }
  /** An item in the shared OS keychain that another program also reads. Métis only ever removes what it seeded. */
  | { kind: 'os-keychain'; service: string; accounts: readonly string[] }
  /** A key wrapped (never stored in the clear) inside the user's own saved files. */
  | { kind: 'wrapped-in-data'; carrier: string }
  /** Process memory only; gone on quit, dropped on every session end. */
  | { kind: 'memory'; description: string }
  /** Held by a tool Métis launches (a CLI). Métis never reads or stores it. */
  | { kind: 'external'; owner: string }
  /** Shipped inside the installer, obfuscated rather than secret. */
  | { kind: 'packaged-resource'; description: string }

export interface CredentialFile {
  /** Display form, with `<provider>`-style placeholders. */
  readonly name: string
  /** Matches a profile-folder file name (a base name, never a path). */
  readonly match: RegExp
}

export type CredentialReader =
  /** The Electron main process. The only process that ever decrypts a stored credential. */
  | 'main'
  /** A spawned CLI that receives the value through its environment for one call. */
  | 'cli-child'
  /** Sent as a bearer credential to the service it belongs to (never to another host). */
  | 'remote-service'

export interface CredentialEntry {
  readonly id: CredentialId
  readonly label: string
  readonly holder: CredentialHolder
  readonly readers: readonly CredentialReader[]
  /** `presence-only` means the renderer may learn a yes or no, never a value or a fragment. */
  readonly renderer: 'never' | 'presence-only'
  readonly cleanup: Readonly<Record<CredentialTrigger, CredentialAction>>
  /** Settings keys whose value IS the secret. These are blanked in every renderer-facing settings object. */
  readonly secretSettingsKeys: readonly string[]
  /** Non-secret settings kept beside the secret (identifiers, expiry, state) that cleanup resets with it. */
  readonly companionSettingsKeys: readonly string[]
  readonly note: string
}

const matchProviderKey = new RegExp(`^key-(${PROVIDER_IDS.join('|')})\\.bin$`)

const KEEP = 'keep' as const
const CLEAR = 'clear' as const
const ARCHIVE = 'archive' as const

export const CREDENTIAL_INVENTORY: readonly CredentialEntry[] = [
  {
    id: 'provider-api-key',
    label: 'Provider API keys (including the Cloudflare Worker key and the Dust access token)',
    holder: {
      kind: 'keystore-file',
      files: [{ name: 'key-<provider>.bin', match: matchProviderKey }]
    },
    readers: ['main', 'remote-service'],
    renderer: 'presence-only',
    cleanup: { signOut: KEEP, accountSwitch: CLEAR, reset: ARCHIVE },
    secretSettingsKeys: [],
    companionSettingsKeys: ['dustTokenMintedAt', 'dustSessionOrigin'],
    note: 'Pasted by the user for their own accounts. An environment variable can also supply a key; Métis never stores or clears that.'
  },
  {
    id: 'soniox-api-key',
    label: 'Soniox speech key',
    holder: { kind: 'keystore-file', files: [{ name: 'key-soniox.bin', match: /^key-soniox\.bin$/ }] },
    readers: ['main', 'remote-service'],
    renderer: 'presence-only',
    cleanup: { signOut: KEEP, accountSwitch: CLEAR, reset: ARCHIVE },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: 'STT only; not a provider id. The Cloudflare speech token is the Cloudflare provider key above.'
  },
  {
    id: 'msal-cache',
    label: 'Microsoft sign-in token cache (Graph access and refresh tokens)',
    holder: { kind: 'keystore-file', files: [{ name: 'msal-cache.bin', match: /^msal-cache\.bin$/ }] },
    readers: ['main', 'remote-service'],
    renderer: 'never',
    cleanup: { signOut: CLEAR, accountSwitch: KEEP, reset: ARCHIVE },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: "Dropped with the session so sign-out also revokes calendar access. Never cleared on an account switch: by then it holds the new owner's tokens, and the previous owner's were removed at their sign-out."
  },
  {
    id: 'auth-session',
    label: 'Métis sign-in session',
    holder: { kind: 'keystore-file', files: [{ name: 'auth-session.bin', match: /^auth-session\.bin$/ }] },
    readers: ['main'],
    renderer: 'never',
    cleanup: { signOut: CLEAR, accountSwitch: KEEP, reset: ARCHIVE },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: "The renderer sees signedIn and a display name through auth:status, never the session record. Never cleared on an account switch, because it is then the new owner's live session."
  },
  {
    id: 'speech-auth-lease',
    label: 'Speech authorisation lease',
    holder: { kind: 'memory', description: 'Short-lived lease derived from the session; never written to disk.' },
    readers: ['main'],
    renderer: 'never',
    cleanup: { signOut: CLEAR, accountSwitch: KEEP, reset: CLEAR },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: 'Invalidated by every session end. Not cleared on an account switch, when it already belongs to the new session.'
  },
  {
    id: 'operator-licence',
    label: 'Operator seat licence (administrator or MDM, or an auto licence an administrator upgraded)',
    holder: { kind: 'encrypted-settings', keys: ['operatorLicenseToken'] },
    readers: ['main', 'remote-service'],
    renderer: 'presence-only',
    cleanup: { signOut: KEEP, accountSwitch: CLEAR, reset: ARCHIVE },
    secretSettingsKeys: ['operatorLicenseToken'],
    companionSettingsKeys: [
      'operatorLicenseJti',
      'operatorLicenseLast4',
      'operatorLicenseExpiresAt',
      'operatorTier',
      'operatorEntitlements',
      'operatorIntegrationsVersion',
      'operatorEntitlementsAt'
    ],
    note: 'The seat belongs to the organisation, so sign-out keeps it. The renderer gets only operatorConfigured and the last four characters.'
  },
  {
    id: 'operator-reporting-token',
    label: 'Operator auto-enrolment reporting token',
    holder: { kind: 'encrypted-settings', keys: ['operatorReportingToken'] },
    readers: ['main', 'remote-service'],
    renderer: 'presence-only',
    cleanup: { signOut: KEEP, accountSwitch: CLEAR, reset: ARCHIVE },
    secretSettingsKeys: ['operatorReportingToken'],
    companionSettingsKeys: [
      'operatorReportingJti',
      'operatorReportingLast4',
      'operatorReportingExpiresAt',
      'operatorLicenseOrigin',
      'operatorEnrollState',
      'operatorEnrollCheckedAt'
    ],
    note: 'Reporting-only, so it gates nothing. Kept on sign-out so session expiry does not re-enrol; an account switch drops it and the next sign-in enrols afresh. Never touches an administrator licence.'
  },
  {
    id: 'operator-ingest-secret',
    label: 'Operator legacy ingest secret',
    holder: { kind: 'encrypted-settings', keys: ['operatorIngestSecret'] },
    readers: ['main', 'remote-service'],
    renderer: 'presence-only',
    cleanup: { signOut: KEEP, accountSwitch: CLEAR, reset: ARCHIVE },
    secretSettingsKeys: ['operatorIngestSecret'],
    companionSettingsKeys: [],
    note: 'Superseded by the licence; the renderer sees operatorLegacyCredentialConfigured only. METIS_OPERATOR_INGEST_SECRET in the environment is not ours to clear.'
  },
  {
    id: 'operator-enrol-token',
    label: 'Operator enrolment token embedded in the installer',
    holder: {
      kind: 'packaged-resource',
      description:
        'operator-embed/enroll.json: AES-GCM blob, enrolment scope, reporting tier only, revocable on the Worker.'
    },
    readers: ['main', 'remote-service'],
    renderer: 'never',
    cleanup: { signOut: KEEP, accountSwitch: KEEP, reset: KEEP },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: 'Ships with every install, so there is nothing per-user to remove. Decrypted once into main memory and used only against its own Operator URL.'
  },
  {
    id: 'dust-oauth-refresh',
    label: 'Dust OAuth refresh token',
    holder: { kind: 'keystore-file', files: [{ name: 'dust-refresh.bin', match: /^dust-refresh\.bin$/ }] },
    readers: ['main', 'remote-service'],
    renderer: 'never',
    cleanup: { signOut: KEEP, accountSwitch: CLEAR, reset: ARCHIVE },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: 'Single-use and rotating; the access token is the dust provider key.'
  },
  {
    id: 'dust-cli-seed',
    label: 'Dust CLI keychain seed (access token, workspace, region)',
    holder: { kind: 'os-keychain', service: 'dust-cli', accounts: ['access_token', 'workspace_sid', 'region'] },
    readers: ['cli-child'],
    renderer: 'never',
    cleanup: { signOut: CLEAR, accountSwitch: CLEAR, reset: CLEAR },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: "A copy outside Métis. Removed only while it still equals the token Métis seeded; a session imported from the user's own Dust CLI is never touched. Re-seeded on the next Spotlight chat."
  },
  {
    id: 'mcp-api-key',
    label: 'MCP connection API keys (BidStack, ClickUp access token, Plane)',
    holder: {
      kind: 'keystore-file',
      files: [
        {
          name: 'key-mcp-<connection>.bin (and the pre-generalisation key-bidstack.bin)',
          match: /^(?:key-mcp-(?![a-z0-9-]*-(?:refresh|client)\.bin$)[a-z0-9-]+\.bin|key-bidstack\.bin)$/i
        }
      ]
    },
    readers: ['main', 'remote-service'],
    renderer: 'presence-only',
    cleanup: { signOut: KEEP, accountSwitch: CLEAR, reset: ARCHIVE },
    secretSettingsKeys: [],
    companionSettingsKeys: ['mcpConnections'],
    note: 'Clearing also marks the connection disconnected so the UI never claims a connection whose key is gone.'
  },
  {
    id: 'mcp-oauth-refresh',
    label: 'MCP OAuth refresh tokens',
    holder: {
      kind: 'keystore-file',
      files: [{ name: 'key-mcp-<connection>-refresh.bin', match: /^key-mcp-[a-z0-9-]+-refresh\.bin$/i }]
    },
    readers: ['main', 'remote-service'],
    renderer: 'never',
    cleanup: { signOut: KEEP, accountSwitch: CLEAR, reset: ARCHIVE },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: 'ClickUp today.'
  },
  {
    id: 'mcp-oauth-client-secret',
    label: 'MCP OAuth client secrets (Plane dynamic client registration)',
    holder: {
      kind: 'keystore-file',
      files: [{ name: 'key-mcp-<connection>-client.bin', match: /^key-mcp-[a-z0-9-]+-client\.bin$/i }]
    },
    readers: ['main', 'remote-service'],
    renderer: 'never',
    cleanup: { signOut: KEEP, accountSwitch: CLEAR, reset: ARCHIVE },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: 'Plane is a confidential client; ClickUp is public and never writes one.'
  },
  {
    id: 'member-licence-key',
    label: 'Member licence key and its signed offline lease',
    holder: { kind: 'encrypted-settings', keys: ['licenseKey', 'licenseLease'] },
    readers: ['main', 'remote-service'],
    renderer: 'never',
    cleanup: { signOut: KEEP, accountSwitch: CLEAR, reset: ARCHIVE },
    secretSettingsKeys: ['licenseKey', 'licenseLease'],
    companionSettingsKeys: [
      'licenseCompanyName',
      'licenseSeatCap',
      'licenseExpiresAt',
      'licenseValid',
      'licenseLastValidatedAt'
    ],
    note: 'The lease payload carries the licence key in base64, so it is as sensitive as the key. The trial start stamp is not a credential and is never cleared, or a switch would restart the trial.'
  },
  {
    id: 'member-licence-cache',
    label: 'Member licence cache (signed licence)',
    holder: { kind: 'keystore-file', files: [{ name: 'license-cache.bin', match: /^license-cache\.bin$/ }] },
    readers: ['main'],
    renderer: 'never',
    cleanup: { signOut: KEEP, accountSwitch: CLEAR, reset: ARCHIVE },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: 'Re-read from the MDM or licence file when one exists.'
  },
  {
    id: 'legacy-google-session',
    label: 'Legacy Google session (no current build writes it)',
    holder: { kind: 'keystore-file', files: [{ name: 'google-session.bin', match: /^google-session\.bin$/ }] },
    readers: ['main'],
    renderer: 'never',
    cleanup: { signOut: CLEAR, accountSwitch: CLEAR, reset: ARCHIVE },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: 'Left behind by an older build; removed at the first sign-out.'
  },
  {
    id: 'content-key',
    label: 'Per-file transcript and journal content keys',
    holder: { kind: 'wrapped-in-data', carrier: 'saved transcript envelopes and meeting-journal/<id>/key.v1' },
    readers: ['main'],
    renderer: 'never',
    cleanup: { signOut: KEEP, accountSwitch: KEEP, reset: KEEP },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: "Wrapped, never stored in the clear, and part of the user's own saved meetings, which cleanup never changes. They stay readable by archiving (not deleting) the file key on reset."
  },
  {
    id: 'file-key',
    label: 'Per-install file key (wraps every file credential and content key)',
    holder: { kind: 'keystore-file', files: [{ name: 'secret-key.bin', match: /^secret-key\.bin(\.migrate\.tmp)?$/ }] },
    readers: ['main'],
    renderer: 'never',
    cleanup: { signOut: KEEP, accountSwitch: KEEP, reset: ARCHIVE },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: 'Never cleared: deleting it would make every saved encrypted meeting unreadable. Reset moves it into the recovery folder so the old profile can be restored.'
  },
  {
    id: 'owner-key-salt',
    label: 'Owner-key salt (derives the non-reversible owner key for session and journal binding)',
    holder: { kind: 'keystore-file', files: [{ name: 'identity/owner-key-salt.v1', match: /^owner-key-salt\.v1$/ }] },
    readers: ['main'],
    renderer: 'never',
    cleanup: { signOut: KEEP, accountSwitch: KEEP, reset: KEEP },
    secretSettingsKeys: [],
    companionSettingsKeys: [],
    note: "Kept: the owner key stamped on the user's own journals is derived from it, so dropping it would orphan them."
  },
  {
    id: 'cli-provider-session',
    label: 'Claude, Codex and Dust CLI sessions',
    holder: { kind: 'external', owner: 'the CLI that created the session (its own keychain or config)' },
    readers: [],
    renderer: 'never',
    cleanup: { signOut: KEEP, accountSwitch: KEEP, reset: KEEP },
    secretSettingsKeys: [],
    companionSettingsKeys: ['cliConnected'],
    note: "Métis holds no copy: it only checks that the CLI is logged in. Signing the user out of their own CLI is not Métis's to do."
  }
]

const BY_ID: ReadonlyMap<CredentialId, CredentialEntry> = new Map(CREDENTIAL_INVENTORY.map((e) => [e.id, e]))

export function credentialEntry(id: CredentialId): CredentialEntry {
  const entry = BY_ID.get(id)
  if (!entry) throw new Error(`Unknown credential id: ${id}`)
  return entry
}

/** Entries a lifecycle event acts on with the given action, in inventory order. */
export function credentialsFor(trigger: CredentialTrigger, action: CredentialAction): readonly CredentialEntry[] {
  return CREDENTIAL_INVENTORY.filter((entry) => entry.cleanup[trigger] === action)
}

/** Every settings key whose value is a secret. Blanked in any settings object that reaches the renderer. */
export const SECRET_SETTINGS_KEYS: readonly string[] = CREDENTIAL_INVENTORY.flatMap((e) => e.secretSettingsKeys)

/** Every settings key the inventory accounts for, secret or companion. */
export const INVENTORIED_SETTINGS_KEYS: ReadonlySet<string> = new Set(
  CREDENTIAL_INVENTORY.flatMap((e) => [...e.secretSettingsKeys, ...e.companionSettingsKeys])
)

/**
 * Settings keys whose name looks credential-shaped but whose value is reviewed and not a secret. Anything that
 * matches CREDENTIAL_SHAPED_KEY and is in neither this map nor the inventory fails CI, so a new key has to be
 * classified on purpose.
 */
export const REVIEWED_NON_SECRET_SETTINGS_KEYS: Readonly<Record<string, string>> = {
  azureClientId: 'Entra application (client) id: a public identifier, never a secret.',
  clickupClientId: 'Public OAuth client id of a public (PKCE) client.',
  planeClientId: 'Public OAuth client id; the client secret lives in key-mcp-plane-client.bin.',
  licenseServerUrl: 'Public licence server address.',
  licenseGateEnabled: 'Feature switch.'
}

/** A settings key that reads like it could hold a credential. Deliberately broad: a false positive costs one line. */
export const CREDENTIAL_SHAPED_KEY =
  /secret|token|licen[sc]e|lease|password|passphrase|credential|api.?key|bearer|jws|cookie|session|seed|client.?id/i

export function isCredentialShapedSettingsKey(key: string): boolean {
  return CREDENTIAL_SHAPED_KEY.test(key)
}

/** True when a settings key is accounted for: in the inventory, or reviewed as non-secret. */
export function isClassifiedSettingsKey(key: string): boolean {
  return INVENTORIED_SETTINGS_KEYS.has(key) || Object.hasOwn(REVIEWED_NON_SECRET_SETTINGS_KEYS, key)
}

/**
 * The settings object the renderer may receive: every secret value is replaced by the empty string, whatever the
 * setting's current value. Driven by the inventory, so a secret added to an entry is blanked with no other edit.
 * Presence is reported separately (operatorConfigured, hasKeys and friends); the value is never needed.
 */
export function redactCredentialSettings<T extends object>(settings: T): T {
  const out = { ...settings } as Record<string, unknown>
  for (const key of SECRET_SETTINGS_KEYS) if (key in out) out[key] = ''
  return out as T
}

/** The refusal a denied credential read yields. The code is a closed token and the copy is fixed text. */
export const CREDENTIAL_READ_REFUSAL_CODES = [
  'keychain-locked',
  'encryption-unavailable',
  'profile-key-missing',
  'unreadable'
] as const
export type CredentialReadRefusalCode = (typeof CREDENTIAL_READ_REFUSAL_CODES)[number]

export interface CredentialReadRefusal {
  readonly ok: false
  readonly code: CredentialReadRefusalCode
  readonly credential: CredentialId
  /** Fixed recovery copy. Never contains the credential, a path, or the underlying error text. */
  readonly message: string
}

export const CREDENTIAL_REFUSAL_COPY: Readonly<Record<CredentialReadRefusalCode, string>> = {
  'keychain-locked':
    'Métis could not unlock a saved credential because the system keychain is locked or denied access. Unlock it and try again, or sign in again.',
  'encryption-unavailable':
    'Métis could not read a saved credential because this device has no available encryption. Sign in again or set the key through the environment.',
  'profile-key-missing':
    "Métis could not read a saved credential because this profile's key is missing. Sign in again, or restore the profile from Settings.",
  unreadable: 'Métis could not read a saved credential. Sign in again, or enter it again.'
}
