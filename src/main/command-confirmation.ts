import { COMMAND_RETURN_GUARD_MS } from '@shared/command-return-guard'
import { IPC } from '@shared/ipc'
import { COMMAND_CONFIRM_IPC } from '@shared/metis-command-contract'
import type { VoiceImmediateRunInput } from '@shared/voice/voice-action-policy'
import {
  CommandControl,
  commandConfirmationPolicyAllows,
  type CommandCardLifecycle,
  type CommandExecutor,
  type CommandPreflightResult,
  type CommandPreflightStage
} from './command-control'

type CommandOwner = {
  isDestroyed(): boolean
  isVisible(): boolean
  isFocused(): boolean
  webContents: { id?: number; send(channel: string, ...args: unknown[]): void }
}

/** What an immediate voice run asks main about right now: the confirmation policy's inputs, without owner focus. */
export type CommandImmediateRunGate = Omit<VoiceImmediateRunInput, 'turnCurrent' | 'meetingReserved'> & {
  ownerWebContentsId: number | null
}

const STOP_TASK_REASONS: ReadonlySet<string> = new Set([
  'window_closed',
  'window_replaced',
  'renderer_replaced',
  'auth_session_cleared',
  'system_suspend',
  'screen_locked'
])

export type CommandConfirmationDeps = {
  execute: CommandExecutor
  /** Optional boot hook: restore durable task state so interrupted dispatches surface as uncertain. */
  recoverTasks?: () => Promise<unknown>
  /** Stop: invalidates queued tasks and aborts running step leases. Called when the owner or session goes away. */
  stopTasks?: () => void
  isAuthenticated: () => boolean
  hasListenEntitlement: () => boolean
  getOwner: () => CommandOwner | null
  isOnboardingExclusive: () => boolean
  /** `app.isAccessibilitySupportEnabled()`: reading a card with assistive technology takes longer, so it lives 30 s. */
  isAssistiveTechnologyOn?: () => boolean
  /** Permissions, target app, sign-in and recording checks. See voice/command-preflight.ts. */
  preflight?: (request: Parameters<CommandExecutor>[0], stage: CommandPreflightStage) => Promise<CommandPreflightResult>
  /** The card's window life (focus exception and restore). See voice/confirm-focus.ts. */
  card?: CommandCardLifecycle
  /** The platform the card previews are written for. Defaults to the host; tests pin it. */
  platform?: NodeJS.Platform
  /** Earliest a confirmation can land after its card appeared. Defaults to the 300 ms Return guard. */
  minConfirmDelayMs?: number
  audit: (event: 'command.confirmed' | 'command.revoked', metadata: Record<string, string>) => void
}

export interface CommandPowerMonitor {
  on(event: 'suspend', listener: () => void): unknown
  on(event: 'lock-screen', listener: () => void): unknown
}

type CommandConfirmationLogger = Pick<typeof import('./logger').mainLog, 'warn' | 'error'>

/** Main-process policy and lifecycle gate for every external command confirmation. */
export class CommandConfirmation extends CommandControl {
  private readonly lifecycleState: { hooksReady: boolean }
  private readonly recoverTasks: (() => Promise<unknown>) | undefined
  private readonly stopTasks: (() => void) | undefined
  private readonly readImmediateRunGate: () => CommandImmediateRunGate

  constructor(deps: CommandConfirmationDeps) {
    const lifecycleState = { hooksReady: false }
    super({
      execute: deps.execute,
      policyAllows: () => {
        const owner = deps.getOwner()
        const ownerState = owner
          ? owner.isDestroyed()
            ? { destroyed: true, visible: false, focused: false }
            : { destroyed: false, visible: owner.isVisible(), focused: owner.isFocused() }
          : null
        return commandConfirmationPolicyAllows({
          authenticated: deps.isAuthenticated(),
          listenEntitled: deps.hasListenEntitlement(),
          owner: ownerState,
          onboardingExclusive: deps.isOnboardingExclusive(),
          lifecycleHooksReady: lifecycleState.hooksReady
        })
      },
      audit: deps.audit,
      assistiveTechnology: deps.isAssistiveTechnologyOn,
      preflight: deps.preflight,
      card: deps.card,
      minConfirmDelayMs: deps.minConfirmDelayMs ?? COMMAND_RETURN_GUARD_MS,
      platform: deps.platform,
      onState: (state) => {
        const owner = deps.getOwner()
        if (owner && !owner.isDestroyed()) owner.webContents.send(IPC.metisCommandState, state)
      },
      onNotice: (notice) => {
        const owner = deps.getOwner()
        if (owner && !owner.isDestroyed()) owner.webContents.send(COMMAND_CONFIRM_IPC.notice, notice)
      }
    })
    this.lifecycleState = lifecycleState
    this.recoverTasks = deps.recoverTasks
    this.stopTasks = deps.stopTasks
    this.readImmediateRunGate = () => {
      const owner = deps.getOwner()
      const live = owner !== null && !owner.isDestroyed()
      const id = live ? owner.webContents.id : undefined
      return {
        authenticated: deps.isAuthenticated(),
        listenEntitled: deps.hasListenEntitlement(),
        ownerPresent: live,
        ownerVisible: live && owner.isVisible(),
        onboardingExclusive: deps.isOnboardingExclusive(),
        lifecycleHooksReady: lifecycleState.hooksReady,
        ownerWebContentsId: typeof id === 'number' ? id : null
      }
    }
  }

  /**
   * Revocation of the pending proposal also stops queued and running tasks when the owner or the session goes
   * away. A blur or a hide does not: launching an app moves focus, and that must not cancel the work that did it.
   */
  override revokeForLifecycleEvent(reason: string): void {
    try {
      super.revokeForLifecycleEvent(reason)
    } finally {
      if (STOP_TASK_REASONS.has(reason)) this.stopTasks?.()
    }
  }

  /** The inputs an immediate voice run is gated on, read live. Focus is deliberately not one of them. */
  immediateRunGate(): CommandImmediateRunGate {
    return this.readImmediateRunGate()
  }

  initialize(
    powerMonitor: CommandPowerMonitor,
    initializeLogging: () => void,
    logger: CommandConfirmationLogger
  ): void {
    initializeLogging()
    this.registerLifecycleRevocationHooks(powerMonitor, logger)
    // Recovery never executes anything: it only reloads task history so an interrupted dispatch is reported uncertain.
    void this.recoverTasks?.().catch((error: unknown) => {
      logger.warn('[boot] desktop action task recovery failed; dispatch stays closed until it succeeds:', error)
    })
  }

  onWindowBlurred(isCurrentWindow: boolean, onCurrentBlur: () => void): void {
    if (!isCurrentWindow) return
    this.runAfterLifecycleRevocation('window_blurred', onCurrentBlur)
  }

  onWindowHidden(isCurrentWindow: boolean): void {
    if (isCurrentWindow) this.revokeForLifecycleEvent('window_hidden')
  }

  wrapLifecycleListener<TArgs extends unknown[], TResult>(
    reason: string,
    listener: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult {
    return (...args) => this.runAfterLifecycleRevocation(reason, () => listener(...args))
  }

  private runAfterLifecycleRevocation<TResult>(reason: string, listener: () => TResult): TResult {
    let revocationFailed = false
    let revocationError: unknown
    let result: TResult
    try {
      this.revokeForLifecycleEvent(reason)
    } catch (error) {
      revocationFailed = true
      revocationError = error
    } finally {
      result = listener()
    }
    if (revocationFailed) throw revocationError
    return result
  }

  private registerLifecycleRevocationHooks(powerMonitor: CommandPowerMonitor, logger: CommandConfirmationLogger): void {
    let suspendHookRegistered = false
    let lockScreenHookRegistered = false
    try {
      powerMonitor.on('suspend', () => this.revokeForLifecycleEvent('system_suspend'))
      suspendHookRegistered = true
    } catch (error) {
      logger.warn('[boot] command confirmation disabled: suspend revocation hook registration failed:', error)
    }
    try {
      powerMonitor.on('lock-screen', () => this.revokeForLifecycleEvent('screen_locked'))
      lockScreenHookRegistered = true
    } catch (error) {
      logger.warn('[boot] command confirmation disabled: lock-screen revocation hook registration failed:', error)
    }
    this.lifecycleState.hooksReady = suspendHookRegistered && lockScreenHookRegistered
    if (!this.lifecycleState.hooksReady) {
      logger.error('[boot] command confirmation disabled: lifecycle revocation hooks are not ready')
    }
  }
}
