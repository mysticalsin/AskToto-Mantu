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
  const rafRef = useRef(0)
  return useCallback((el: HTMLElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    const send = (): void => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        window.toto.resize(Math.ceil(el.getBoundingClientRect().height) + 2)
      })
    }
    const ro = new ResizeObserver(send)
    ro.observe(el)
    roRef.current = ro
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
}

export interface AskRequest {
  mode: AskMode
  prompt?: string
  label?: string
  kind?: 'answer' | 'factcheck'
  image?: string
  transcript?: string
  history?: ChatTurn[]
}

/** Owns the streaming answer lifecycle over IPC. */
export function useAsk(): {
  answer: AnswerState | null
  run: (req: AskRequest) => string
  retry: () => string
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

  useEffect(() => {
    const flush = (): void => {
      rafRef.current = 0
      const chunk = pendingRef.current
      if (!chunk) return
      pendingRef.current = ''
      setAnswer((a) => (a ? { ...a, text: a.text + chunk } : a))
    }
    const offDelta = window.toto.onDelta((d: StreamDelta) => {
      if (d.id !== idRef.current) return
      pendingRef.current += d.text
      if (!rafRef.current) rafRef.current = requestAnimationFrame(flush)
    })
    const offDone = window.toto.onDone((d: StreamDone) => {
      if (d.id !== idRef.current) return
      flush() // drain any buffered tokens before marking done
      setAnswer((a) => (a ? { ...a, streaming: false } : a))
    })
    const offErr = window.toto.onError((e: StreamError) => {
      if (e.id !== idRef.current) return
      flush() // keep any partial answer captured before the error
      // User-initiated aborts/cancels are not failures — never paint them as a red error on screen.
      const aborted = /\babort|\bcancel/i.test(e.message || '')
      setAnswer((a) =>
        a
          ? { ...a, streaming: false, error: aborted ? null : e.message }
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
      setAnswer({ id, text: '', streaming: true, error: null, prompt: req.prompt ?? '', label: req.label, kind: req.kind })
      void window.toto.ask({
        id,
        mode: req.mode,
        prompt: req.prompt ?? '',
        image: req.image,
        transcript: req.transcript,
        history: req.history ?? []
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

  return { answer, run, retry, cancel, clear }
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
  useEffect(() => {
    void refresh()
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

export function usePermissions(): {
  permissions: PlatformPermissions | null
  refresh: () => Promise<void>
} {
  const [permissions, setPermissions] = useState<PlatformPermissions | null>(null)
  const refresh = useCallback(async () => {
    setPermissions(await window.toto.getPermissions())
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { permissions, refresh }
}
