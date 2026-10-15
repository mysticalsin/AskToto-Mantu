import type { SpeechPackComponentId } from './manifest'
import type { SpeechPackErrorKind } from './errors'

export type SpeechPackState =
  | { status: 'not-installed' }
  | { status: 'queued' }
  | { status: 'downloading'; bytesDone: number; bytesTotal: number }
  | { status: 'verifying' }
  | { status: 'self-testing' }
  | { status: 'ready' }
  | { status: 'paused' }
  | { status: 'error'; kind: SpeechPackErrorKind; requiredBytes?: number; freeBytes?: number }

export interface SpeechPackStateEvent {
  id: SpeechPackComponentId
  state: SpeechPackState
  freshlyVerified?: boolean
}

export function createSpeechPackStateEvents(
  ids: readonly SpeechPackComponentId[],
  intervalMs: number
): {
  states: Map<SpeechPackComponentId, SpeechPackState>
  set: (id: SpeechPackComponentId, state: SpeechPackState, freshlyVerified?: boolean) => void
  subscribe: (listener: (event: SpeechPackStateEvent) => void) => () => void
} {
  const states = new Map<SpeechPackComponentId, SpeechPackState>(ids.map((id) => [id, { status: 'not-installed' }]))
  const fresh = new Set<SpeechPackComponentId>()
  const listeners = new Set<(event: SpeechPackStateEvent) => void>()
  const sentAt = new Map<SpeechPackComponentId, number>()
  const timers = new Map<SpeechPackComponentId, ReturnType<typeof setTimeout>>()
  const deliver = (id: SpeechPackComponentId): void => {
    sentAt.set(id, Date.now())
    const state = states.get(id) as SpeechPackState
    for (const listener of listeners) listener({ id, state, freshlyVerified: fresh.has(id) })
  }
  const schedule = (id: SpeechPackComponentId): void => {
    if (timers.has(id)) return
    const delay = (sentAt.get(id) ?? -Infinity) + intervalMs - Date.now()
    if (delay <= 0) return deliver(id)
    const timer = setTimeout(() => {
      timers.delete(id)
      deliver(id)
    }, delay)
    timer.unref?.()
    timers.set(id, timer)
  }
  return {
    states,
    set(id, state, freshlyVerified = false) {
      if (state.status === 'ready') {
        if (freshlyVerified) fresh.add(id)
        else fresh.delete(id)
      } else if (
        state.status === 'queued' ||
        state.status === 'downloading' ||
        state.status === 'error' ||
        state.status === 'paused'
      ) {
        fresh.delete(id)
      }
      states.set(id, state)
      schedule(id)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
