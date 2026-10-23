/**
 * Entering the foreground for one desktop task (G40): the part of the task bridge that decides whether an adapter
 * needs it, asks the focus-request step, and hands back the Escape hold. Split out so the bridge stays small.
 */
import { adapterNeedsForeground } from '@shared/voice/adapter-capabilities'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import type { CommandExecutionContext } from '../command-control'
import type { ForegroundHold } from './escape-release'
import type { FocusRequestStep } from './focus-request'

export type ForegroundEntry =
  | { ok: true; hold: ForegroundHold | null }
  | { ok: false; reason: string; stopped: boolean }

/** A background adapter passes straight through. Without a focus step a foreground-only adapter is refused. */
export async function enterForeground(
  deps: { focus?: FocusRequestStep; platform?: NodeJS.Platform },
  request: DesktopActionRequest,
  context: CommandExecutionContext,
  signal: AbortSignal,
  stop: () => void
): Promise<ForegroundEntry> {
  if (!adapterNeedsForeground(request.id, deps.platform ?? process.platform)) return { ok: true, hold: null }
  if (!deps.focus) return { ok: false, reason: 'focus_unavailable', stopped: false }
  const step = await deps.focus.run(request, { viaGrant: context.viaGrant === true, signal, stop })
  if (step.ok) return { ok: true, hold: step.hold }
  return { ok: false, reason: step.reason, stopped: step.reason === 'focus_stopped' }
}
