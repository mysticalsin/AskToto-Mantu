import { Notification } from 'electron'
import { startQuietMonitor } from './infra/scheduler/quiet-monitor'
import {
  createQuietOutputGate,
  evaluateQuietPolicy,
  readOsFocusSignal,
  readScreenShareSignal,
  type QuietPolicyInput
} from './quiet-policy'
import type {
  QuietAction,
  QuietDeferredBatch,
  QuietMode,
  QuietOutputChannel,
  QuietPolicy
} from '@shared/quiet-mode-settings'

export interface QuietOutputDependencies {
  getQuietMode?: () => QuietMode
  isInCall?: () => boolean
  readScreenShare?: () => QuietPolicyInput['screenShare']
  readFocus?: () => QuietPolicyInput['focus']
  onQuietReleased?: (batch: QuietDeferredBatch) => void
  now?: () => number
  monitorIntervalMs?: number
}

let quietInputReader: (() => QuietPolicyInput) | null = null
let quietOutputGate: ReturnType<typeof createQuietOutputGate> | null = null
let stopMonitor: (() => void) | null = null

function currentQuietInput(): QuietPolicyInput {
  return (
    quietInputReader?.() ?? {
      quietMode: 'calls-and-screen-sharing',
      inCall: false,
      screenShare: readScreenShareSignal(),
      focus: readOsFocusSignal()
    }
  )
}

export function readQuietPolicy(): QuietPolicy {
  const input = currentQuietInput()
  quietOutputGate?.refresh(input)
  return evaluateQuietPolicy(input)
}

/** Main-owned output gate for asynchronous notifications and unsolicited renderer toasts. */
export function submitQuietOutput(
  channel: QuietOutputChannel,
  directRequest: boolean,
  deliver: () => void
): QuietAction {
  const input = currentQuietInput()
  if (quietOutputGate) return quietOutputGate.offer(channel, input, directRequest, deliver)
  const action = directRequest ? 'allow' : evaluateQuietPolicy(input)[channel]
  if (action === 'allow') deliver()
  return action
}

/** Gate for an unsolicited ask turn: a deferred ambient turn is recorded so its release is announced. */
export function quietActionForAsk(channel: QuietOutputChannel): QuietAction {
  const action = readQuietPolicy()[channel]
  if (action === 'defer') submitQuietOutput(channel, false, () => {})
  return action
}

export function configureQuietOutput(deps: QuietOutputDependencies): void {
  quietInputReader = () => ({
    quietMode: deps.getQuietMode?.() ?? 'calls-and-screen-sharing',
    inCall: deps.isInCall?.() ?? false,
    screenShare: deps.readScreenShare?.() ?? readScreenShareSignal(),
    focus: deps.readFocus?.() ?? readOsFocusSignal()
  })
  quietOutputGate = createQuietOutputGate({
    now: deps.now ?? Date.now,
    onReleased: (batch) => deps.onQuietReleased?.(batch)
  })
  stopMonitor?.()
  stopMonitor = null
  if (deps.isInCall || deps.readScreenShare || deps.readFocus) {
    stopMonitor = startQuietMonitor(() => quietOutputGate?.refresh(currentQuietInput()), deps.monitorIntervalMs ?? 500)
  }
}

/**
 * The one place a native notification is created. Unsolicited ones go through the quiet output gate; a
 * `directRequest` (the owner just asked for it, for example connecting an account) is never suppressed.
 */
export function showQuietNotification(options: {
  title: string
  body: string
  directRequest?: boolean
  onClick?: () => void
}): QuietAction {
  if (!Notification.isSupported()) return 'drop'
  return submitQuietOutput('toast', options.directRequest === true, () => {
    const notification = new Notification({ title: options.title, body: options.body })
    if (options.onClick) notification.on('click', options.onClick)
    notification.show()
  })
}

/** The completion notice for a finished audio import. */
export function notifyImportComplete(job: { title: string; recapError?: string }, onClick: () => void): QuietAction {
  const body = job.recapError
    ? `${job.title} transcript is ready. Summary needs a retry.`
    : `${job.title} transcript and summary are ready.`
  return showQuietNotification({ title: 'Import complete', body, onClick })
}
