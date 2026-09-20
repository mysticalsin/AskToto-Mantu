/**
 * QA-only DOM dump for Metis-*-qa.app feel builds (Resources/TIP.txt present).
 * Writes userData/logs/qa-dom.json with Ultron P0 fields. Never ships on Latest.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const QA_DOM_DUMP_DELAY_MS = 2500
export const QA_DOM_DUMP_TIMEOUT_MS = 5000

export interface QaDomDumpTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  isDestroyed(): boolean
  executeJavaScript(source: string, userGesture?: boolean): Promise<unknown>
}

const QA_DOM_EXPR =
  "(() => {" +
  " const boot = document.getElementById('act1-boot-chrome');" +
  " const bootNext = document.getElementById('act1-boot-next');" +
  " const sceneEl = document.querySelector('[data-scene], [data-onboard-scene]');" +
  " const disabled = Array.from(document.querySelectorAll('button:disabled')).map((b) => ({" +
  "   id: b.id || null," +
  "   text: ((b.textContent || '').trim()).slice(0, 80)," +
  "   disabled: true" +
  " }));" +
  " const loadingNode = document.querySelector('[data-agent-status=\"loading\"]');" +
  " return {" +
  "  ts: new Date().toISOString()," +
  "  exclusiveOnboarding: new URLSearchParams(location.search).get('exclusiveOnboarding') === '1'," +
  "  bodyInnerText: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 4000)," +
  "  loadingCaption: !!loadingNode," +
  "  loadingCaptionText: loadingNode ? (loadingNode.textContent || '').trim().slice(0, 200) : null," +
  "  scene: sceneEl ? (sceneEl.getAttribute('data-scene') || sceneEl.getAttribute('data-onboard-scene')) : null," +
  "  disabledButtons: disabled," +
  "  act1BootChromePresent: !!boot," +
  "  act1BootNextPresent: !!bootNext," +
  "  hasOnboardStage: !!document.querySelector('.onboard-stage')," +
  "  hasNextButton: !!document.querySelector('button.onboard-cta')," +
  "  documentHidden: !!document.hidden," +
  "  visibilityState: document.visibilityState || null," +
  "  bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : null," +
  "  htmlClass: document.documentElement.className || null," +
  "  rootChildCount: document.getElementById('root') ? document.getElementById('root').childElementCount : -1" +
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

export function bindQaDomDump(
  target: QaDomDumpTarget,
  opts: { outPath: string; delayMs?: number; timeoutMs?: number; audit?: (s: Record<string, unknown>) => void }
): void {
  const delayMs = opts.delayMs ?? QA_DOM_DUMP_DELAY_MS
  const timeoutMs = opts.timeoutMs ?? QA_DOM_DUMP_TIMEOUT_MS
  let armed = false
  const onLoaded = (): void => {
    if (armed || target.isDestroyed()) return
    armed = true
    const timer = setTimeout(() => {
      void withTimeout(target.executeJavaScript(QA_DOM_EXPR, true), timeoutMs, 'qa-dom')
        .then((dom) => {
          try {
            mkdirSync(dirname(opts.outPath), { recursive: true })
            writeFileSync(opts.outPath, JSON.stringify(dom, null, 2), { mode: 0o600 })
          } catch {
            /* ignore */
          }
          try {
            opts.audit?.({ ok: true, path: opts.outPath })
          } catch {
            /* ignore */
          }
        })
        .catch((e) => {
          const miss = { ts: new Date().toISOString(), error: String(e) }
          try {
            mkdirSync(dirname(opts.outPath), { recursive: true })
            writeFileSync(opts.outPath, JSON.stringify(miss, null, 2), { mode: 0o600 })
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
