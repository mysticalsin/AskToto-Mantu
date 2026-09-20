/**
 * Métis 2.0 Cap 2 — optional portal /v1/decide client (Cap2 action_disambiguate + Cap3 intel_rank/intel_score).
 * Deterministic parser remains authoritative when Jev off/outage/timeout.
 * Never sends photos or camera frames.
 */

import { isDesktopAdapterId, type DesktopAdapterId } from '@shared/desktop-actions'

export type DecideDisambiguateInput = {
  operatorBaseUrl: string
  /** Seat device auth material already used for heartbeat/ask — never a TypeSafe key. */
  authorizationHeader: string
  transcript: string
  candidates: DesktopAdapterId[]
  /** Hard deadline; Stop/Escape must not wait on this. */
  deadlineMs?: number
  fetchImpl?: typeof fetch
  /** Session owner may revoke stale optional decision work. */
  signal?: AbortSignal
}

export type DecideDisambiguateResult =
  | { ok: true; adapterId: DesktopAdapterId; confidence: number | null }
  | { ok: false; error: string; timedOut?: boolean }

export async function decideActionDisambiguate(
  input: DecideDisambiguateInput
): Promise<DecideDisambiguateResult> {
  const base = input.operatorBaseUrl.replace(/\/$/, '')
  if (!base || !/^https:\/\//i.test(base)) {
    return { ok: false, error: 'operator_url_missing' }
  }
  if (!input.candidates.length) return { ok: false, error: 'no_candidates' }

  const deadlineMs = Math.max(250, Math.min(input.deadlineMs ?? 1500, 3000))
  const ctrl = new AbortController()
  const fetchImpl = input.fetchImpl ?? fetch
  const abortFromOwner = () => ctrl.abort()
  if (input.signal?.aborted) ctrl.abort()
  else input.signal?.addEventListener('abort', abortFromOwner, { once: true })
  let timeout: ReturnType<typeof setTimeout> | null = null

  try {
    const aborted = new Promise<never>((_, reject) => {
      if (ctrl.signal.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        return
      }
      ctrl.signal.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true }
      )
    })
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        ctrl.abort()
        reject(Object.assign(new Error('timeout'), { name: 'AbortError' }))
      }, deadlineMs)
      ctrl.signal.addEventListener('abort', () => {
        if (timeout) clearTimeout(timeout)
      })
    })
    const res = await Promise.race([
      fetchImpl(`${base}/v1/decide`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: input.authorizationHeader
        },
        body: JSON.stringify({
          template: 'action_disambiguate',
          payload: {
            transcript: input.transcript.slice(0, 2000),
            candidates: input.candidates
          },
          deadlineMs
        }),
        signal: ctrl.signal
      }),
      timedOut,
      aborted
    ])
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean
      error?: string
      result?: { adapterId?: unknown }
      confidence?: number | null
    } | null
    if (!res.ok || !json || json.ok !== true) {
      return { ok: false, error: (json && json.error) || `http_${res.status}` }
    }
    const id = json.result?.adapterId
    if (!isDesktopAdapterId(id)) return { ok: false, error: 'invalid_adapter' }
    if (!input.candidates.includes(id)) return { ok: false, error: 'adapter_not_in_candidates' }
    return {
      ok: true,
      adapterId: id,
      confidence: typeof json.confidence === 'number' ? json.confidence : null
    }
  } catch (e) {
    const timedOut = (e as { name?: string })?.name === 'AbortError'
    return { ok: false, error: timedOut ? 'timeout' : 'network', timedOut }
  } finally {
    if (timeout) clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abortFromOwner)
  }
}


/** Cap3 Jev classification labels — portal /v1/decide intel_rank | intel_score only. */
export const JEV_INTEL_LABELS = [
  'on track',
  'needs attention',
  'blocked',
  'stale',
  'insufficient'
] as const
export type JevIntelLabel = (typeof JEV_INTEL_LABELS)[number]

export function isJevIntelLabel(v: unknown): v is JevIntelLabel {
  return typeof v === 'string' && (JEV_INTEL_LABELS as readonly string[]).includes(v)
}

export type DecideIntelInput = {
  operatorBaseUrl: string
  authorizationHeader: string
  /** Narrow evidence snapshot — never photos, tokens, or raw vault keys. */
  evidence: Record<string, unknown>
  template?: 'intel_rank' | 'intel_score'
  deadlineMs?: number
  fetchImpl?: typeof fetch
}

export type DecideIntelResult =
  | {
      ok: true
      label: JevIntelLabel
      confidence: number | null
      ranked?: Array<{ id: string; label: JevIntelLabel }>
    }
  | { ok: false; error: string; timedOut?: boolean; assistUnavailable: true }

/**
 * Cap3 — optional portal classify over deterministic evidence.
 * On any failure: assistUnavailable (caller keeps deterministic layer; never invent scores).
 */
export async function decideIntelClassify(input: DecideIntelInput): Promise<DecideIntelResult> {
  const base = input.operatorBaseUrl.replace(/\/$/, '')
  if (!base || !/^https:\/\//i.test(base)) {
    return { ok: false, error: 'operator_url_missing', assistUnavailable: true }
  }
  const template = input.template ?? 'intel_score'
  const deadlineMs = Math.max(250, Math.min(input.deadlineMs ?? 2500, 5000))
  const ctrl = new AbortController()
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const timedOut = new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        ctrl.abort()
        reject(Object.assign(new Error('timeout'), { name: 'AbortError' }))
      }, deadlineMs)
      ctrl.signal.addEventListener('abort', () => clearTimeout(t))
    })
    const res = await Promise.race([
      fetchImpl(`${base}/v1/decide`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: input.authorizationHeader
        },
        body: JSON.stringify({
          template,
          payload: { evidence: input.evidence },
          deadlineMs
        }),
        signal: ctrl.signal
      }),
      timedOut
    ])
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean
      error?: string
      result?: { label?: unknown; ranked?: unknown }
      confidence?: number | null
    } | null
    if (!res.ok || !json || json.ok !== true) {
      return {
        ok: false,
        error: (json && json.error) || `http_${res.status}`,
        assistUnavailable: true
      }
    }
    const label = json.result?.label
    if (!isJevIntelLabel(label)) {
      return { ok: false, error: 'invalid_label', assistUnavailable: true }
    }
    let ranked: Array<{ id: string; label: JevIntelLabel }> | undefined
    if (Array.isArray(json.result?.ranked)) {
      ranked = []
      for (const row of json.result!.ranked as Array<{ id?: unknown; label?: unknown }>) {
        if (typeof row?.id === 'string' && isJevIntelLabel(row.label)) {
          ranked.push({ id: row.id, label: row.label })
        }
      }
      if (!ranked.length) ranked = undefined
    }
    return {
      ok: true,
      label,
      confidence: typeof json.confidence === 'number' ? json.confidence : null,
      ranked
    }
  } catch (e) {
    const timedOut = (e as { name?: string })?.name === 'AbortError'
    return {
      ok: false,
      error: timedOut ? 'timeout' : 'network',
      timedOut,
      assistUnavailable: true
    }
  }
}
