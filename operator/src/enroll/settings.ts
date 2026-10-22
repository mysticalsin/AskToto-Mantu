/**
 * Enrolment settings (O03/O04): three small values kept on `operator_settings` through the store, so they
 * work against memoryStore and D1 alike and need no deploy to change.
 *   enroll.paused                     boolean  stops ALL minting (sso, token, renew) at once; existing seats keep working
 *   enroll.sso_tier                   string    tier an SSO-enrolled seat gets (default `reporting`)
 *   enroll.sso_max_devices_per_user   integer   active SSO-enrolled devices per directory user (default 10)
 */
import { DEFAULT_TIER_ENTITLEMENTS, type OperatorStore } from '../store'

export const ENROLL_SETTING_KEYS = {
  paused: 'enroll.paused',
  ssoTier: 'enroll.sso_tier',
  ssoMaxDevicesPerUser: 'enroll.sso_max_devices_per_user'
} as const

export interface EnrollSettings {
  paused: boolean
  ssoTier: string
  ssoMaxDevicesPerUser: number
}

export const DEFAULT_ENROLL_SETTINGS: EnrollSettings = { paused: false, ssoTier: 'reporting', ssoMaxDevicesPerUser: 10 }

const TIER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

function parse(raw: string | null): unknown {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export async function readEnrollSettings(store: Pick<OperatorStore, 'getSetting'>): Promise<EnrollSettings> {
  const [paused, tier, max] = await Promise.all([
    store.getSetting(ENROLL_SETTING_KEYS.paused),
    store.getSetting(ENROLL_SETTING_KEYS.ssoTier),
    store.getSetting(ENROLL_SETTING_KEYS.ssoMaxDevicesPerUser)
  ])
  const p = parse(paused)
  const t = parse(tier)
  const m = parse(max)
  return {
    paused: p === true,
    ssoTier: typeof t === 'string' && TIER_ID_RE.test(t) ? t : DEFAULT_ENROLL_SETTINGS.ssoTier,
    ssoMaxDevicesPerUser:
      typeof m === 'number' && Number.isInteger(m) && m >= 1 && m <= 100
        ? m
        : DEFAULT_ENROLL_SETTINGS.ssoMaxDevicesPerUser
  }
}

export async function knownTierIds(store: Pick<OperatorStore, 'listTiers'>): Promise<string[]> {
  const rows = await store.listTiers()
  return Array.from(new Set([...Object.keys(DEFAULT_TIER_ENTITLEMENTS), ...rows.map((r) => r.id)]))
}

export type EnrollSettingsPatch = Partial<EnrollSettings>

export function validateEnrollSettingsPatch(
  body: Record<string, unknown>,
  tierIds: readonly string[]
): { ok: true; patch: EnrollSettingsPatch } | { ok: false; error: string; field: string } {
  const patch: EnrollSettingsPatch = {}
  if ('paused' in body) {
    if (typeof body.paused !== 'boolean') return { ok: false, error: 'paused must be true or false', field: 'paused' }
    patch.paused = body.paused
  }
  if ('ssoTier' in body) {
    if (typeof body.ssoTier !== 'string' || !tierIds.includes(body.ssoTier)) {
      return { ok: false, error: 'ssoTier must be an existing tier', field: 'ssoTier' }
    }
    patch.ssoTier = body.ssoTier
  }
  if ('ssoMaxDevicesPerUser' in body) {
    const v = body.ssoMaxDevicesPerUser
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100) {
      return { ok: false, error: 'ssoMaxDevicesPerUser must be 1-100', field: 'ssoMaxDevicesPerUser' }
    }
    patch.ssoMaxDevicesPerUser = v
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'no recognised enrolment setting in body', field: '' }
  return { ok: true, patch }
}

export async function writeEnrollSettings(
  store: Pick<OperatorStore, 'putSetting'>,
  patch: EnrollSettingsPatch,
  actor: string,
  now: number
): Promise<void> {
  if (patch.paused !== undefined)
    await store.putSetting(ENROLL_SETTING_KEYS.paused, JSON.stringify(patch.paused), actor, now)
  if (patch.ssoTier !== undefined)
    await store.putSetting(ENROLL_SETTING_KEYS.ssoTier, JSON.stringify(patch.ssoTier), actor, now)
  if (patch.ssoMaxDevicesPerUser !== undefined) {
    await store.putSetting(
      ENROLL_SETTING_KEYS.ssoMaxDevicesPerUser,
      JSON.stringify(patch.ssoMaxDevicesPerUser),
      actor,
      now
    )
  }
}
