import { HUMANIZER_SKILL_ID, isBuiltinConversationMode, type ModeSkillId } from '@shared/mode-skills'
import { operatorUrlConfigured } from '@shared/operator'
import { applyOverlaySkillFile } from './mode-skills'
import { hashOperatorId, operatorHmacHeaders } from './operator-hmac-sign'
import { getMachineId } from './license'
import { verifyOperatorSkillPack } from './operator-skill-verify'
import { mainLog } from './logger'

const POLL_MS = 6 * 60 * 60 * 1000

export interface OverlayRuntimeSettings {
  operatorUrl?: string
  operatorIngestSecret?: string
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let fetchImpl: typeof fetch = fetch

export function setOperatorOverlayFetchForTests(fn: typeof fetch | null): void {
  fetchImpl = fn ?? fetch
}

export function stopOperatorOverlayPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function resolveUrl(settings: OverlayRuntimeSettings, env = process.env): string {
  return (settings.operatorUrl || env.METIS_OPERATOR_URL || '').trim().replace(/\/$/, '')
}

function resolveSecret(settings: OverlayRuntimeSettings, env = process.env): string {
  return (settings.operatorIngestSecret || env.METIS_OPERATOR_INGEST_SECRET || '').trim()
}

function isOverlaySkillId(id: string): id is ModeSkillId {
  return id === HUMANIZER_SKILL_ID || isBuiltinConversationMode(id)
}

export async function pullOperatorSkillManifest(settings: OverlayRuntimeSettings): Promise<number> {
  const url = resolveUrl(settings)
  const secret = resolveSecret(settings)
  if (!operatorUrlConfigured(settings) || !secret) return 0
  const headers = operatorHmacHeaders(secret, hashOperatorId(getMachineId()), '')
  const res = await fetchImpl(`${url}/v1/skills/manifest`, { method: 'GET', headers })
  if (!res.ok) {
    mainLog.warn(`[operator] manifest ${res.status}`)
    return 0
  }
  const data = (await res.json()) as { ok?: boolean; skills?: { signed?: string }[] }
  if (!data.ok || !Array.isArray(data.skills)) return 0
  let applied = 0
  for (const row of data.skills) {
    if (typeof row.signed !== 'string') continue
    if (applySignedSkillPack(row.signed)) applied++
  }
  return applied
}

/** Apply one signed pack. Returns false on bad signature, hash mismatch, or unknown skill. */
export function applySignedSkillPack(token: string): boolean {
  const pack = verifyOperatorSkillPack(token)
  if (!pack) return false
  if (!isOverlaySkillId(pack.skillId)) return false
  try {
    applyOverlaySkillFile(pack.skillId, pack.body)
    return true
  } catch (e) {
    mainLog.warn('[operator] overlay apply refused:', e)
    return false
  }
}

export function startOperatorOverlayPoll(getSettings: () => OverlayRuntimeSettings): void {
  stopOperatorOverlayPoll()
  const settings = getSettings()
  if (!operatorUrlConfigured(settings) || !resolveSecret(settings)) return
  void pullOperatorSkillManifest(settings).catch((e) => mainLog.warn('[operator] manifest poll failed:', e))
  pollTimer = setInterval(() => {
    void pullOperatorSkillManifest(getSettings()).catch((e) => mainLog.warn('[operator] manifest poll failed:', e))
  }, POLL_MS)
  if (typeof pollTimer === 'object' && pollTimer && 'unref' in pollTimer) {
    pollTimer.unref()
  }
}
