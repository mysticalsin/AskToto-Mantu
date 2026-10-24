import type { AskStart } from '@shared/ipc'
import type { AskRequest } from './ask-types'

/**
 * The ask:start payload for one run. `outputIntent` marks an unsolicited (ambient) ask so main's quiet gate can
 * hold it; a missing value is a direct owner request, which is never suppressed.
 */
export function buildAskStart(id: string, req: AskRequest): AskStart {
  return {
    id,
    mode: req.mode,
    outputIntent: req.outputIntent ?? 'direct',
    prompt: req.prompt ?? '',
    inputOrigin: req.inputOrigin,
    image: req.image,
    transcript: req.transcript,
    context: req.context,
    depth: req.depth,
    kind: req.kind,
    redactPrompt: req.redactPrompt,
    agentOverride: req.agentOverride,
    providerOverride: req.providerOverride,
    wantsScreenContext: req.wantsScreenContext,
    history: req.history ?? []
  }
}
