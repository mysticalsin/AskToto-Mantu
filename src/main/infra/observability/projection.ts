import type { RenderProcessGoneDetails } from 'electron'
import type { AuditEvent } from '../../logger'
import { OVERLAY_LAYOUTS } from '@shared/overlay-chrome'
import { RENDERER_VIEWS } from '@shared/renderer-view'
import { CRASH_KINDS, RECOVERY_STATUSES } from './crash-taxonomy'

/**
 * INV-PROJECTED: observability events pass through an event-specific allowlist.
 * INV-CONTENT-FREE: values are kind-checked, and error text is scrubbed before persistence.
 * Residual: this commit declares contracts only; runtime projection logic lands in the next commit.
 */
export type ObservabilityEvent = Extract<AuditEvent, `app.${string}` | `sidecar.${string}` | `history.${string}` | 'reveal'>
export type FieldKind =
  | 'flag'
  | 'int'
  | 'num'
  | 'ms'
  | 'id'
  | 'version'
  | 'isoTime'
  | 'token'
  | 'errorText'
  | readonly string[]
export type EventFields = Readonly<Record<string, FieldKind>>

export const MAX_MESSAGE_CHARS = 300
export const REVEAL_REASONS = ['activate', 'second-instance', 'ensure-window'] as const
export const REVEAL_OUTCOMES = ['created', 'shown', 'already-visible', 'failed'] as const
export const SIDECAR_NAMES = ['llama-server', 'fm-serve'] as const
export const HISTORY_STAGES = ['received', 'served', 'settled'] as const
export const HISTORY_OUTCOMES = ['ok', 'failed', 'discarded'] as const
export const RENDER_GONE_REASONS = [
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction'
] as const satisfies readonly RenderProcessGoneDetails['reason'][]

export const OBSERVABILITY_EVENTS = {
  /** Boot identity and previous clean-shutdown classification. */
  'app.started': {
    version: 'version',
    platform: 'token',
    arch: 'token',
    bootId: 'id',
    prevBootId: 'id',
    prevShutdown: ['clean', 'unclean', 'unknown'],
    prevLastAliveAt: 'isoTime',
    uvThreadpoolSize: 'token'
  },
  /** Renderer sent its ready handshake. */
  'app.renderer.ready': {
    version: 'version',
    platform: 'token',
    arch: 'token'
  },
  /** Live Act1 DOM probe summary. */
  'app.act1.dom': {
    exclusiveOnboarding: 'flag',
    hasOnboardStage: 'flag',
    portalOpen: 'flag',
    hasHeroWordmark: 'flag',
    hasNextButton: 'flag',
    loadingCaption: 'flag',
    agentStatusCaption: 'flag',
    portalContentOpacity: 'token',
    wordmarkOpacity: 'token',
    nextOpacity: 'token',
    nextPointerEvents: 'token',
    prefersReducedMotion: 'flag',
    hasHeroVideo: 'flag',
    videoReadyState: 'int',
    videoNetworkState: 'int',
    videoCurrentTime: 'num',
    videoPaused: 'flag',
    rootChildCount: 'int'
  },
  /** Main or renderer crash classification. */
  'app.crash': {
    kind: CRASH_KINDS,
    fatal: 'flag',
    message: 'errorText',
    reason: RENDER_GONE_REASONS,
    exitCode: 'int',
    view: RENDERER_VIEWS,
    listening: 'flag'
  },
  /** Clean-shutdown marker written at will-quit. */
  'app.shutdown.clean': {
    bootId: 'id',
    uptimeS: 'num',
    reason: ['will-quit']
  },
  /** Main-thread stall sample. */
  'app.stall': {
    bootId: 'id',
    durationMs: 'ms',
    phase: 'token',
    phaseMs: 'ms'
  },
  /** Periodic main-thread stall p99 summary. */
  'app.stall.summary': {
    bootId: 'id',
    p99Ms: 'ms'
  },
  /** Overlay renderer became responsive again after a wedge. */
  'app.responsive': {
    kind: ['overlay'],
    stallMs: 'ms'
  },
  /** Main-process repair completed a renderer handoff. */
  'app.recovery': {
    kind: ['onboarding-replay-replacement-failed', 'onboarding-completion-handoff']
  },
  /** Boot watch cleared after brain resume or error. */
  'app.boot.watch_cleared': {
    earlyDeath: 'flag',
    reason: 'token'
  },
  /** Overlay renderer stopped answering Chromium. */
  'app.unresponsive': {
    kind: ['overlay']
  }
} as const satisfies { readonly [E in ObservabilityEvent]: EventFields }

type FieldValue<K> = K extends readonly (infer V)[] ? V : unknown
export type ObservabilityDetail<E extends ObservabilityEvent> = {
  readonly [F in keyof (typeof OBSERVABILITY_EVENTS)[E]]?: FieldValue<(typeof OBSERVABILITY_EVENTS)[E][F]> | null
}

export function isObservabilityEvent(_event: AuditEvent): _event is ObservabilityEvent {
  // Scaffolding: the real event membership check lands in the next commit (M2-0215).
  throw new Error('M2-0215: not implemented until the next commit')
}

export function projectEvent(
  _event: ObservabilityEvent,
  _detail: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  // Scaffolding: the real scrub/allowlist logic lands in the next commit (M2-0215).
  throw new Error('M2-0215: not implemented until the next commit')
}
