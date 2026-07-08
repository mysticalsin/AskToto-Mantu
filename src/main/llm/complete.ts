import type { Settings, AskStart } from '@shared/ipc'
import { PROVIDERS, resolveModelTier, type ProviderId } from '@shared/providers'
import { getApiKey } from '../store'
import { createStream } from '../llm'

/**
 * Main-side, background LLM completion against the user's configured provider — the non-streaming
 * counterpart to the renderer's live ask flow. Shared by brain ingest (structured extraction) and
 * import-audio (post-transcription recap), so the provider-resolution rule lives in exactly one place.
 * "Non-streaming" = it accumulates the provider's delta stream into a single string and resolves once.
 */

/** Pick the first usable text provider: the active one, then any other with credentials + a resolvable
 *  model. Returns null when nothing can answer (so callers bail before burning a job on a guaranteed reject). */
export function pickProvider(s: Settings): { provider: ProviderId; model: string; key: string } | null {
  const order = [s.provider, ...(Object.keys(PROVIDERS) as ProviderId[])]
  for (const p of order) {
    const def = PROVIDERS[p]
    if (!def) continue
    const key = getApiKey(p)
    const connected = def.kind === 'cli' ? !!s.cliConnected[p] : key.length > 0
    if (!connected) continue
    if (p === 'dust' && !s.dustWorkspaceId) continue
    const model = resolveModelTier(p, s.providerModels, s.providerModelsThinking, 'deep', s.providerModelsDeep)
    if (!model) continue
    return { provider: p, model, key }
  }
  return null
}

/** Cheap "is any provider usable at all" check — reuses pickProvider so the two can never drift. */
export function hasUsableProvider(s: Settings): boolean {
  return pickProvider(s) !== null
}

/** Run one accumulate-the-stream completion against the picked provider. Rejects on stream error or when
 *  no provider is configured. `mode` defaults to 'answer' (brain ingest's extraction jobs); pass 'recap'
 *  so the provider adapters (openai.ts/anthropic.ts) grant the larger 8192-token recap headroom instead
 *  of the standard 4096 answer budget. */
export function runCompletion(
  s: Settings,
  system: string,
  userText: string,
  id: string,
  mode: AskStart['mode'] = 'answer'
): Promise<string> {
  const picked = pickProvider(s)
  if (!picked) return Promise.reject(new Error('No configured AI provider.'))
  const { provider, model, key } = picked
  const def = PROVIDERS[provider]
  // baseUserText (shared.ts) reads a recap/summary transcript from req.transcript, while every other mode
  // reads req.prompt — so route the caller's text into the field the chosen mode actually consumes.
  // Otherwise a 'recap' completion would ship an EMPTY transcript to the model (wide 8192 budget, no input).
  const transcriptMode = mode === 'recap' || mode === 'summary'
  const req: AskStart = {
    id,
    mode,
    prompt: transcriptMode ? '' : userText,
    transcript: transcriptMode ? userText : undefined,
    history: []
  } as AskStart
  return new Promise<string>((resolve, reject) => {
    let out = ''
    createStream({
      providerId: provider,
      kind: def.kind,
      apiKey: key,
      baseURL: provider === 'custom' ? s.customBaseUrl : provider === 'dust' ? s.dustBaseUrl : def.baseUrl,
      workspaceId: s.dustWorkspaceId,
      model,
      temperature: 0, // background jobs want determinism, not creativity
      idleMs: 120_000,
      freshConversation: true, // Dust: never join/replace the live meeting's cached conversation
      system,
      req,
      handlers: {
        onDelta: (t) => {
          out += t
        },
        onDone: () => resolve(out),
        onError: (m) => reject(new Error(m))
      }
    })
  })
}
