import type { AskMode } from '@shared/ipc'
import { mainLog } from '../logger'
import { modelPaths as resolveLocalModelPaths, verifyIntegrity } from './local-models'
import * as localRuntime from './local-runtime'
import * as fmRuntime from './fm-runtime'
import { streamOpenAI } from './openai'
import { type StreamOptions, type StreamHandle, errMsg } from './shared'

// Local completions are task-shaped, not generic 4k-token chat turns. These bounds preserve the current
// spoken-suggestion (~15–40 seconds), tight-summary, and screen-help contracts. Character ceilings are
// defensive input limits, not token-fit guarantees; the engine enforces its actual context size. Cloud
// providers keep their established budgets because only this strategy sets StreamOptions.maxOutputTokens.
export const LOCAL_OUTPUT_TOKEN_BUDGETS = Object.freeze({ suggest: 96, summary: 512, vision: 384 })
const LOCAL_SYSTEM_CHAR_CAP = 40_000 // matches personas.ts contextBlock's existing imported-context cap
const LOCAL_SUMMARY_TRANSCRIPT_CHAR_CAP = 80_000

function boundedLocalSystem(system: string): string {
  if (system.length <= LOCAL_SYSTEM_CHAR_CAP) return system
  const marker = '\n\n[Local system context truncated to fit the on-device model.]\n\n'
  const contentBudget = LOCAL_SYSTEM_CHAR_CAP - marker.length
  const head = Math.ceil(contentBudget / 2)
  return system.slice(0, head) + marker + system.slice(-(contentBudget - head))
}

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
export async function ensureLocalRuntimeStarted(modelId: string, vision = false): Promise<void> {
  const paths = resolveLocalModelPaths(modelId)
  if (localRuntime.getState() === 'stopped' || localRuntime.getActiveModelKey() !== paths.gguf) {
    await verifyIntegrity(modelId)
  }
  // MQA-270 (B1): the multimodal projector loads at server START, never lazily, and costs 1.03 GB
  // whether or not vision is ever used — so text-only starts spawn with --no-mmproj. A vision request
  // against a text-only runtime fails samePaths (vision is one-way sticky there) and takes start()'s
  // existing switch path, which drains in-flight streams before the restart. Callers pass true only
  // when the request actually carries an image.
  await localRuntime.start({
      gguf: paths.gguf,
      mmproj: paths.mmproj,
      vision,
      ctxSize: paths.ctxSize,
      parallel: paths.parallel,
      gpuLayers: paths.gpuLayers
    })
}

export type LocalEngine = 'llama' | 'apple'

/**
 * Which engine serves THIS local request. The Apple Foundation Models engine (fm-runtime.ts, macOS 27+)
 * takes text modes (suggest/summary) whenever Apple Intelligence is live on the machine — better model
 * than the bundled Qwen, zero extra RAM, no weights to load. Vision stays on llama-server's mmproj until
 * `fm serve` image input is verified end-to-end (fm respond documents --image; the serve surface is
 * unproven — flip vision over only behind that proof). Every "no" answer — wrong platform, no binary,
 * Apple Intelligence off, crash budget exhausted, METIS_DISABLE_APPLE_FM=1 — lands on 'llama', so
 * Windows and macOS 26 behavior is byte-identical to before this engine existed.
 */
export async function pickLocalEngine(mode: AskMode): Promise<LocalEngine> {
  if (mode === 'vision') return 'llama'
  if (fmRuntime.disabledByEnv() || !fmRuntime.supported()) return 'llama'
  if (fmRuntime.getState() === 'unavailable') return 'llama'
  const availability = await fmRuntime.probeAvailability()
  return availability.available ? 'apple' : 'llama'
}

/**
 * Engine-aware prewarm used by index.ts's local:prewarm handler. Apple engine: model residency is
 * OS-managed, so the win is just having `fm serve` up + the model mapped before the first real suggest —
 * no per-slot KV pinning exists to warm. Llama engine: the original path, verbatim (markActivity before
 * ensure, then the slot-0 cache_prompt prefill).
 */
export async function prewarmLocal(
  modelId: string,
  messages: Array<{ role: string; content: string }>
): Promise<void> {
  if ((await pickLocalEngine('suggest')) === 'apple') {
    await fmRuntime.start()
    fmRuntime.markActivity()
    fmRuntime.prewarm(messages)
    return
  }
  localRuntime.markActivity()
  await ensureLocalRuntimeStarted(modelId)
  localRuntime.prewarm(messages)
}

export function streamLocal(opts: StreamOptions): StreamHandle {
  let aborted = false
  // MQA-322: a tail-only recap loses earlier decisions and owners. Reject before any engine work,
  // leaving the full source untouched. Defer delivery so callers can register/abort the handle first.
  if (opts.req.mode === 'summary' && (opts.req.transcript?.length ?? 0) > LOCAL_SUMMARY_TRANSCRIPT_CHAR_CAP) {
    queueMicrotask(() => {
      if (aborted) return
      opts.handlers.onError(
        'This transcript is too long to summarize locally without omitting earlier discussion. ' +
        'Use a shorter transcript, or explicitly choose a cloud provider in Settings → AI. ' +
        'Métis will not send this local request to the cloud automatically.'
      )
    })
    return { abort: () => { aborted = true } }
  }
  let inner: StreamHandle | null = null
  // Engine-owned release for the beginStream()/endStream() pairing (switch-kill hardening on llama;
  // idle/teardown accounting on fm). Set by whichever engine actually attaches a stream, fired exactly
  // once by onDone/onError/abort. While llama holds this, local-runtime.ts's start() defers rather than
  // SIGKILL the sidecar out from under the request on a model switch.
  let release: (() => void) | null = null
  const releaseStream = (): void => {
    if (!release) return
    const r = release
    release = null
    r()
  }

  // These local modes carry all current context in transcript/screenshot + prompt. Generic chat history
  // is unrelated stale input here and is unbounded at the IPC schema, so never let it consume the fixed
  // context budget — identical bounds on both engines so an engine hop never changes what the model sees.
  const localReq = opts.req.history.length > 0 ? { ...opts.req, history: [] } : opts.req
  const localSystem = boundedLocalSystem(opts.system)
  const maxOutputTokens =
    opts.maxOutputTokens ??
    (opts.req.mode === 'suggest'
      ? LOCAL_OUTPUT_TOKEN_BUDGETS.suggest
      : opts.req.mode === 'summary'
        ? LOCAL_OUTPUT_TOKEN_BUDGETS.summary
        : LOCAL_OUTPUT_TOKEN_BUDGETS.vision)

  // Re-arm the engine's 15-minute idle-stop countdown when the response finishes (success or error), not
  // just when it starts — a long-running stream would otherwise let the idle timer, armed only at start,
  // fire mid-stream on an unrelated schedule.
  const wrapHandlers = (markActivity: () => void): StreamOptions['handlers'] => ({
    ...opts.handlers,
    onDone: (u, completion) => {
      releaseStream()
      markActivity()
      opts.handlers.onDone(
        { ...u, cacheStatus: 'n/a', cacheRead: undefined, cacheWrite: undefined, cacheUncached: undefined },
        completion
      )
    },
    onError: (message) => {
      releaseStream()
      markActivity()
      opts.handlers.onError(message)
    }
  })

  const runLlama = async (): Promise<void> => {
    await ensureLocalRuntimeStarted(opts.model, opts.req.mode === 'vision')
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
    localRuntime.beginStream()
    release = () => localRuntime.endStream()
    inner = streamOpenAI({
      ...opts,
      baseURL: localRuntime.baseURL(),
      apiKey: localRuntime.sessionKey(),
      req: localReq,
      system: localSystem,
      maxOutputTokens,
      llamaSlotOptions,
      handlers: wrapHandlers(() => localRuntime.markActivity())
    })
  }

  const runApple = async (): Promise<void> => {
    await fmRuntime.start()
    if (aborted) return
    fmRuntime.markActivity()
    fmRuntime.beginStream()
    release = () => fmRuntime.endStream()
    inner = streamOpenAI({
      ...opts,
      baseURL: fmRuntime.baseURL(),
      // `fm serve` has no auth surface (see fm-runtime.ts module doc) — the SDK requires a non-empty
      // string, and this placeholder never leaves the loopback interface.
      apiKey: 'fm-loopback',
      model: fmRuntime.FM_SYSTEM_MODEL,
      req: localReq,
      system: localSystem,
      maxOutputTokens,
      // llama-server-specific cache pinning must never reach fm serve — unknown body fields are the
      // classic strict-parser 400.
      llamaSlotOptions: undefined,
      handlers: wrapHandlers(() => fmRuntime.markActivity())
    })
  }

  void (async () => {
    try {
      if ((await pickLocalEngine(opts.req.mode)) === 'apple') {
        try {
          await runApple()
          return
        } catch (err) {
          // The Apple engine failed to START (stream errors after start report via handlers, never throw
          // here) — no tokens were sent, so falling back to llama-server is lossless. probeAvailability's
          // cache said yes but the live spawn said no (e.g. Apple Intelligence toggled off mid-session).
          if (aborted) return
          releaseStream()
          mainLog.warn('[local] apple engine failed to start — falling back to llama-server', errMsg(err))
        }
      }
      await runLlama()
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
