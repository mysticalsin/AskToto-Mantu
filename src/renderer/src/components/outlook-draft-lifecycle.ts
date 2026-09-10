import { sha256Hex } from '@shared/sha256'

export interface OutlookDraftPayload {
  subject: string
  body: string
}

export interface OutlookDraftIntent {
  key: string
  payload: OutlookDraftPayload
}

export interface OutlookDraftResult {
  ok: boolean
  error?: string
}

export interface OutlookDraftCompletion {
  current: boolean
  /** Same semantic meeting+payload is selected, even if an edit-away/edit-back advanced generation. */
  selected: boolean
  ok: boolean
  error: string | null
}

export type OutlookDraftSessionStatus = {
  phase: 'idle' | 'saving' | 'saved' | 'error'
  error: string | null
}

const AMBIGUOUS_DRAFT_ERROR =
  'Could not confirm whether Outlook created the draft. Check Drafts before trying again. Nothing was sent.'
const IDLE_STATUS: OutlookDraftSessionStatus = { phase: 'idle', error: null }
// Session-only idempotency: fixed-size fingerprints avoid retaining reviewed email bodies after Review
// unmounts. Entries deliberately live until renderer exit so History → reopen cannot re-arm a duplicate.
const sessionStatus = new Map<string, OutlookDraftSessionStatus>()
const sessionListeners = new Map<string, Set<() => void>>()

function publish(key: string, status: OutlookDraftSessionStatus): void {
  sessionStatus.set(key, status)
  for (const listener of sessionListeners.get(key) ?? []) listener()
}

export function outlookDraftIntent(meeting: string, payload: OutlookDraftPayload): OutlookDraftIntent {
  const normalized = {
    subject: (payload.subject || '').trim().slice(0, 200),
    body: (payload.body || '').slice(0, 20_000)
  }
  const serialized = JSON.stringify([meeting, normalized.subject, normalized.body])
  return { key: sha256Hex(serialized), payload: normalized }
}

export class OutlookDraftLifecycle {
  private currentKey = ''
  private generation = 0

  select(intent: OutlookDraftIntent): boolean {
    if (intent.key === this.currentKey) return false
    this.currentKey = intent.key
    this.generation++
    return true
  }

  isConfirmed(intent: OutlookDraftIntent): boolean {
    return this.status(intent).phase === 'saved'
  }

  status(intent: OutlookDraftIntent): OutlookDraftSessionStatus {
    return sessionStatus.get(intent.key) ?? IDLE_STATUS
  }

  subscribe(intent: OutlookDraftIntent, listener: () => void): () => void {
    let listeners = sessionListeners.get(intent.key)
    if (!listeners) {
      listeners = new Set()
      sessionListeners.set(intent.key, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
      if (listeners?.size === 0) sessionListeners.delete(intent.key)
    }
  }

  start(
    intent: OutlookDraftIntent,
    create: (payload: OutlookDraftPayload) => Promise<OutlookDraftResult>
  ): Promise<OutlookDraftCompletion> | null {
    this.select(intent)
    const existing = this.status(intent).phase
    if (existing === 'saving' || existing === 'saved') return null
    publish(intent.key, { phase: 'saving', error: null })
    const generation = this.generation

    return (async () => {
      let result: OutlookDraftResult
      try {
        result = await create(intent.payload)
      } catch {
        result = { ok: false, error: AMBIGUOUS_DRAFT_ERROR }
      }
      publish(intent.key, result.ok
        ? { phase: 'saved', error: null }
        : { phase: 'error', error: result.error || AMBIGUOUS_DRAFT_ERROR })
      return {
        current: this.currentKey === intent.key && this.generation === generation,
        selected: this.currentKey === intent.key,
        ok: result.ok,
        error: result.ok ? null : result.error || AMBIGUOUS_DRAFT_ERROR
      }
    })()
  }
}
