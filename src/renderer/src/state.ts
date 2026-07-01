import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AskMode,
  ChatTurn,
  PublicSettings,
  SettingsPatch,
  PlatformPermissions,
  StreamDelta,
  StreamDone,
  StreamError,
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
    const push = (h: number): void => {
      if (h === lastSentRef.current) return // idempotent — no redundant window.toto.resize per token
      lastSentRef.current = h
      window.toto.resize(h)
    }
    // el.getBoundingClientRect().height reflects only el's own normal-flow box — a position:absolute
    // descendant (a popover/dropdown, e.g. Bar's mode picker) never affects an ancestor's measured
    // height, by CSS layout definition, even though it renders correctly and visibly in the DOM. Without
    // accounting for it here, the window never grows to fit it: the dropdown is real, on-screen for
    // Electron's purposes, and invisibly clipped by a window frame that stopped at the bar's own height.
    // Any element needing to extend past el's box marks itself with data-overlay to opt into this.
    const measure = (): number => {
      const rect = el.getBoundingClientRect()
      let bottom = rect.bottom
      el.querySelectorAll<HTMLElement>('[data-overlay]').forEach((node) => {
        const r = node.getBoundingClientRect()
        if (r.bottom > bottom) bottom = r.bottom
      })
      return Math.ceil(bottom - rect.top)
    }
    const send = (): void => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        const h = measure() + 2
        if (shrinkRef.current) {
          clearTimeout(shrinkRef.current)
          shrinkRef.current = null
        }
        if (h >= lastSentRef.current) {
          push(h) // GROW immediately — streaming text must never clip behind the window edge
        } else {
          // SHRINK only after the content settles (~140ms) so a finishing stream doesn't pump the window down
          shrinkRef.current = setTimeout(() => push(measure() + 2), 140)
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
      setAnswer((prev) => ({
        id,
        text: prev?.text ?? '',
        streaming: true,
        error: null,
        prompt: req.prompt ?? '',
        label: req.label,
        kind: req.kind,
        usedScreen: req.mode === 'vision'
      }))
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
      setAnswer({ id, text: '', streaming: false, error, prompt: '', label })
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

  return { answer, run, fail, retry, deeper, cancel, clear }
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
    setSettings(await window.toto.getSettings())
  }, [])
  useEffect(() => {
    void refresh()
    // Refetch on focus so settings changed by the MAIN process (e.g. the Dust CLI auto-connect / token
    // refresh on launch) surface in the UI without the user having to do anything.
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
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
    setStatus(await window.toto.authStatus())
  }, [])
  useEffect(() => startAuthRefreshLoop(() => void refresh()), [refresh])
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
 * macOS users often grant Screen Recording / Mic / Accessibility in System Settings while AskToto's
 * Settings panel stays open. Focus/visibility refreshes catch the common return-to-app path, but they miss
 * the split-view case where System Settings and AskToto are visible at the same time. Polling at the same
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
