import { inspectBundleResponse } from '@shared/bundle-response'
import { operatorUrlConfigured, resolveOperatorIngestSecret, resolveOperatorUrl } from '@shared/operator'
import { hashOperatorId, operatorHmacHeaders } from './operator-hmac-sign'
import { getMachineId } from './license'
import { verifyOperatorSkillPack } from './operator-skill-verify'
import { mainLog } from './logger'

const POLL_MS = 6 * 60 * 60 * 1000

/** Skill ids Operator may overlay. Kept local — this branch has no mode-skills module. */
const OVERLAY_SKILL_IDS = new Set([
  'humanizer',
  'interview',
  'recruiting',
  'meeting',
  'sales',
  'negotiation',
  'presentation',
  'support',
  'general',
  'cold-call'
])

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
  return resolveOperatorIngestSecret(settings, env)
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
  let verified = 0
  for (const row of data.skills) {
    if (typeof row.signed !== 'string') continue
    if (applySignedSkillPack(row.signed)) verified++
  }
  return verified
}

/**
 * Verify one signed pack. On this branch lineage there is no mode-skills overlay writer,
 * so a valid pack is counted as verified and logged — not written to disk.
 */
export function applySignedSkillPack(token: string, publicKeyRaw?: string): boolean {
  const pack = verifyOperatorSkillPack(token, publicKeyRaw)
  if (!pack) return false
  if (!OVERLAY_SKILL_IDS.has(pack.skillId)) return false
  mainLog.info(`[operator] skill pack verified (${pack.skillId}@${pack.version}); apply skipped (no mode-skills)`)
  return true
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
