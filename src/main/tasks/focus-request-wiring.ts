/**
 * Production composition of the focus-request step (G40): the Electron-facing parts around the pure step in
 * focus-request.ts and the pure Escape hold in escape-release.ts.
 *
 *  - Escape comes from Electron's `globalShortcut`, registered only while a hold is armed and released as soon as the
 *    step ends. The voice chord helper reports modifier keys only (src/shared/voice/modifier-mask.ts), so it cannot
 *    see Escape. If another owner already holds Escape, arming fails and control is not taken.
 *  - The distinct decision is a native message box with its own copy; Stop or the time limit counts as declined.
 *  - Focus goes back through the V04 confirm-focus controller (`capture` then `release`).
 */
import { dialog, globalShortcut } from 'electron'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { auditLog } from '../logger'
import { createConfirmFocus, type PreviousApp } from '../voice/confirm-focus'
import { createEscapeRelease, type EscapeKeySource, type EscapeRelease } from './escape-release'
import {
  createFocusRequestStep,
  FOCUS_REFUSAL_COPY,
  type FocusDecision,
  type FocusPreflightResult,
  type FocusRequestStep
} from './focus-request'

export const FOCUS_DECISION_TIMEOUT_MS = 30_000

/** Registers Escape only while armed. Null when Escape is taken or cannot be registered. */
export function createGlobalShortcutEscapeSource(
  shortcuts: Pick<typeof globalShortcut, 'register' | 'unregister' | 'isRegistered'> = globalShortcut
): EscapeKeySource {
  return {
    arm(onEscape) {
      try {
        if (shortcuts.isRegistered('Escape')) return null
        if (!shortcuts.register('Escape', onEscape)) return null
      } catch {
        return null
      }
      return () => {
        try {
          shortcuts.unregister('Escape')
        } catch {
          /* already released */
        }
      }
    }
  }
}

/** What the person is told Métis would drive. Fixed labels per action id, never request text. */
const FOCUS_TARGET: Readonly<Record<string, string>> = {
  'desktop.photo_booth_capture': 'Photo Booth'
}

export interface FocusDecisionDialogDeps {
  showMessageBox(options: {
    type: 'question'
    title: string
    message: string
    detail: string
    buttons: string[]
    defaultId: number
    cancelId: number
    noLink: boolean
  }): Promise<{ response: number }>
  timeoutMs?: number
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
}

export function createFocusDecisionDialog(
  deps: FocusDecisionDialogDeps
): (input: { actionId: string }, signal: AbortSignal) => Promise<FocusDecision> {
  const timers = deps.timers ?? {
    set: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout)
  }
  return async ({ actionId }, signal) => {
    if (signal.aborted) return 'declined'
    const target = FOCUS_TARGET[actionId] ?? 'another app'
    let timer: unknown = null
    let onAbort: (() => void) | null = null
    const gaveUp = new Promise<FocusDecision>((resolve) => {
      timer = timers.set(() => resolve('declined'), deps.timeoutMs ?? FOCUS_DECISION_TIMEOUT_MS)
      onAbort = () => resolve('declined')
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const asked = deps
      .showMessageBox({
        type: 'question',
        title: 'Let Métis take control?',
        message: `Métis needs to bring ${target} to the front and press a key for you.`,
        detail: 'Press Escape at any time to take control back.',
        buttons: ['Not now', 'Take control'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      .then((box): FocusDecision => (box.response === 1 ? 'granted' : 'declined'))
    try {
      return await Promise.race([asked, gaveUp])
    } finally {
      timers.clear(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}

/** What only the confirm runtime knows: the foreground watcher, the helper that activates an app, the overlay. */
export interface DesktopActionFocusHost {
  platform: NodeJS.Platform
  ownPid: number
  frontmost(): PreviousApp | null
  activatePid(pid: number): Promise<boolean>
  blurWindow(): void
  preflight(request: DesktopActionRequest): Promise<FocusPreflightResult>
}

let sharedEscape: EscapeRelease | null = null
function escapeRelease(): EscapeRelease {
  sharedEscape ??= createEscapeRelease({
    source: createGlobalShortcutEscapeSource(),
    now: () => performance.now(),
    timers: {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    audit: (event, metadata) => auditLog(event, metadata)
  })
  return sharedEscape
}

/** A fresh step per request, so each one remembers its own previous app. */
export function createDesktopActionFocusStep(host: DesktopActionFocusHost): FocusRequestStep {
  const focus = createConfirmFocus({
    platform: host.platform,
    ownPid: host.ownPid,
    frontmost: host.frontmost,
    showForConfirm: () => undefined,
    activatePid: host.activatePid,
    blurWindow: host.blurWindow
  })
  return createFocusRequestStep({
    capturePrevious: () => focus.capture(),
    restoreFocus: () => focus.release('cancelled'),
    preflight: host.preflight,
    decide: createFocusDecisionDialog({ showMessageBox: (options) => dialog.showMessageBox(options) }),
    grantMaySkip: () => false,
    escape: escapeRelease(),
    audit: (event, metadata) => auditLog(event, metadata)
  })
}

export const NO_FOCUS_HOST_RESULT = {
  ok: false,
  reason: 'focus_unavailable',
  copy: FOCUS_REFUSAL_COPY.focus_unavailable
} as const
