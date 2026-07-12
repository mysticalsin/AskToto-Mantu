import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react'
import type {
  AskMode,
  ChatTurn,
  PublicSettings,
  SettingsPatch,
  PlatformPermissions,
  StreamDelta,
  StreamDone,
  StreamError,
  StreamMeta,
  TestKeyResponse,
  AuthStatus,
  SignInResult
} from '@shared/ipc'
import type { ProviderId } from '@shared/providers'

export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * Reports content height to the main process so the transparent window hugs the UI.
 * Returns a CALLBACK ref so it always tracks the live element — the overlay's root alternates
 * between the bar `<div>` and the full-window Settings/onboarding/sign-in branches, which unmount
 * and remount the node; a one-time `ref.current` capture would keep observing a detached div and
 * stop resizing after the first Settings round-trip.
 */
export function useAutoResize(): (el: HTMLElement | null) => void {
  const roRef = useRef<ResizeObserver | null>(null)
  const moRef = useRef<MutationObserver | null>(null)
  const rafRef = useRef(0)
  const shrinkRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSentRef = useRef(0) // last height pushed to main — dedups so a stream can't pump setBounds
  const lastSentWidthRef = useRef(0) // last reported width — 0 until a [data-hug-width] view reports one
  return useCallback((el: HTMLElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    moRef.current?.disconnect()
    moRef.current = null
    if (shrinkRef.current) {
      clearTimeout(shrinkRef.current)
      shrinkRef.current = null
    }
    if (!el) return
    // A genuine view swap (Bar<->Settings/onboarding/sign-in) attaches a brand-new, unrelated element.
    // Reset the dedup baseline so this view's first send() is judged against a fresh 0, not the PREVIOUS
    // view's last-sent height — otherwise a shorter new view wrongly reads as a SHRINK (line 108) and gets
    // held back by the 140ms settle debounce meant only for a streaming answer settling in place.
    lastSentRef.current = 0
    lastSentWidthRef.current = 0
    const push = (h: number, w?: number): void => {
      // Idempotent on height alone unless a width report is present AND changed — a view with no
      // [data-hug-width] element (the common case) never has anything new to say about width.
      if (h === lastSentRef.current && (w === undefined || w === lastSentWidthRef.current)) return
      lastSentRef.current = h
      if (w !== undefined) lastSentWidthRef.current = w
      window.toto.resize(h, w)
    }
    // el.getBoundingClientRect().height reflects only el's own normal-flow box — a position:absolute
    // descendant (a popover/dropdown, e.g. Bar's mode picker) never affects an ancestor's measured
    // height, by CSS layout definition, even though it renders correctly and visibly in the DOM. Without
    // accounting for it here, the window never grows to fit it: the dropdown is real, on-screen for
    // Electron's purposes, and invisibly clipped by a window frame that stopped at the bar's own height.
    // Any element needing to extend past el's box marks itself with data-overlay to opt into this.
    const measure = (): { height: number; width?: number } => {
      const rect = el.getBoundingClientRect()
      let bottom = rect.bottom
      // data-overlay is only ever mounted by the (usually-closed) mode popover — querySelectorAll always
      // walks the full subtree even when nothing matches, and this runs on every MutationObserver firing,
      // which during a streaming answer is roughly every animation frame (Streamdown/CodeBlock mutate the
      // DOM continuously as tokens arrive). querySelector (singular) short-circuits at the first match, so
      // the overwhelmingly common "no overlay mounted" case skips straight past instead of enumerating —
      // only fall back to querySelectorAll (to correctly max() over more than one) once we know there's at
      // least one to look at.
      if (el.querySelector('[data-overlay]')) {
        el.querySelectorAll<HTMLElement>('[data-overlay]').forEach((node) => {
          const r = node.getBoundingClientRect()
          if (r.bottom > bottom) bottom = r.bottom
        })
      }
      // el itself is always the full window width (it's the shared centering/layout root for every view),
      // so it can never report a meaningful WIDTH the way it already does for height. A view whose visible
      // surface is narrower than the window — today only the collapsed control mini-pill — opts in by
      // marking its own shrink-to-fit element with data-hug-width; every other view has none, so width
      // stays unreported and that view's window width is untouched (unaffected by this at all).
      // Report the hug target's NATURAL width, not its rendered rect: when the window is already
      // narrow (minimize shrinks it before the pill's first report), flex squeezes the pill to the
      // window and rect.width just echoes that squeeze back — the window then settles too small and
      // amputates the pill's right end (the mic button was cut in half). scrollWidth is layout truth
      // regardless of the squeeze; it's padding-box, so add the borders back.
      const hugTarget = el.querySelector<HTMLElement>('[data-hug-width]')
      const width = hugTarget
        ? Math.ceil(
            Math.max(
              hugTarget.getBoundingClientRect().width,
              hugTarget.scrollWidth + (hugTarget.offsetWidth - hugTarget.clientWidth)
            )
          )
        : undefined
      return { height: Math.ceil(bottom - rect.top), width }
    }
    const send = (): void => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        const m = measure()
        // Quantize the GROW path to a 24px step so a streaming answer's per-frame growth coalesces into
        // far fewer resize IPCs instead of one per tiny reflow. The settle-shrink branch below is
        // untouched and still lands the content's exact final height.
        const h = Math.ceil((m.height + 2) / 24) * 24
        if (shrinkRef.current) {
          clearTimeout(shrinkRef.current)
          shrinkRef.current = null
        }
        if (m.width !== undefined) {
          // A width report comes only from the collapsed control pill (data-hug-width), which is fully
          // static and has nothing to settle. Push its EXACT height (not the 24px-quantized grow step `h`):
          // the pill is ~54px, which `h` rounds up to 72, leaving ~18px of dead space below the pill so it
          // floats in a too-tall window. Exact height makes the window hug the pill. Width still lands on
          // the frame after the main-process guess resize, one clean settle.
          push(m.height + 2, m.width)
        } else if (h >= lastSentRef.current) {
          push(h) // GROW immediately — streaming text must never clip behind the window edge
        } else {
          // SHRINK only after the content settles (~140ms) so a finishing stream doesn't pump the window down
          shrinkRef.current = setTimeout(() => {
            const m2 = measure()
            push(m2.height + 2, m2.width)
          }, 140)
        }
      })
    }
    const ro = new ResizeObserver(send)
    ro.observe(el)
    roRef.current = ro
    // A data-overlay element mounting/unmounting (e.g. opening the mode picker) doesn't change el's own
    // box size, so ResizeObserver alone never fires for it — watch DOM insert/remove too.
    const mo = new MutationObserver(send)
    mo.observe(el, { childList: true, subtree: true })
    moRef.current = mo
    send()
  }, [])
}

export interface AnswerState {
  id: string
  text: string
  streaming: boolean
  error: string | null
  prompt: string
  // User-facing header (the claim/question being asked). The `prompt` is the engineered scaffold that
  // goes to the model and must NEVER be shown; `label` is what the UI displays. Falls back to '' (hidden).
  label?: string
  kind?: 'answer' | 'factcheck' // drives the verdict-card rendering for fact-checks
  // True when this answer was grounded in a screenshot (req.mode === 'vision') — drives the "Viewed
  // screen" trust chip independent of `label`/`prompt`, so a real typed question can show as the header
  // AND still carry the trust chip (previously the chip only showed when label was the literal string
  // 'Viewed screen', which overwrote — and so could never coexist with — the user's actual question).
  usedScreen?: boolean
  // True only for AMBIENT auto-suggestions (req.mode === 'suggest'). Gates the copilot auto-dismiss
  // TTL: user-initiated turns on the same surface (typed questions, Assist, quick actions) must stay
  // until the user acts — auto-wiping them 4-7s after they finish is data loss (and a WCAG 2.2.1 miss).
  ephemeral?: boolean
  // Who is answering (from streamMeta, sent before any token) — lets the waiting UI name the brain
  // ("Asking your Dust agent…") instead of an anonymous spinner. Follows the latest retry/failover.
  provider?: ProviderId
  tier?: 'base' | 'think' | 'deep'
}

export interface AskRequest {
  mode: AskMode
  prompt?: string
  label?: string
  kind?: 'answer' | 'factcheck'
  image?: string
  transcript?: string
  history?: ChatTurn[]
  depth?: 'deeper' // set by "Go deeper" → ask for a fuller answer than the brief default
  agentOverride?: string // pins a specific Dust agent sId regardless of tier routing (e.g. Spotlight Ref)
  providerOverride?: ProviderId // forces this one request to a provider regardless of the active `provider` setting
}

/** Owns the streaming answer lifecycle over IPC. */
export function useAsk(): {
  answer: AnswerState | null
  run: (req: AskRequest) => string
  fail: (error: string, label?: string) => string
  retry: () => string
  deeper: () => string
  cancel: () => void
  clear: () => void
} {
  const [answer, setAnswer] = useState<AnswerState | null>(null)
  const idRef = useRef<string>('')
  const lastReqRef = useRef<AskRequest | null>(null) // last request, so Retry can replay vision verbatim
  // Batch streamed tokens to one flush per animation frame. Without this, every token re-renders the
  // whole markdown answer and Streamdown re-lexes the entire growing string → O(n^2) on fast providers.
  const pendingRef = useRef('')
  const rafRef = useRef(0)
  const firstTokenSentRef = useRef(false) // first delta flushes synchronously (min TTFT); rest batch per RAF
  // True from run() until the NEW request's first chunk of real output lands. While true, the previous
  // answer's text is still on screen (run() deliberately does not blank it — Tony: answers must stay
  // visible until the NEXT action actually has something to show, not vanish/flash "Thinking…" on click)
  // and the first flush REPLACES rather than appends to it, so stale text never gets old content prefixed
  // onto it. If the request ends with no real output at all (onDone/onError with zero deltas), the stale
  // text is cleared then instead — so a copy/feedback action can never act on the wrong answer.
  const pendingReplaceRef = useRef(false)

  useEffect(() => {
    const flush = (): void => {
      rafRef.current = 0
      const chunk = pendingRef.current
      if (!chunk) return
      pendingRef.current = ''
      setAnswer((a) => {
        if (!a) return a
        const text = pendingReplaceRef.current ? chunk : a.text + chunk
        return { ...a, text }
      })
      pendingReplaceRef.current = false
    }
    const offDelta = window.toto.onDelta((d: StreamDelta) => {
      if (d.id !== idRef.current) return
      pendingRef.current += d.text
      // Flush the FIRST token synchronously — that's the moment perceived latency is set; a RAF here would
      // add ~16ms to time-to-first-token. Everything after is batched per frame to avoid O(n^2) re-lexing.
      if (!firstTokenSentRef.current) {
        firstTokenSentRef.current = true
        flush()
      } else if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(flush)
      }
    })
    const offDone = window.toto.onDone((d: StreamDone) => {
      if (d.id !== idRef.current) return
      flush() // drain any buffered tokens before marking done
      // Zero real output ever arrived (e.g. an empty completion) — drop the stale previous-answer text
      // instead of leaving it looking like the result of THIS request.
      const noOutput = pendingReplaceRef.current
      pendingReplaceRef.current = false
      setAnswer((a) => (a ? { ...a, streaming: false, text: noOutput ? '' : a.text } : a))
    })
    const offMeta = window.toto.onMeta((m: StreamMeta) => {
      if (m.id !== idRef.current) return
      setAnswer((a) => (a && a.id === m.id ? { ...a, provider: m.provider, tier: m.tier } : a))
    })
    const offErr = window.toto.onError((e: StreamError) => {
      if (e.id !== idRef.current) return
      flush() // keep any partial answer captured before the error
      // User-initiated aborts/cancels are not failures — never paint them as a red error on screen. A
      // cancel before any output simply reverts to whichever answer was already showing (the persistence
      // contract above); a genuine error clears stale leftover text so Copy/feedback can't act on it.
      const aborted = /\babort|\bcancel/i.test(e.message || '')
      const noOutput = pendingReplaceRef.current
      pendingReplaceRef.current = false
      setAnswer((a) =>
        a
          ? { ...a, streaming: false, error: aborted ? null : e.message, text: !aborted && noOutput ? '' : a.text }
          : aborted
            ? null
            : { id: e.id, text: '', streaming: false, error: e.message, prompt: '' }
      )
    })
    return () => {
      offDelta()
      offDone()
      offMeta()
      offErr()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const resetBuffer = useCallback((): void => {
    pendingRef.current = ''
    firstTokenSentRef.current = false // next request sync-flushes its own first token
    pendingReplaceRef.current = true // next request's first chunk replaces (not appends to) old text
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [])

  const run = useCallback(
    (req: AskRequest): string => {
      lastReqRef.current = req // remember the full request (mode + image) so Retry replays it exactly
      if (idRef.current) void window.toto.cancel(idRef.current) // abort any prior in-flight stream
      resetBuffer()
      const id = uid()
      idRef.current = id
      // Deliberately keep the PREVIOUS answer's text on screen (not blanked to '') until this request's
      // first real chunk lands — see pendingReplaceRef above.
      //
      // startTransition: this is the update that mounts <Answer>/<Copilot> for the FIRST time in a fresh
      // session (answer flips null -> non-null), in DIRECT response to synchronous input (Enter keydown, a
      // toolbar click). Those are lazy-loaded chunks (App.tsx) with no Suspense boundary around their
      // inline bar-body render slot — if the chunk hasn't resolved yet, an un-transitioned update suspends
      // mid-synchronous-input and React throws #426 ("Métis hit a snag"), exactly like the view-switch
      // hazard App.tsx's setView already documents and fixes the same way. Reproduced physically via
      // Spotlight Ref's ask.fail() (no provider gate, so it's the very first render in a fresh session) —
      // App.tsx also warms both chunks on mount to shrink the window further, but that alone does not
      // prevent the crash: React always suspends a lazy component's very FIRST render attempt regardless of
      // whether the module is already cached, so the transition wrap is the actual fix; the warm-up just
      // makes it resolve on the very next tick instead of after a real network/parse wait.
      startTransition(() => {
        setAnswer((prev) => ({
          id,
          text: prev?.text ?? '',
          streaming: true,
          error: null,
          prompt: req.prompt ?? '',
          label: req.label,
          kind: req.kind,
          usedScreen: req.mode === 'vision',
          ephemeral: req.mode === 'suggest'
        }))
      })
      void window.toto.ask({
        id,
        mode: req.mode,
        prompt: req.prompt ?? '',
        image: req.image,
        transcript: req.transcript,
        depth: req.depth,
        kind: req.kind,
        agentOverride: req.agentOverride,
        providerOverride: req.providerOverride,
        history: req.history ?? []
      })
      return id
    },
    [resetBuffer]
  )

  const fail = useCallback(
    (error: string, label = ''): string => {
      if (idRef.current) void window.toto.cancel(idRef.current)
      resetBuffer()
      const id = uid()
      idRef.current = id
      lastReqRef.current = null
      // Same #426 hazard/fix as run() above — fail() is the path a gate-free entry point (e.g. Spotlight
      // Ref with no ref agent configured) uses to mount <Answer> for the very first time in a session.
      startTransition(() => {
        setAnswer({ id, text: '', streaming: false, error, prompt: '', label })
      })
      return id
    },
    [resetBuffer]
  )

  const cancel = useCallback((): void => {
    if (idRef.current) {
      void window.toto.cancel(idRef.current)
      setAnswer((a) => (a ? { ...a, streaming: false } : a))
    }
  }, [])

  const clear = useCallback((): void => {
    idRef.current = ''
    resetBuffer()
    setAnswer(null)
  }, [resetBuffer])

  // Replay the last request EXACTLY (same mode + screenshot + prompt) so retrying a vision answer re-sends
  // the image instead of silently re-asking text-only and getting a blind "I can't see your screen" answer.
  const retry = useCallback((): string => (lastReqRef.current ? run(lastReqRef.current) : ''), [run])

  // "Go deeper": replay the last request (mode + image + transcript + history preserved exactly, like retry)
  // with the depth flag set, so the model expands its usually-brief answer.
  const deeper = useCallback(
    (): string => (lastReqRef.current ? run({ ...lastReqRef.current, depth: 'deeper' }) : ''),
    [run]
  )

  // Memoized so consumers (App.tsx passes this whole object around as a dependency) only see a new
  // identity when the answer itself actually changes — run/fail/retry/deeper/cancel/clear are already
  // useCallback-stable, so without this the returned object was a fresh literal on every render.
  return useMemo(
    () => ({ answer, run, fail, retry, deeper, cancel, clear }),
    [answer, run, fail, retry, deeper, cancel, clear]
  )
}

export function useSettings(): {
  settings: PublicSettings | null
  refresh: () => Promise<void>
  patch: (p: SettingsPatch) => Promise<void>
  saveKey: (provider: ProviderId, k: string) => Promise<void>
  clearKey: (provider: ProviderId) => Promise<void>
  testKey: (provider: ProviderId, k: string) => Promise<TestKeyResponse>
} {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const refresh = useCallback(async () => {
    // Swallow post-boot refresh failures (focus/poll): a transient reject must not surface as an
    // unhandled rejection, and the next trigger retries. The boot load below owns first-paint recovery.
    try {
      setSettings(await window.toto.getSettings())
    } catch (e) {
      console.error('[settings] refresh failed', e)
    }
  }, [])
  useEffect(() => {
    // First-paint load with retry. getSettings() can reject before the main-process handler is
    // registered (boot-order race) or on a transient decrypt hiccup; the app renders only the
    // "Starting Métis…" strip until `settings` is non-null, and the overlay is usually already
    // focused so the focus-refetch below never fires — without a retry a single boot reject strands
    // the app on that strip indefinitely. Retry with backoff until it resolves.
    let cancelled = false
    void (async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          const s = await window.toto.getSettings()
          if (!cancelled) setSettings(s)
          return
        } catch (e) {
          if (attempt >= 40) {
            console.error('[boot] getSettings failed after retries; app cannot start', e)
            return
          }
          await new Promise((r) => setTimeout(r, Math.min(150 * (attempt + 1), 1500)))
        }
      }
    })()
    // Refetch on focus so settings changed by the MAIN process (e.g. the Dust CLI auto-connect / token
    // refresh on launch) surface in the UI without the user having to do anything.
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])
  const patch = useCallback(async (p: Partial<PublicSettings>) => {
    setSettings(await window.toto.setSettings(p))
  }, [])
  const saveKey = useCallback(
    async (provider: ProviderId, k: string) => {
      await window.toto.setApiKey(provider, k)
      await refresh()
    },
    [refresh]
  )
  const clearKey = useCallback(
    async (provider: ProviderId) => {
      await window.toto.clearApiKey(provider)
      await refresh()
    },
    [refresh]
  )
  const testKey = useCallback(async (provider: ProviderId, k: string) => {
    return window.toto.testApiKey(provider, k)
  }, [])
  return { settings, refresh, patch, saveKey, clearKey, testKey }
}

/** How often the renderer re-polls auth status while the app is open.
 *
 * main/auth.ts silently revalidates the MSAL session every REVALIDATE_INTERVAL_MS (30 min) and can drop
 * a revoked session at any time — but that happens in the main process, with no push channel to the
 * renderer. Without a poll here, useAuth()'s status is fetched once at mount and goes stale: the UI keeps
 * showing "signed in" long after requireAuth() has flipped to false in main, so the user only discovers
 * they were signed out when some unrelated privileged action fails. Polling (plus an immediate refresh on
 * focus, for the fast path) keeps SignInWall/Settings honest without needing an IPC push mechanism.
 */
export const AUTH_POLL_MS = 5 * 60 * 1000 // 5 min — well under the 30 min main-process sweep

type AuthRefreshEnv = {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

/** Keep auth status live while the app is open (mirrors startPermissionRefreshLoop's shape/rationale). */
export function startAuthRefreshLoop(refresh: () => void, env: AuthRefreshEnv = { window }): () => void {
  refresh()
  const onFocus = (): void => refresh()
  const interval = setInterval(refresh, AUTH_POLL_MS)
  env.window.addEventListener('focus', onFocus)
  return () => {
    clearInterval(interval)
    env.window.removeEventListener('focus', onFocus)
  }
}

export function useAuth(): {
  status: AuthStatus | null
  signIn: () => Promise<SignInResult>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
} {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const refresh = useCallback(async () => {
    // Swallow post-boot poll/focus failures; the boot loader below owns first-paint recovery.
    try {
      setStatus(await window.toto.authStatus())
    } catch (e) {
      console.error('[auth] refresh failed', e)
    }
  }, [])
  useEffect(() => {
    // First-paint load with retry. authStatus() can reject before the main handler is registered
    // (boot-order race); the ongoing poll only re-fires every AUTH_POLL_MS (5 min), so a single boot
    // reject would strand the app on the "Starting Métis…" strip (which waits for auth.status != null)
    // for minutes. Retry fast until it resolves, then hand off to the poll loop for freshness.
    let cancelled = false
    void (async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          const st = await window.toto.authStatus()
          if (!cancelled) setStatus(st)
          return
        } catch (e) {
          if (attempt >= 40) {
            console.error('[boot] authStatus failed after retries', e)
            return
          }
          await new Promise((r) => setTimeout(r, Math.min(150 * (attempt + 1), 1500)))
        }
      }
    })()
    const stop = startAuthRefreshLoop(() => void refresh())
    return () => {
      cancelled = true
      stop()
    }
  }, [refresh])
  const signIn = useCallback(async () => {
    const r = await window.toto.signIn()
    await refresh()
    return r
  }, [refresh])
  const signOut = useCallback(async () => {
    await window.toto.signOut()
    await refresh()
  }, [refresh])
  return { status, signIn, signOut, refresh }
}

export const PERMISSIONS_POLL_MS = 2500

type PermissionRefreshEnv = {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
}

/** Keep permission UI live while it is mounted.
 *
 * macOS users often grant Screen Recording / Mic / Accessibility in System Settings while Métis's
 * Settings panel stays open. Focus/visibility refreshes catch the common return-to-app path, but they miss
 * the split-view case where System Settings and Métis are visible at the same time. Polling at the same
 * cadence as onboarding (2.5s) keeps the status dots honest without adding meaningful work.
 */
export function startPermissionRefreshLoop(
  refresh: () => void,
  env: PermissionRefreshEnv = { window, document }
): () => void {
  refresh()
  const onFocus = (): void => refresh()
  const onVisibilityChange = (): void => {
    if (env.document.visibilityState === 'visible') refresh()
  }
  const interval = setInterval(refresh, PERMISSIONS_POLL_MS)
  env.window.addEventListener('focus', onFocus)
  env.document.addEventListener('visibilitychange', onVisibilityChange)
  return () => {
    clearInterval(interval)
    env.window.removeEventListener('focus', onFocus)
    env.document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

export function usePermissions(): {
  permissions: PlatformPermissions | null
  refresh: () => Promise<void>
} {
  const [permissions, setPermissions] = useState<PlatformPermissions | null>(null)
  const refresh = useCallback(async () => {
    setPermissions(await window.toto.getPermissions())
  }, [])
  useEffect(() => {
    return startPermissionRefreshLoop(() => void refresh())
  }, [refresh])
  return { permissions, refresh }
}
