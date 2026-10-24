import { randomBytes, timingSafeEqual } from 'node:crypto'
import { previewForDesktopAction, previewFromOutside, type CommandPreviewResult } from '@shared/command-preview'
import { isDesktopAdapterId, type DesktopActionRequest, type DesktopActionResult } from '@shared/desktop-actions'
import {
  COMMAND_PROPOSAL_TTL_ASSISTIVE_MS,
  COMMAND_PROPOSAL_TTL_MS,
  type MetisCommandNotice,
  type MetisCommandState
} from '@shared/metis-command-contract'
import type { VoiceTurnSource } from '@shared/voice/voice-action-policy'
import { actionEnvelope, checkDependsOn, isArgsHash, isObservedVerified, type ActionEnvelope } from './action-guard'
import {
  refusalFor,
  type ActionGrantService,
  type GrantAuditEvent,
  type GrantedRunDecision,
  type GrantScopeKind,
  type GrantSummary
} from './features/grants'

export { COMMAND_PROPOSAL_TTL_MS }

/** The approval is the proposal id, the nonce and the hash of the exact request it authorizes (ActionGuard). */
export type CommandControlProposal = { proposalId: string; nonce: string; argsHash: string }
/** Cancelling authorizes nothing, so the id and nonce are enough. */
export type CommandControlCancellation = Omit<CommandControlProposal, 'argsHash'>
export type CommandControlState = MetisCommandState
export type CommandControlReason =
  | 'proposal_missing'
  | 'owner_mismatch'
  | 'proposal_mismatch'
  | 'nonce_mismatch'
  | 'args_mismatch'
  | 'expired'
  | 'policy_denied'
  | 'preflight_failed'
  | 'too_soon'
  | 'interrupted'
  | 'outcome_unverified'
  | 'adapter_failed'
  /** G31: the plan or quota said no after the user approved. Nothing ran. */
  | 'purchase_denied'
  /** G31: the operating system has not allowed Métis to do it. Nothing ran. */
  | 'permission_denied'

/** The scopes an approval can ask for. One action is the default and needs no request: it is the approval itself. */
export type CommandGrantScope = Exclude<GrantScopeKind, 'action'>
/** What the approval's grant request came to. Never carries the grant id or any request data. */
export type CommandGrantOutcome =
  | { ok: true; scope: GrantScopeKind }
  | { ok: false; reason: 'not_grantable' | 'scope_unavailable' | 'limit' }
export type CommandAuditEvent = 'command.confirmed' | 'command.revoked' | GrantAuditEvent

type CurrentProposal = CommandControlProposal & {
  ownerWebContentsId: number
  revision: number
  request: DesktopActionRequest
  expiresAt: number
  idempotencyKey: string
  dependsOn: readonly string[]
  shownAt: number
  display: CommandPreviewResult
}

/** Checks that a card can succeed: before it is shown, and again after Return and before anything is dispatched. */
export type CommandPreflightStage = 'propose' | 'confirm'
export type CommandPreflightResult = { ok: true } | { ok: false; notice: MetisCommandNotice }

/**
 * The card's window life. `presented` runs when a proposal becomes the card on screen (the only caller of the
 * focus exception); `release` runs when that card is resolved, with why, so focus can go back to the previous app.
 */
export interface CommandCardLifecycle {
  presented(): void
  release(reason: string): void | Promise<void>
}

export type CommandConfirmationPolicyInput = {
  authenticated: boolean
  listenEntitled: boolean
  owner: { destroyed: boolean; visible: boolean; focused: boolean } | null
  onboardingExclusive: boolean
  lifecycleHooksReady: boolean
}

/** Pure gate for every non-in-app action. Missing trust or lifecycle state denies confirmation. */
export function commandConfirmationPolicyAllows(input: CommandConfirmationPolicyInput): boolean {
  return (
    input.authenticated &&
    input.listenEntitled &&
    input.owner !== null &&
    !input.owner.destroyed &&
    input.owner.visible &&
    input.owner.focused &&
    !input.onboardingExclusive &&
    input.lifecycleHooksReady
  )
}

/** What main knows about one confirmed proposal. The owner comes from the IPC sender, never the renderer payload. */
export type CommandExecutionContext = ActionEnvelope & {
  proposalId: string
  owner: { webContentsId: number; revision: number }
  /** Proposal ids that must already be verified. The durable task bridge enforces it. */
  dependsOn: readonly string[]
  /** G40: this dispatch was approved by a standing grant, not the confirm card. Foreground control still asks. */
  viaGrant?: boolean
}

export type CommandExecutor = (
  request: DesktopActionRequest,
  context: CommandExecutionContext
) => Promise<DesktopActionResult>

export type CommandControlDeps = {
  execute: CommandExecutor
  /** Main-process policy is required: omitting it must never turn confirmation into permission. */
  policyAllows: (request: DesktopActionRequest) => boolean
  audit?: (event: CommandAuditEvent, metadata: Record<string, string>) => void
  /** G31: scoped grants and the separate purchase and permission decisions. Absent means every action asks. */
  grants?: ActionGrantService
  onState?: (state: CommandControlState) => void
  now?: () => number
  /** Fixed lifetime override (tests). Without it the lifetime is 12 s, or 30 s with assistive technology on. */
  ttlMs?: number
  assistiveTechnology?: () => boolean
  /** The exact consequence for a request, from main's templates. No preview means no card. */
  previewFor?: (request: DesktopActionRequest) => CommandPreviewResult | null
  platform?: NodeJS.Platform
  /** A confirmation earlier than this after the card appeared is refused and does not consume the proposal. */
  minConfirmDelayMs?: number
  preflight?: (request: DesktopActionRequest, stage: CommandPreflightStage) => Promise<CommandPreflightResult>
  /** Honest copy for a command that could not start (signed out, permission off, app missing). */
  onNotice?: (notice: MetisCommandNotice) => void
  card?: CommandCardLifecycle
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Lifecycle events that end a confirmed action still waiting on its confirm-stage check (an Automation prompt can be
 * on screen for seconds). A blur is not one: the system prompt itself takes focus. A runtime clear is not one either:
 * it follows the confirmation that consumed the proposal.
 */
const INTERRUPTS_CONFIRM: ReadonlySet<string> = new Set([
  'screen_locked',
  'system_suspend',
  'window_closed',
  'window_replaced'
])

export class CommandControl {
  private current: CurrentProposal | null = null
  /** The confirmed action between consuming its proposal and dispatch, if any. */
  private confirming: { interruptedBy: string | null } | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number

  constructor(private readonly deps: CommandControlDeps) {
    this.now = deps.now ?? Date.now
  }

  private ttlMs(): number {
    if (this.deps.ttlMs !== undefined) return this.deps.ttlMs
    return this.deps.assistiveTechnology?.() === true ? COMMAND_PROPOSAL_TTL_ASSISTIVE_MS : COMMAND_PROPOSAL_TTL_MS
  }

  propose(
    owner: { webContentsId: number; revision: number },
    request: DesktopActionRequest,
    options: { dependsOn?: readonly string[]; provenance?: 'external' } = {}
  ): CommandControlProposal {
    // The final, synchronous card-installation boundary: an outside request never replaces a card or a confirmed
    // action, however long its asynchronous preflight took. The owner's card keeps its id, nonce and preview.
    if (options.provenance === 'external' && this.hasPendingProposal()) throw new Error('busy')
    this.clearCurrent()
    const dependencies = checkDependsOn(options.dependsOn ?? [])
    if (!dependencies.ok) {
      this.emit()
      void this.release('revoked')
      throw new Error(dependencies.reason)
    }
    // The proposal keeps a private snapshot. No caller that supplied the request can mutate what
    // the user later confirms, even if a future command source starts reusing request objects.
    const requestSnapshot = Object.freeze({
      ...request,
      args: Object.freeze({ ...request.args })
    }) as DesktopActionRequest
    // The card states exactly what will run, from main's template for this request. Without a preview there is no
    // card: the person is never asked to approve a consequence they cannot read.
    const shown = (this.deps.previewFor ?? ((r) => previewForDesktopAction(r, this.deps.platform)))(requestSnapshot)
    const display = shown && options.provenance === 'external' ? previewFromOutside(shown) : shown
    if (!display) {
      this.emit()
      void this.release('revoked')
      throw new Error('preview_unavailable')
    }
    const proposalId = randomBytes(16).toString('hex')
    const { argsHash, idempotencyKey } = actionEnvelope(proposalId, requestSnapshot)
    const proposal = { proposalId, nonce: randomBytes(32).toString('hex'), argsHash }
    this.current = {
      ...proposal,
      ownerWebContentsId: owner.webContentsId,
      revision: owner.revision,
      request: requestSnapshot,
      expiresAt: this.now() + this.ttlMs(),
      idempotencyKey,
      dependsOn: dependencies.dependsOn,
      shownAt: this.now(),
      display
    }
    this.armExpiry(this.current)
    this.emit()
    try {
      this.deps.card?.presented()
    } catch {
      // The window may be gone. The proposal stays confirmable only by a focused, visible owner (policy).
    }
    return proposal
  }

  /**
   * Preflight, then propose. A failed preflight shows no card and publishes honest copy instead. `stillWanted`
   * lets the caller drop a proposal that was superseded while the checks ran. Without a preflight this is
   * exactly `propose`, synchronously.
   */
  proposeChecked(
    owner: { webContentsId: number; revision: number },
    request: DesktopActionRequest,
    options: { dependsOn?: readonly string[]; stillWanted?: () => boolean; provenance?: 'external' } = {}
  ): Promise<CommandControlProposal | null> {
    if (!this.deps.preflight) {
      try {
        return Promise.resolve(this.propose(owner, request, options))
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return this.proposeAfterPreflight(owner, request, options)
  }

  private async proposeAfterPreflight(
    owner: { webContentsId: number; revision: number },
    request: DesktopActionRequest,
    options: { dependsOn?: readonly string[]; stillWanted?: () => boolean; provenance?: 'external' }
  ): Promise<CommandControlProposal | null> {
    const checked = await this.runPreflight(request, 'propose')
    if (options.stillWanted && !options.stillWanted()) return null
    if (!checked.ok) {
      this.deps.onNotice?.(checked.notice)
      return null
    }
    return this.propose(owner, request, options)
  }

  private async runPreflight(
    request: DesktopActionRequest,
    stage: CommandPreflightStage
  ): Promise<CommandPreflightResult> {
    if (!this.deps.preflight) return { ok: true }
    try {
      return await this.deps.preflight(request, stage)
    } catch {
      // A broken check never counts as permission. There is no safe specific copy, so the generic one is used.
      return { ok: false, notice: { code: 'check_failed', copy: "Métis can't do this right now." } }
    }
  }

  /** A card is on screen or a confirmed action is still being dispatched. Outside requests never replace it. */
  hasPendingProposal(): boolean {
    return this.current !== null || this.confirming !== null
  }

  getState(): CommandControlState {
    const proposal = this.current
    if (!proposal) return { proposalId: null }
    return {
      proposalId: proposal.proposalId,
      nonce: proposal.nonce,
      argsHash: proposal.argsHash,
      expiresAt: proposal.expiresAt,
      revision: proposal.revision,
      actionId: proposal.display.actionId,
      risk: proposal.display.risk,
      preview: proposal.display.preview,
      ...(proposal.display.appIconKey ? { appIconKey: proposal.display.appIconKey } : {})
    }
  }

  async confirm(
    input: CommandControlProposal & { webContentsId: number; grantScope?: CommandGrantScope }
  ): Promise<
    | { ok: true; outcome: DesktopActionResult['outcome']; grant?: CommandGrantOutcome }
    | { ok: false; reason: CommandControlReason }
  > {
    const proposal = this.validate(input, { argsHash: input.argsHash })
    if ('reason' in proposal) return proposal
    // A confirmation that lands inside the guard window is a held or auto-repeated key, not a decision. It is
    // refused without consuming the proposal, so the person's next deliberate press still works.
    if (this.now() - proposal.shownAt < (this.deps.minConfirmDelayMs ?? 0)) return { ok: false, reason: 'too_soon' }
    // Consume before yielding to the adapter, so a double click or replay cannot execute twice.
    this.clearCurrent()
    this.emit()
    const flight: { interruptedBy: string | null } = { interruptedBy: null }
    this.confirming = flight
    try {
      return await this.dispatchConfirmed(proposal, flight, input)
    } finally {
      if (this.confirming === flight) this.confirming = null
    }
  }

  private async dispatchConfirmed(
    proposal: CurrentProposal,
    flight: { interruptedBy: string | null },
    input: { webContentsId: number; grantScope?: CommandGrantScope }
  ): Promise<
    | { ok: true; outcome: DesktopActionResult['outcome']; grant?: CommandGrantOutcome }
    | { ok: false; reason: CommandControlReason }
  > {
    let allowed = false
    try {
      allowed = isDesktopAdapterId(proposal.request.id) && this.deps.policyAllows(proposal.request) === true
    } catch {
      // A broken or unavailable policy check is a denial, never an implicit allow.
      allowed = false
    }
    if (!allowed) {
      this.audit('command.revoked', { actionId: proposal.request.id, reason: 'policy_denied' })
      await this.release('policy_denied')
      return { ok: false, reason: 'policy_denied' }
    }
    // Permissions and the target app are re-checked here, after Return and before the task is created, so a prompt
    // the person is still reading can never become an uncertain effect and a denial leaves no task behind.
    if (this.deps.preflight) {
      const checked = await this.runPreflight(proposal.request, 'confirm')
      if (!checked.ok) {
        this.audit('command.revoked', { actionId: proposal.request.id, reason: `preflight_${checked.notice.code}` })
        this.deps.onNotice?.(checked.notice)
        await this.release('preflight_failed')
        return { ok: false, reason: 'preflight_failed' }
      }
    }
    // Purchase and permission are decided on their own: an approval is neither a payment nor an OS consent.
    const effects = this.deps.grants ? await this.checkEffects(proposal.request) : null
    if (effects) {
      this.audit('command.revoked', { actionId: proposal.request.id, reason: effects })
      await this.release('policy_denied')
      return { ok: false, reason: effects }
    }
    // The Mac locked, slept or the window went away while the check ran: the person is no longer behind this
    // decision, so nothing is dispatched.
    if (flight.interruptedBy) return this.interrupted(proposal, flight.interruptedBy)
    // Focus goes back to the previous app first: an action that opens an app then takes focus there naturally
    // instead of being pulled back to where the person was.
    if (this.deps.card) await this.release('confirmed')
    if (flight.interruptedBy) return this.interrupted(proposal, flight.interruptedBy)
    const grant = this.issueGrant(input.webContentsId, proposal.request, input.grantScope)
    try {
      const envelope = { argsHash: proposal.argsHash, idempotencyKey: proposal.idempotencyKey }
      const result = await this.deps.execute(proposal.request, {
        proposalId: proposal.proposalId,
        owner: { webContentsId: proposal.ownerWebContentsId, revision: proposal.revision },
        ...envelope,
        dependsOn: proposal.dependsOn
      })
      if (result.id !== proposal.request.id) {
        this.audit('command.confirmed', { actionId: proposal.request.id, outcome: 'failed' })
        return { ok: false, reason: 'adapter_failed' }
      }
      // Observed-receipt rule: `verified` counts only with readback bound to this dispatch. A verified claim
      // without it is not evidence, and the effect may have happened, so it is reported unverified.
      const verified = result.ok && result.outcome === 'verified'
      const observed = verified && isObservedVerified(proposal.request, result, envelope)
      this.audit('command.confirmed', {
        actionId: proposal.request.id,
        outcome: verified && !observed ? 'unknown' : result.outcome
      })
      if (observed) return { ok: true, outcome: 'verified', ...(grant ? { grant } : {}) }
      if (result.outcome === 'unknown' || verified) return { ok: false, reason: 'outcome_unverified' }
      return { ok: false, reason: 'adapter_failed' }
    } catch {
      // The adapter was already invoked: a rejection does not prove the effect did not happen (the app may have
      // launched before the acknowledgement was lost). Report it as unverified, never as a clean failure.
      this.audit('command.confirmed', { actionId: proposal.request.id, outcome: 'unknown' })
      return { ok: false, reason: 'outcome_unverified' }
    }
  }

  async cancel(
    input: CommandControlCancellation & { webContentsId: number }
  ): Promise<{ ok: true } | { ok: false; reason: CommandControlReason }> {
    const proposal = this.validate(input)
    if ('reason' in proposal) return proposal
    this.clearCurrent()
    this.emit()
    this.audit('command.revoked', { actionId: proposal.request.id, reason: 'cancelled' })
    await this.release('cancelled')
    return { ok: true }
  }

  private async interrupted(proposal: CurrentProposal, reason: string): Promise<{ ok: false; reason: 'interrupted' }> {
    this.audit('command.revoked', { actionId: proposal.request.id, reason: `interrupted_${reason}` })
    await this.release(reason)
    return { ok: false, reason: 'interrupted' }
  }

  /** G31: the live grants as the renderer may see them. */
  listGrants(): GrantSummary[] {
    return this.deps.grants?.list() ?? []
  }

  /**
   * Whether a standing grant lets this request skip the confirm card, and if not, which of the three decisions says
   * so. Without a grant service every action asks.
   */
  async grantDecision(
    ownerWebContentsId: number,
    request: DesktopActionRequest,
    source: VoiceTurnSource
  ): Promise<GrantedRunDecision> {
    const grants = this.deps.grants
    if (!grants) return { outcome: 'confirm', refusal: refusalFor('no_grant') }
    return grants.decide(grants.ownerFor(ownerWebContentsId), request, source)
  }

  /** Take the grant for one dispatch. False means it ended since the decision, so nothing may dispatch. */
  useGrant(grantId: string): boolean {
    return this.deps.grants?.use(grantId) ?? false
  }

  revokeGrant(grantId: string): boolean {
    return this.deps.grants?.revokeGrant(grantId) ?? false
  }

  /** A task (G06 lineage root) ended: its grants end with it. */
  endTaskGrants(taskLineageId: string): number {
    return this.deps.grants?.endTask(taskLineageId) ?? 0
  }

  endConversationGrants(conversationId: string): number {
    return this.deps.grants?.endConversation(conversationId) ?? 0
  }

  /** The input session hard-stopped. Stop, shutdown, sign-out and owner replacement end grants; routine ends do not. */
  onInputSessionStop(reason: string): void {
    this.deps.grants?.onHardStop(reason)
  }

  revokeForLifecycleEvent(reason: string): void {
    if (this.confirming && INTERRUPTS_CONFIRM.has(reason)) this.confirming.interruptedBy ??= reason
    // Blur, hide and expiry end the pending card only. Sign-out, a window swap, lock and suspend end standing grants too.
    this.deps.grants?.onLifecycleEvent(reason)
    const proposal = this.current
    if (!proposal) return
    this.clearCurrent()
    this.emit()
    this.audit('command.revoked', { actionId: proposal.request.id, reason })
    void this.release(reason)
  }

  /** A confirmation passes its claimed `argsHash` (even when absent): it must match the hash taken at propose time. */
  private validate(
    input: CommandControlCancellation & { webContentsId: number },
    confirmation?: { argsHash: unknown }
  ): CurrentProposal | { ok: false; reason: CommandControlReason } {
    const proposal = this.current
    if (!proposal) return { ok: false, reason: 'proposal_missing' }
    if (input.webContentsId !== proposal.ownerWebContentsId) return { ok: false, reason: 'owner_mismatch' }
    if (input.proposalId !== proposal.proposalId) return { ok: false, reason: 'proposal_mismatch' }
    if (!secureEqual(input.nonce, proposal.nonce)) return { ok: false, reason: 'nonce_mismatch' }
    if (confirmation && !(isArgsHash(confirmation.argsHash) && secureEqual(confirmation.argsHash, proposal.argsHash))) {
      return { ok: false, reason: 'args_mismatch' }
    }
    if (this.now() >= proposal.expiresAt) {
      this.clearCurrent()
      this.emit()
      this.audit('command.revoked', { actionId: proposal.request.id, reason: 'expired' })
      void this.release('expired')
      return { ok: false, reason: 'expired' }
    }
    return proposal
  }

  private armExpiry(proposal: CurrentProposal): void {
    this.expiryTimer = setTimeout(
      () => {
        if (this.current?.proposalId !== proposal.proposalId) return
        this.revokeForLifecycleEvent('expired')
      },
      Math.max(0, proposal.expiresAt - this.now())
    )
  }

  /** Tells the card's window life why it ended. A failing hook never changes the outcome of the decision. */
  private async release(reason: string): Promise<void> {
    try {
      await this.deps.card?.release(reason)
    } catch {
      // Restoring focus is best effort.
    }
  }

  private clearCurrent(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    this.current = null
  }

  private emit(): void {
    this.deps.onState?.(this.getState())
  }

  private async checkEffects(request: DesktopActionRequest): Promise<'purchase_denied' | 'permission_denied' | null> {
    try {
      const refusal = await this.deps.grants?.checkEffects(request)
      if (!refusal) return null
      return refusal.decision === 'purchase' ? 'purchase_denied' : 'permission_denied'
    } catch {
      // The decision seams never throw by contract; a broken one must not turn an explicit approval into a silent run.
      return 'permission_denied'
    }
  }

  private issueGrant(
    webContentsId: number,
    request: DesktopActionRequest,
    scope: CommandGrantScope | undefined
  ): CommandGrantOutcome | null {
    const grants = this.deps.grants
    if (!scope || !grants) return null
    const issued = grants.issueFromApproval(grants.ownerFor(webContentsId), request, scope)
    return issued.ok ? { ok: true, scope: issued.grant.binding.kind } : { ok: false, reason: issued.reason }
  }

  private audit(event: CommandAuditEvent, metadata: Record<string, string>): void {
    this.deps.audit?.(event, metadata)
  }
}
