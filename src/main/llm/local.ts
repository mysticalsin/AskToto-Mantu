import { modelPaths as resolveLocalModelPaths } from './local-models'
import * as localRuntime from './local-runtime'
import { streamOpenAI } from './openai'
import { type StreamOptions, type StreamHandle, errMsg } from './shared'

/**
 * Métis Local provider strategy (PLAN.md §4.2/§4.3) — a thin shim over streamOpenAI: the llama-server
 * sidecar speaks the same OpenAI-compatible /v1/chat/completions surface openai.ts already talks to, so
 * this module's only job is (1) making sure the sidecar is running against the configured model, (2)
 * injecting the per-session sidecar key instead of a stored API key, and (3) pinning the llama-server slot
 * for the request's mode so per-slot prompt caching (cache_prompt) actually reuses the transcript prefix.
 * `opts.model` is the configured local-models.ts manifest id — index.ts resolves it from
 * settings.localLlm.modelId (not the generic per-provider model picker), see local-routing.ts.
 *
 * Async start must not block returning a handle: attempt() in index.ts stores the returned StreamHandle
 * synchronously before any await here runs, so a synchronous throw would never be catchable by it — errors
 * are reported via handlers.onError instead, exactly like openai.ts's own async-body pattern (its `custom`
 * baseURL guard fires onError via queueMicrotask for the same reason).
 */

/**
 * Ensure the sidecar is running against `modelId` (a no-op if already running/starting). Extracted out of
 * streamLocal so index.ts's local:prewarm handler (PLAN.md §4.4's pre-warm path, Rock 5) can reach the
 * EXACT same start logic without duplicating it — both callers must resolve the same manifest paths and
 * go through the same local-runtime.ts start() call.
 */
export async function ensureLocalRuntimeStarted(modelId: string): Promise<void> {
  if (localRuntime.isRunning()) return
  const paths = resolveLocalModelPaths(modelId)
  await localRuntime.start({ gguf: paths.gguf, mmproj: paths.mmproj })
}

export function streamLocal(opts: StreamOptions): StreamHandle {
  let aborted = false
  let inner: StreamHandle | null = null

  void (async () => {
    try {
      await ensureLocalRuntimeStarted(opts.model)
      if (aborted) return // caller aborted while the sidecar was still starting — never start a stream
      localRuntime.markActivity()
      // Suggest and summary pin the SAME slots the pre-warm path (Rock 5) targets, so cache_prompt
      // actually hits on the real request. Vision (and any other in-scope mode) still asks for
      // cache_prompt without pinning a slot — a screenshot turn has no reusable transcript prefix.
      const llamaSlotOptions =
        opts.req.mode === 'suggest'
          ? { id_slot: 0, cache_prompt: true }
          : opts.req.mode === 'summary'
            ? { id_slot: 1, cache_prompt: true }
            : { cache_prompt: true }
      inner = streamOpenAI({
        ...opts,
        baseURL: localRuntime.baseURL(),
        apiKey: localRuntime.sessionKey(),
        llamaSlotOptions
      })
    } catch (err) {
      if (!aborted) opts.handlers.onError(errMsg(err))
    }
  })()

  return {
    abort: () => {
      aborted = true
      inner?.abort()
    }
  }
}
