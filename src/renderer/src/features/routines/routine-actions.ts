/**
 * The side-effect paths of the routines UI (G69), kept apart from the components so each confirmation rule is testable
 * without a DOM. The renderer passes only ids and the preview hash; main derives every scope.
 */
import type { CompileResult, ConsentResult, MutationResult, RoutineView } from '@shared/routines'
import type { ConfirmFn } from '../../ui/confirm-context'

export type RoutinesApi = Window['toto']['routines']
export type CompiledPreview = Extract<CompileResult, { ok: true }>

export const isPreviewExpired = (compiled: Pick<CompiledPreview, 'expiresAt'>, now: number): boolean =>
  now >= compiled.expiresAt

/** Consent echoes the proposal id and preview hash exactly as main issued them. An expired preview is not sent. */
export async function createFromPreview(
  api: RoutinesApi,
  compiled: CompiledPreview,
  now: number
): Promise<ConsentResult> {
  if (isPreviewExpired(compiled, now)) return { ok: false, reason: 'expired' }
  return api.consent(compiled.proposalId, compiled.previewHash)
}

/**
 * Resume. When main says an interrupted run needs checking, the owner confirms they checked it before the resume is
 * sent again with `reconciled`. Returns null when the owner declines.
 */
export async function resumeWithReconcile(
  api: RoutinesApi,
  confirm: ConfirmFn,
  view: Pick<RoutineView, 'routineId' | 'title'>
): Promise<MutationResult | null> {
  const first = await api.resume(view.routineId)
  if (first.ok || first.reason !== 'reconciliation_required') return first
  const checked = await confirm({
    title: 'Resume',
    message: `A run of "${view.title}" was interrupted and its result is unclear. Check what it did, then resume.`,
    confirmLabel: 'I checked, resume'
  })
  return checked ? api.resume(view.routineId, true) : null
}

export async function deleteWithConfirm(
  api: RoutinesApi,
  confirm: ConfirmFn,
  view: Pick<RoutineView, 'routineId' | 'title'>
): Promise<MutationResult | null> {
  const yes = await confirm({
    title: 'Delete',
    message: `Delete "${view.title}"? It will not run again.`,
    confirmLabel: 'Delete',
    destructive: true
  })
  return yes ? api.remove(view.routineId) : null
}

/** A scheduled task can act on the owner's behalf, so running it now is confirmed. Reminders and read-only checks are not. */
export async function runNowWithConfirm(
  api: RoutinesApi,
  confirm: ConfirmFn,
  view: Pick<RoutineView, 'routineId' | 'title' | 'purpose'>
): Promise<MutationResult | null> {
  if (view.purpose === 'scheduled_task') {
    const yes = await confirm({
      title: 'Run now',
      message: `Run "${view.title}" now? It does the task it was set up for.`,
      confirmLabel: 'Run now'
    })
    if (!yes) return null
  }
  return api.runNow(view.routineId)
}
