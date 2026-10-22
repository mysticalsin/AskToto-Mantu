import { desktopActionLabel } from './command-preview'
import type { MetisCommandPreview } from './metis-command-contract'

export type CommandConfirmResult = { ok: true } | { ok: false; reason?: string }

const lowerFirst = (text: string): string => (text ? text[0].toLowerCase() + text.slice(1) : text)

/**
 * The sentence shown after the person decides. Sentence case, specific, never "Error". Null means another surface
 * already said it (a preflight notice) or the press was ignored (too early), so nothing more is shown.
 */
export function commandResultCopy(result: CommandConfirmResult, preview: MetisCommandPreview): string | null {
  if (result.ok) return 'Done.'
  const what = lowerFirst(preview.title)
  switch (result.reason) {
    case 'outcome_unverified': {
      const quoted = preview.argument ? ` (“${preview.argument}”)` : ''
      return `Métis tried to ${what}${quoted} but couldn't confirm it worked. Check before trying again.`
    }
    case 'policy_denied':
      return "Métis can't do this right now."
    case 'expired':
    case 'proposal_missing':
      return 'Timed out. Nothing was done.'
    case 'adapter_failed':
      return `Couldn't ${what}.`
    case 'preflight_failed':
    case 'too_soon':
      return null
    default:
      return 'That action is no longer available. Nothing was done.'
  }
}

/** One boot-recovery entry. The action id comes from the task and its arguments are never shown (privacy). */
export function recoveredUncertainCopy(actionId: string): string {
  const label = desktopActionLabel(actionId)
  return label
    ? `A voice action may not have finished: ${label}. Métis won't retry it.`
    : "A voice action may not have finished. Métis won't retry it."
}
