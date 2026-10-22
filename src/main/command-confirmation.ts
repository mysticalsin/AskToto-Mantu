import { IPC } from '@shared/ipc'
import type { VoiceImmediateRunInput } from '@shared/voice/voice-action-policy'
import { CommandControl, commandConfirmationPolicyAllows, type CommandExecutor } from './command-control'

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

export type CommandConfirmationDeps = {
  execute: CommandExecutor
  /** Optional boot hook: restore durable task state so interrupted dispatches surface as uncertain. */
  recoverTasks?: () => Promise<unknown>
  isAuthenticated: () => boolean
  hasListenEntitlement: () => boolean
  getOwner: () => CommandOwner | null
  isOnboardingExclusive: () => boolean
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
      onState: (state) => {
        const owner = deps.getOwner()
        if (owner && !owner.isDestroyed()) owner.webContents.send(IPC.metisCommandState, state)
      }
    })
    this.lifecycleState = lifecycleState
    this.recoverTasks = deps.recoverTasks
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
