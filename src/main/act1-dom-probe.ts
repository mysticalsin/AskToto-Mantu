/**
 * FITO-185-U: live Act 1 DOM prove helper.
 *
 * After did-finish-load of the real renderer URL + ~2s settle, executeJavaScript collects only
 * structural Act 1 readiness signals and writes userData/logs/act1-dom.json. The release launch gate
 * may bind it; normal onboarding never does. It never reads text, markup, media locations, screenshots,
 * or arbitrary renderer URLs, and never blocks loadURL.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isRealRendererShotUrl } from './asktoto-shot'

export const ACT1_DOM_PROBE_DELAY_MS = 2000
export const ACT1_DOM_PROBE_TIMEOUT_MS = 4000
/** FITO-185-X: if did-finish-load never arms the probe, still write a miss artifact. */
export const ACT1_DOM_PROBE_MISS_MS = 5000

export interface Act1DomProbeTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  getURL(): string
  isDestroyed(): boolean
  executeJavaScript(source: string, userGesture?: boolean): Promise<unknown>
}

export interface BindAct1DomProbeOptions {
  expectedUrl: string
  outPath: string
  audit?: (summary: Record<string, unknown>) => void
  delayMs?: number
  timeoutMs?: number
  writeFile?: typeof writeFileSync
  mkdir?: typeof mkdirSync
  setTimer?: typeof setTimeout
  now?: () => Date
}

/** Compact metadata-only probe expression — booleans, counts, and visual readiness values only. */
export const ACT1_DOM_PROBE_EXPR =
  "(() => {" +
  " const root = document.getElementById('root');" +
  " const stage = document.querySelector('.onboard-stage');" +
  " const portal = document.querySelector('.onboard-portal-content');" +
  " const wordmark = document.querySelector('.hero-wordmark');" +
  " const nextBtn = document.querySelector('button.onboard-cta');" +
  " const video = document.querySelector('.onboard-hero-video video');" +
  " const portalStyle = portal ? getComputedStyle(portal) : null;" +
  " const nextStyle = nextBtn ? getComputedStyle(nextBtn) : null;" +
  " const params = new URLSearchParams(location.search);" +
  " const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;" +
  " return {" +
  "  ts: new Date().toISOString()," +
  "  exclusiveOnboarding: params.get('exclusiveOnboarding') === '1'," +
  "  rootChildCount: root ? root.childElementCount : -1," +
  "  hasOnboardStage: !!stage," +
  "  portalOpen: !!(stage && stage.classList.contains('onboard-stage--portal-open'))," +
  "  hasHeroWordmark: !!wordmark," +
  "  hasNextButton: !!nextBtn," +
  "  nextPointerEvents: nextStyle ? nextStyle.pointerEvents : null," +
  "  nextZIndex: nextStyle ? nextStyle.zIndex : null," +
  "  prefersReducedMotion: !!reduced," +
  "  hasHeroVideo: !!video," +
  "  videoReadyState: video ? video.readyState : null," +
  "  videoNetworkState: video ? video.networkState : null," +
  "  videoCurrentTime: video ? video.currentTime : null," +
  "  videoPaused: video ? video.paused : null," +
  "  loadingCaption: !!document.querySelector('[data-agent-status=\"loading\"]')," +
  "  agentStatusCaption: !!document.querySelector('[data-agent-status]')," +
  "  portalContentOpacity: portalStyle ? portalStyle.opacity : null," +
  "  portalContentVisibility: portalStyle ? portalStyle.visibility : null," +
  "  wordmarkOpacity: wordmark ? getComputedStyle(wordmark).opacity : null," +
  "  nextOpacity: nextStyle ? nextStyle.opacity : null" +
  " };" +
  "})()"

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export function summarizeAct1Dom(dom: Record<string, unknown>): Record<string, unknown> {
  return {
    exclusiveOnboarding: dom.exclusiveOnboarding === true,
    hasOnboardStage: dom.hasOnboardStage === true,
    portalOpen: dom.portalOpen === true,
    hasHeroWordmark: dom.hasHeroWordmark === true,
    hasNextButton: dom.hasNextButton === true,
    loadingCaption: dom.loadingCaption === true,
    agentStatusCaption: dom.agentStatusCaption === true,
    portalContentOpacity: dom.portalContentOpacity ?? null,
    wordmarkOpacity: dom.wordmarkOpacity ?? null,
    nextOpacity: dom.nextOpacity ?? null,
    nextPointerEvents: dom.nextPointerEvents ?? null,
    prefersReducedMotion: dom.prefersReducedMotion === true,
    hasHeroVideo: dom.hasHeroVideo === true,
    videoReadyState: typeof dom.videoReadyState === 'number' ? dom.videoReadyState : null,
    videoNetworkState: typeof dom.videoNetworkState === 'number' ? dom.videoNetworkState : null,
    videoCurrentTime: typeof dom.videoCurrentTime === 'number' ? dom.videoCurrentTime : null,
    videoPaused: typeof dom.videoPaused === 'boolean' ? dom.videoPaused : null,
    rootChildCount: typeof dom.rootChildCount === 'number' ? dom.rootChildCount : -1
  }
}

/**
 * Register BEFORE loadURL. Ignores about:blank; after matching did-finish-load waits delayMs then probes once.
 */
export function bindAct1DomProbe(target: Act1DomProbeTarget, opts: BindAct1DomProbeOptions): void {
  const write = opts.writeFile ?? writeFileSync
  const mkdir = opts.mkdir ?? mkdirSync
  const setTimer = opts.setTimer ?? setTimeout
  const delayMs = Math.max(ACT1_DOM_PROBE_DELAY_MS, opts.delayMs ?? ACT1_DOM_PROBE_DELAY_MS)
  const timeoutMs = opts.timeoutMs ?? ACT1_DOM_PROBE_TIMEOUT_MS
  const { expectedUrl, outPath } = opts

  let armed = false
  const onLoaded = (): void => {
    if (target.isDestroyed()) return
    const url = target.getURL()
    if (!isRealRendererShotUrl(url, expectedUrl)) return
    if (armed) return
    armed = true
    const timer = setTimer(() => {
      if (target.isDestroyed()) return
      // FITO-185-U: after arming on a real load, do not drop the probe if getURL() drifts
      // (query encoding / trailing slash). Still skip about:blank.
      const live = target.getURL()
      if (!live || live.startsWith('about:')) return
      void withTimeout(target.executeJavaScript(ACT1_DOM_PROBE_EXPR, true), timeoutMs, 'act1-dom')
        .then((raw: unknown) => {
          const dom =
            raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : { error: 'non-object' }
          const summary = summarizeAct1Dom(dom)
          try {
            mkdir(dirname(outPath), { recursive: true })
            write(outPath, JSON.stringify(summary, null, 2), { mode: 0o600 })
          } catch {
            /* best-effort */
          }
          try {
            opts.audit?.(summary)
          } catch {
            /* best-effort */
          }
        })
        .catch(() => {
          const fail = {
            ts: (opts.now ?? (() => new Date()))().toISOString(),
            error: 'act1-dom-probe-failed'
          }
          try {
            mkdir(dirname(outPath), { recursive: true })
            write(outPath, JSON.stringify(fail, null, 2), { mode: 0o600 })
          } catch {
            /* ignore */
          }
          try {
            opts.audit?.({ error: 'act1-dom-probe-failed' })
          } catch {
            /* ignore */
          }
        })
    }, delayMs)
    ;(timer as NodeJS.Timeout).unref?.()
  }

  target.on('did-finish-load', onLoaded)

  // FITO-185-X: silent miss left installer-prove with renderer.ready and no act1-dom.json.
  const missMs = Math.max(ACT1_DOM_PROBE_MISS_MS, delayMs + 1000)
  const missTimer = setTimer(() => {
    if (armed || target.isDestroyed()) return
    const miss = {
      ts: (opts.now ?? (() => new Date()))().toISOString(),
      error: 'act1-dom-miss: never-armed'
    }
    try {
      mkdir(dirname(outPath), { recursive: true })
      write(outPath, JSON.stringify(miss, null, 2), { mode: 0o600 })
    } catch {
      /* ignore */
    }
    try {
      opts.audit?.({ error: miss.error })
    } catch {
      /* ignore */
    }
  }, missMs)
  ;(missTimer as NodeJS.Timeout).unref?.()
}
