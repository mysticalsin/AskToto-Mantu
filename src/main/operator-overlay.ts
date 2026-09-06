import { inspectBundleResponse } from '@shared/bundle-response'
import { HUMANIZER_SKILL_ID, isBuiltinConversationMode, type ModeSkillId } from '@shared/mode-skills'
import { operatorUrlConfigured, resolveOperatorUrl } from '@shared/operator'
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
  return resolveOperatorUrl(settings, env)
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
  const text = await res.text()
  const inspected = inspectBundleResponse({
    status: res.status,
    contentType: res.headers.get('content-type'),
    location: res.headers.get('location'),
    bodyPrefix: text.slice(0, 1024),
    expected: 'json'
  })
  if (!inspected.ok) {
    mainLog.warn(`[operator] manifest ${inspected.message}`)
    return 0
  }
  if (!res.ok) {
    mainLog.warn(`[operator] manifest ${res.status}`)
    return 0
  }
  let data: { ok?: boolean; skills?: { signed?: string }[] }
  try {
    data = JSON.parse(text) as { ok?: boolean; skills?: { signed?: string }[] }
  } catch {
    mainLog.warn('[operator] manifest was not JSON')
    return 0
  }
  if (!data.ok || !Array.isArray(data.skills)) return 0
  let applied = 0
  for (const row of data.skills) {
    if (typeof row.signed !== 'string') continue
    if (applySignedSkillPack(row.signed)) applied++
  }
  return applied
}

/** Apply one signed pack. Returns false on bad signature, hash mismatch, or unknown skill. */
export function applySignedSkillPack(token: string, publicKeyRaw?: string): boolean {
  const pack = verifyOperatorSkillPack(token, publicKeyRaw)
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
