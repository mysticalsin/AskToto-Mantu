/**
 * The production composition of the voice turn pipeline (V03): the router, the executor and the durable task
 * bridge, bound to main's live state.
 *
 * index.ts hands this module its command confirmation (policy and lifecycle live there), the input authority
 * (meeting reservation) and the main window, and gets back the `turns` handler the voice runtime calls. The
 * dispatch is the same task bridge CommandConfirmation uses (one archive, one set of uncertain tasks), so an
 * immediate run and a confirmed run share the same durability and the same never-replay guarantee.
 *
 * The classifier seam is deliberately unbound: no provider, model or endpoint is resolved here. Text the grammar
 * does not recognise goes to the typed Ask path, under the Ask disclosure, until the owner confirms the model
 * allowlist for intent classification (D-14).
 */
import type { CommandControlProposal, CommandExecutor } from '../command-control'
import type { CommandConfirmation } from '../command-confirmation'
import type { InputSessionAuthority } from '../input-session-authority'
import { auditLog } from '../logger'
import { desktopActionTaskDeps } from '../tasks/desktop-action-task-runtime'
import { VOICE_ACTIONS_IPC } from '@shared/voice/voice-turn'
import type { VoiceActionsRuntimeDeps } from './voice-actions-runtime'
import { createVoiceTurnPipeline, type VoiceTurnOutcome } from './voice-turn-handler'

interface WindowLike {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}

export interface MainVoiceTurnsDeps {
  commandControl: Pick<CommandConfirmation, 'immediateRunGate' | 'proposeChecked'> &
    Partial<Pick<CommandConfirmation, 'grantDecision' | 'useGrant'>>
  authority: Pick<InputSessionAuthority, 'hasMeetingReservation'>
  window(): WindowLike | null | undefined
  platform?: NodeJS.Platform
  /** Defaults to the shared durable task bridge. */
  execute?: CommandExecutor
  /** V04 and V05 render the outcome (card, pill). Nothing in main depends on it. */
  onOutcome?(outcome: VoiceTurnOutcome): void
}

export function createMainVoiceTurns(deps: MainVoiceTurnsDeps): NonNullable<VoiceActionsRuntimeDeps['turns']> {
  let revision = 0
  const live = (): ReturnType<MainVoiceTurnsDeps['commandControl']['immediateRunGate']> | null => {
    try {
      return deps.commandControl.immediateRunGate()
    } catch {
      return null // a broken gate is a denial
    }
  }
  const pipeline = createVoiceTurnPipeline({
    // No classifier is bound in 2.12 (see the header), so the provider-readiness answer never matters.
    router: { providerReady: () => false },
    executor: {
      platform: deps.platform ?? process.platform,
      execute: deps.execute ?? ((request, context) => desktopActionTaskDeps().execute(request, context)),
      async propose(request): Promise<CommandControlProposal | null> {
        const id = live()?.ownerWebContentsId
        // Through the preflight: a spoken create gets the same card, Return guard, TTL and focus restore.
        return typeof id === 'number'
          ? deps.commandControl.proposeChecked({ webContentsId: id, revision: ++revision }, request)
          : null
      },
      owner() {
        const id = live()?.ownerWebContentsId
        return typeof id === 'number' ? { webContentsId: id, revision } : null
      },
      grants: {
        async decide(request, source) {
          const id = live()?.ownerWebContentsId
          if (typeof id !== 'number' || !deps.commandControl.grantDecision) throw new Error('no_grants')
          return deps.commandControl.grantDecision(id, request, source)
        },
        use: (grantId) => deps.commandControl.useGrant?.(grantId) ?? false
      },
      gate() {
        const gate = live()
        return {
          authenticated: gate?.authenticated === true,
          listenEntitled: gate?.listenEntitled === true,
          ownerPresent: gate?.ownerPresent === true,
          ownerVisible: gate?.ownerVisible === true,
          onboardingExclusive: gate?.onboardingExclusive !== false,
          lifecycleHooksReady: gate?.lifecycleHooksReady === true,
          meetingReserved: deps.authority.hasMeetingReservation
        }
      }
    },
    sendAsk(ask) {
      const win = deps.window()
      if (win && !win.isDestroyed()) win.webContents.send(VOICE_ACTIONS_IPC.ask, ask)
    },
    onOutcome: deps.onOutcome,
    audit: (event, data) => auditLog(event, data)
  })
  return { handle: (text, claim) => pipeline.handle(text, claim) }
}
