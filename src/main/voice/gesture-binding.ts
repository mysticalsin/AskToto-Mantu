/**
 * Gesture bindings (G34): main's record of what was in front when the owner started a gesture.
 *
 * `begin` is called by main at the instant a hold chord or panel command starts a capture. The front app comes from
 * the foreground watcher main owns, never from the renderer, a transcript or screen text. A task created from the
 * gesture reads the binding at submission and is checked against it at dispatch (see the task bridge).
 */
import type { GestureBinding, GestureTarget } from '@shared/gesture-binding'

export const GESTURE_BINDING_TTL_MS = 120_000

export interface GestureBindingDeps {
  /** The app in front now (the foreground watcher's last observation), or null when unknown. */
  frontmost(): GestureTarget | null
  now?: () => number
  newId?: () => string
  ttlMs?: number
}

export interface GestureBindings {
  begin(owner: { webContentsId: number; revision: number }, sessionId: string): GestureBinding
  /** The live binding for this owner, or null when none was started, it expired or it was cleared. */
  current(webContentsId: number): GestureBinding | null
  clear(): void
}

export function createGestureBindings(deps: GestureBindingDeps): GestureBindings {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? GESTURE_BINDING_TTL_MS
  let sequence = 0
  const newId = deps.newId ?? ((): string => `gesture-${now().toString(36)}-${(sequence += 1)}`)
  const byOwner = new Map<number, GestureBinding>()
  return {
    begin(owner, sessionId) {
      let target: GestureTarget | null = null
      try {
        const seen = deps.frontmost()
        target = seen ? Object.freeze({ windowId: seen.windowId, pid: seen.pid, title: seen.title }) : null
      } catch {
        target = null
      }
      const binding: GestureBinding = Object.freeze({
        bindingId: newId(),
        owner: Object.freeze({ webContentsId: owner.webContentsId, revision: owner.revision }),
        sessionId,
        target,
        capturedAtMs: now()
      })
      byOwner.set(owner.webContentsId, binding)
      return binding
    },
    current(webContentsId) {
      const binding = byOwner.get(webContentsId)
      if (!binding) return null
      if (now() - binding.capturedAtMs > ttlMs) {
        byOwner.delete(webContentsId)
        return null
      }
      return binding
    },
    clear() {
      byOwner.clear()
    }
  }
}
