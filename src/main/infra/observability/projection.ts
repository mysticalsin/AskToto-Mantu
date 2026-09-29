import type { RenderProcessGoneDetails } from 'electron'
import type { AuditEvent } from '../../logger'
import { OVERLAY_LAYOUTS } from '@shared/overlay-chrome'
import { RENDERER_VIEWS } from '@shared/renderer-view'
import { redactSecrets } from '@shared/redact'
import { CRASH_KINDS, RECOVERY_STATUSES } from './crash-taxonomy'

/**
 * INV-PROJECTED: observability events pass through an event-specific allowlist.
 * INV-CONTENT-FREE: values are kind-checked, and error text is scrubbed before persistence.
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
  | 'bundleName'
  | 'errorText'
  | readonly string[]
export type EventFields = Readonly<Record<string, FieldKind>>

export const MAX_MESSAGE_CHARS = 300
export const REVEAL_REASONS = ['activate', 'second-instance', 'tray', 'hotkey', 'notification-click', 'ensure-window'] as const
export const REVEAL_OUTCOMES = ['created', 'shown', 'already-visible', 'failed'] as const
export const SIDECAR_NAMES = ['llama-server', 'fm-serve', 'stall-watch'] as const
export const SIDECAR_UNSUPERVISED_REASONS = [
  'wrapper-missing',
  'wrapper-spawn-failed',
  'wrapper-setup-failed'
] as const
export const SIDECAR_REAP_REASONS = ['registry', 'legacy-orphan'] as const
export const SIDECAR_REAP_SKIP_REASONS = [
  'corrupt-registry',
  'incomplete-entry',
  'pid-not-alive',
  'start-time-mismatch',
  'exe-mismatch',
  'args-mismatch',
  'pid-mismatch',
  'process-info-failed',
  'kill-failed',
  'ambiguous-entry'
] as const
export const HISTORY_STAGES = ['received', 'served', 'settled'] as const
export const HISTORY_OUTCOMES = ['ok', 'failed', 'discarded'] as const
const RENDER_GONE_REASONS = [
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
  /** Handled boot-step failure; boot continued without that step's work. */
  'app.error.boot_step': {
    step: 'token',
    message: 'errorText',
    recoveryStatus: RECOVERY_STATUSES
  },
  /** Handled window-create failure; the next reveal retries creation. */
  'app.error.window_create': {
    message: 'errorText',
    recoveryStatus: RECOVERY_STATUSES
  },
  /** Safe-start path after repeated early deaths. */
  'app.error.early_death': {
    consecutive: 'int',
    recoveryStatus: RECOVERY_STATUSES
  },
  /** Automatic reload after render-process-gone failed to load and no further automatic retry will run. */
  'app.error.reload_failed': {
    message: 'errorText',
    recoveryStatus: RECOVERY_STATUSES
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
  /** Out-of-process sampler captures a content-free stall bundle. */
  'app.stall.sampled': {
    bootId: 'id',
    stalledMs: 'ms',
    bundle: 'bundleName'
  },
  /** Out-of-process sampler reports a sampling, bundling, or watcher failure. */
  'app.stall.sample_failed': {
    bootId: 'id',
    reason: ['sample', 'bundle', 'watcher']
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
  },
  /** render-process-gone's automatic reload loop was halted after the budget was exhausted. */
  'app.render_loop_halted': {
    reason: RENDER_GONE_REASONS,
    exitCode: 'int'
  },
  /** User-visible reveal attempt and outcome. */
  reveal: {
    reason: REVEAL_REASONS,
    isVisible: 'flag',
    parked: 'flag',
    layout: OVERLAY_LAYOUTS,
    outcome: REVEAL_OUTCOMES,
    ms: 'ms'
  },
  /** Long-lived local sidecar spawned. */
  'sidecar.spawn': {
    name: SIDECAR_NAMES,
    pid: 'int',
    pgid: 'int'
  },
  /** Long-lived local sidecar exited. */
  'sidecar.exit': {
    name: SIDECAR_NAMES,
    pid: 'int',
    pgid: 'int',
    code: 'int',
    signal: 'token',
    uptimeMs: 'ms'
  },
  /** Supervision requested but wrapper launch was not available; direct spawn remains the safety net. */
  'sidecar.unsupervised': {
    name: SIDECAR_NAMES,
    reason: SIDECAR_UNSUPERVISED_REASONS,
    error: 'errorText'
  },
  /** Boot reaper killed a process whose identity matched a safe ownership rule. */
  'sidecar.reaped': {
    name: SIDECAR_NAMES,
    pid: 'int',
    reason: SIDECAR_REAP_REASONS
  },
  /** Boot reaper found a stale, corrupt, ambiguous, or non-owned entry and left it alive. */
  'sidecar.reap.skipped': {
    name: SIDECAR_NAMES,
    pid: 'int',
    reason: SIDECAR_REAP_SKIP_REASONS,
    error: 'errorText'
  },
  /** History list request timing across renderer and main. */
  'history.request': {
    requestId: 'id',
    stage: HISTORY_STAGES,
    outcome: HISTORY_OUTCOMES,
    queueMs: 'ms',
    mainMs: 'ms',
    ipcMs: 'ms',
    renderMs: 'ms',
    resultCount: 'int'
  }
} as const satisfies { readonly [E in ObservabilityEvent]: EventFields }

type FieldValue<K> = K extends readonly (infer V)[] ? V : unknown
export type ObservabilityDetail<E extends ObservabilityEvent> = {
  readonly [F in keyof (typeof OBSERVABILITY_EVENTS)[E]]?: FieldValue<(typeof OBSERVABILITY_EVENTS)[E][F]> | null
}

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, 'i')
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?$/
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const STALL_BUNDLE_NAME_RE = new RegExp(`^${UUID_PATTERN}\\.\\d{1,15}\\.\\d{1,15}\\.txt$`, 'i')
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]*/gi
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
const QUOTED_RE = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’/g
const PATH_RE = /(?:\b[A-Za-z]:[\\/]|\\\\|~[\\/]|(?<![\w.])\/)[^'"`\n,;()<>]*/g
const ERROR_WORD_RE = /[A-Za-z][A-Za-z0-9_-]*/g
const SAFE_ERROR_WORDS = new Set([
  'aborted',
  'after',
  'before',
  'bigint',
  'cannot',
  'content',
  'crash',
  'directory',
  'email',
  'enoent',
  'eperm',
  'error',
  'failed',
  'fetch',
  'file',
  'function',
  'in',
  'json',
  'key',
  'no',
  'not',
  'notify',
  'object',
  'open',
  'operation',
  'or',
  'permitted',
  'present',
  'path',
  'render',
  'redacted',
  'renderer',
  'spawn',
  'such',
  'symbol',
  'syntaxerror',
  'token',
  'text',
  'typeerror',
  'unexpected',
  'unknown',
  'unserializable',
  'url',
  'was'
])

export function isObservabilityEvent(event: AuditEvent): event is ObservabilityEvent {
  return Object.hasOwn(OBSERVABILITY_EVENTS, event)
}

export function projectEvent(
  event: ObservabilityEvent,
  detail: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const fields = OBSERVABILITY_EVENTS[event]
  const projected: Record<string, unknown> = {}
  for (const [field, kind] of Object.entries(fields)) {
    const value = detail[field]
    if (value === undefined) continue
    if (value === null) {
      projected[field] = null
      continue
    }
    const admitted = projectValue(kind, value)
    if (admitted !== undefined) projected[field] = admitted
  }
  return projected
}

function projectValue(kind: FieldKind, value: unknown): unknown {
  if (Array.isArray(kind)) return typeof value === 'string' && kind.includes(value) ? value : undefined
  switch (kind) {
    case 'flag':
      return typeof value === 'boolean' ? value : undefined
    case 'int':
      return Number.isSafeInteger(value) ? value : undefined
    case 'num':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    case 'ms':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
    case 'id':
      return typeof value === 'string' && UUID_RE.test(value) ? value : undefined
    case 'version':
      return typeof value === 'string' && VERSION_RE.test(value) ? value : undefined
    case 'isoTime':
      return typeof value === 'string' && ISO_TIME_RE.test(value) ? value : undefined
    case 'token':
      return typeof value === 'string' && TOKEN_RE.test(value) ? value : undefined
    case 'bundleName':
      return typeof value === 'string' && STALL_BUNDLE_NAME_RE.test(value) ? value : undefined
    case 'errorText':
      return scrubErrorText(value)
  }
}

function scrubErrorText(value: unknown): string {
  const normalized = value instanceof Error ? `${value.name}: ${value.message}` : typeof value === 'string' ? value : stringifyErrorText(value)
  const scrubbed = redactSecrets(normalized)
    .replace(URL_RE, '<url>')
    .replace(EMAIL_RE, '<email>')
    .replace(QUOTED_RE, '<text>')
    .replace(PATH_RE, '<path>')
    .replace(ERROR_WORD_RE, (word) =>
      SAFE_ERROR_WORDS.has(word.toLowerCase()) || word.length > MAX_MESSAGE_CHARS ? word : '<text>'
    )
    .replace(/(?:<text>\s*){2,}/g, '<text> ')
    .replace(/\s+/g, ' ')
    .trim()
  return scrubbed.length > MAX_MESSAGE_CHARS ? `${scrubbed.slice(0, MAX_MESSAGE_CHARS - 1)}…` : scrubbed
}

function stringifyErrorText(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : `<unserializable ${typeof value}>`
  } catch {
    return `<unserializable ${typeof value}>`
  }
}
