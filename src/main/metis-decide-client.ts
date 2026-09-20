/**
 * Métis 2.0 Cap 2 — optional portal /v1/decide client for action_disambiguate ONLY.
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
          template: 'action_disambiguate',
          payload: {
            transcript: input.transcript.slice(0, 2000),
            candidates: input.candidates
          },
          deadlineMs
        }),
        signal: ctrl.signal
      }),
      timedOut
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
  }
}
