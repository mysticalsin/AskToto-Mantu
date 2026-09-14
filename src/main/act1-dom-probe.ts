/**
 * FITO-185-U: live Act 1 DOM prove helper.
 *
 * After did-finish-load of the real renderer URL + ~2s settle, executeJavaScript collects
 * exclusive/Act1 visibility signals and writes userData/logs/act1-dom.json. Also audits
 * app.act1.dom. Bound when ASKTOTO_MAC_LAUNCH_GATE=1 or while exclusive onboarding is live.
 * Never navigates; never blocks loadURL.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isRealRendererShotUrl } from './asktoto-shot'

export const ACT1_DOM_PROBE_DELAY_MS = 2000
export const ACT1_DOM_PROBE_TIMEOUT_MS = 4000

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

/** Compact probe expression — location.search, exclusive flag, Act1 DOM, Loading captions, opacity. */
export const ACT1_DOM_PROBE_EXPR =
  "(() => {" +
  " const root = document.getElementById('root');" +
  " const stage = document.querySelector('.onboard-stage');" +
  " const portal = document.querySelector('.onboard-portal-content');" +
  " const wordmark = document.querySelector('.hero-wordmark');" +
  " const nextBtn = [...document.querySelectorAll('button')].find(b => /\\bNext\\b/i.test((b.textContent || '').trim()));" +
  " const bodyText = (document.body && document.body.innerText) || '';" +
  " const portalStyle = portal ? getComputedStyle(portal) : null;" +
  " const params = new URLSearchParams(location.search);" +
  " return {" +
  "  ts: new Date().toISOString()," +
  "  href: location.href," +
  "  search: location.search," +
  "  exclusiveOnboarding: params.get('exclusiveOnboarding') === '1'," +
  "  rootChildCount: root ? root.childElementCount : -1," +
  "  hasOnboardStage: !!stage," +
  "  portalOpen: !!(stage && stage.classList.contains('onboard-stage--portal-open'))," +
  "  hasHeroWordmark: !!wordmark," +
  "  heroWordmarkText: wordmark ? (wordmark.textContent || '').trim().slice(0, 80) : null," +
  "  nextButtonText: nextBtn ? (nextBtn.textContent || '').trim().slice(0, 40) : null," +
  "  hasNextButton: !!nextBtn," +
  "  loadingCaption: /\\bLoading\\b/i.test(bodyText)," +
  "  agentStatusCaption: /AgentStatus|Starting\\s+M/i.test(bodyText)," +
  "  bodyTextHead: bodyText.slice(0, 400)," +
  "  portalContentOpacity: portalStyle ? portalStyle.opacity : null," +
  "  portalContentVisibility: portalStyle ? portalStyle.visibility : null," +
  "  wordmarkOpacity: wordmark ? getComputedStyle(wordmark).opacity : null," +
  "  nextOpacity: nextBtn ? getComputedStyle(nextBtn).opacity : null" +
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
    rootChildCount: typeof dom.rootChildCount === 'number' ? dom.rootChildCount : -1,
    search: typeof dom.search === 'string' ? dom.search : ''
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
      if (!isRealRendererShotUrl(target.getURL(), expectedUrl)) return
      void withTimeout(target.executeJavaScript(ACT1_DOM_PROBE_EXPR, true), timeoutMs, 'act1-dom')
        .then((raw: unknown) => {
          const dom =
            raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : { error: 'non-object', raw: String(raw) }
          try {
            mkdir(dirname(outPath), { recursive: true })
            write(outPath, JSON.stringify(dom, null, 2), { mode: 0o600 })
          } catch {
            /* best-effort */
          }
          try {
            opts.audit?.(summarizeAct1Dom(dom))
          } catch {
            /* best-effort */
          }
        })
        .catch((e: unknown) => {
          const fail = {
            ts: (opts.now ?? (() => new Date()))().toISOString(),
            error: String(e)
          }
          try {
            mkdir(dirname(outPath), { recursive: true })
            write(outPath, JSON.stringify(fail, null, 2), { mode: 0o600 })
          } catch {
            /* ignore */
          }
          try {
            opts.audit?.({ error: String(e) })
          } catch {
            /* ignore */
          }
        })
    }, delayMs)
    ;(timer as NodeJS.Timeout).unref?.()
  }

  target.on('did-finish-load', onLoaded)
}
