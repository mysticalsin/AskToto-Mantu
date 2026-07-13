import { modelPaths as resolveLocalModelPaths, verifyIntegrity } from './local-models'
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
 * Ensure the sidecar is running against `modelId`. Extracted out of streamLocal so index.ts's local:prewarm
 * handler (PLAN.md §4.4's pre-warm path, Rock 5) can reach the EXACT same start logic without duplicating
 * it — both callers must resolve the same manifest paths and go through the same local-runtime.ts start()
 * call. Always delegates the running/starting/switch decision to start() itself (F2 hardening: start() is
 * idempotent per-model — a no-op when this exact model is already running, an in-flight-await when a start
 * is already underway, and a stop-then-restart when a DIFFERENT model is requested — so early-returning on
 * isRunning() here was both redundant and the thing that let a model switch never actually happen).
 * Re-verifies the model files' sha256 against the manifest (F5 hardening) before starting whenever the
 * requested GGUF isn't the one already active: either a COLD start (state 'stopped') or a model SWITCH
 * requested while the runtime is already running/starting (G2 hardening — getState() alone can't see a
 * switch, since it stays 'running'/'starting' throughout; getActiveModelKey() is what catches the new,
 * not-yet-verified GGUF). A warm request for the SAME model that's already active/starting skips the
 * re-hash — never on every live-meeting request against an unchanged model. A mismatch throws and start()
 * is never reached, so a corrupt file never reaches llama-server.
 */
export async function ensureLocalRuntimeStarted(modelId: string): Promise<void> {
  const paths = resolveLocalModelPaths(modelId)
  if (localRuntime.getState() === 'stopped' || localRuntime.getActiveModelKey() !== paths.gguf) {
    await verifyIntegrity(modelId)
  }
  await localRuntime.start({ gguf: paths.gguf, mmproj: paths.mmproj })
}

export function streamLocal(opts: StreamOptions): StreamHandle {
  let aborted = false
  let inner: StreamHandle | null = null
  // Guards localRuntime.beginStream()/endStream() pairing (switch-kill hardening): true from the instant
  // streamOpenAI() is invoked (the sidecar is now actively serving this request) until exactly one of
  // onDone/onError/abort releases it. While any stream holds this, local-runtime.ts's start() will defer
  // rather than SIGKILL the sidecar out from under it on a model switch.
  let streamActive = false
  const releaseStream = (): void => {
    if (!streamActive) return
    streamActive = false
    localRuntime.endStream()
  }

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
      streamActive = true
      localRuntime.beginStream()
      inner = streamOpenAI({
        ...opts,
        baseURL: localRuntime.baseURL(),
        apiKey: localRuntime.sessionKey(),
        llamaSlotOptions,
        // Re-arm the 15-minute idle-stop countdown when this response finishes (success or error), not
        // just when it starts (markActivity() above) — a long-running stream would otherwise let the
        // idle timer, armed only at start, fire mid-stream on an unrelated schedule.
        handlers: {
          ...opts.handlers,
          onDone: (u) => {
            releaseStream()
            localRuntime.markActivity()
            opts.handlers.onDone(u)
          },
          onError: (message) => {
            releaseStream()
            localRuntime.markActivity()
            opts.handlers.onError(message)
          }
        }
      })
    } catch (err) {
      releaseStream()
      if (!aborted) opts.handlers.onError(errMsg(err))
    }
  })()

  return {
    abort: () => {
      aborted = true
      inner?.abort()
      // openai.ts's onError is suppressed once controller.signal.aborted is true, so it will never call
      // releaseStream() for us on this path — release here so a Cancel/superseded-ask abort doesn't leave
      // the sidecar permanently marked busy and block every future model switch.
      releaseStream()
      // Accepted behavior (audit risk, by design): if the sidecar is still starting when this fires, the
      // in-flight ensureLocalRuntimeStarted()/start() call is NOT cancelled — it runs to completion and the
      // sidecar stays up, reclaimed later by the normal 15-minute idle-stop rather than torn down here.
      // Cancelling a mid-spawn llama-server process isn't worth the complexity for what's already a rare,
      // best-effort UX cancel (Cancel button / a new ask superseding this one).
    }
  }
}
