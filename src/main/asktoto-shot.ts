/**
 * FITO-185-L: optional ASKTOTO_SHOT feel capture — never races normal loadURL.
 *
 * FITO-185-K / K2 registered dump handlers before loadURL and either:
 * - fired on about:blank (isLoading false + truthy getURL), or
 * - consumed once('did-finish-load') for about:blank before the real index.html load,
 * - or dumped on ready-to-show before React/poster paint (solid #05010A).
 *
 * Safe path: listen only; gate on real renderer URL; delay ≥2s after that load; then
 * capturePage + DOM dump. Never replaces or blocks win.loadURL(rendererUrl).
 */
import { writeFileSync } from 'node:fs'

/** Minimum settle after a real renderer did-finish-load before capturePage/DOM dump. */
export const ASKTOTO_SHOT_DELAY_MS = 2000

/** Hard cap so hung capturePage/executeJavaScript under exclusive cannot pin main forever. */
export const ASKTOTO_SHOT_TIMEOUT_MS = 4000

export interface AskTotoShotTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  once(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  getURL(): string
  isDestroyed(): boolean
  isLoading?(): boolean
  executeJavaScript(source: string, userGesture?: boolean): Promise<unknown>
  capturePage(): Promise<{ toPNG(): Buffer }>
}

export interface BindAskTotoShotOptions {
  shotPath: string
  /** Same rendererUrl string passed to loadURL / bindRendererReadiness. */
  expectedUrl: string
  /** Override for tests; production uses ASKTOTO_SHOT_DELAY_MS (≥2000). */
  delayMs?: number
  now?: () => Date
  writeFile?: typeof writeFileSync
  setTimer?: typeof setTimeout
}

/** Reject about:blank / empty / unrelated navigations. */
export function isRealRendererShotUrl(url: string, expectedUrl: string): boolean {
  if (!url || !expectedUrl) return false
  if (url === 'about:blank') return false
  if (url.startsWith('about:')) return false
  // Strict match preferred (file:// asar / vite URL). Also accept when both end with index.html
  // in case of harmless trailing-slash drift.
  if (url === expectedUrl) return true
  try {
    const a = new URL(url)
    const b = new URL(expectedUrl)
    if (a.href === b.href) return true
    // Packaged: allow query/hash-less path equality when expected has no search.
    if (!b.search && a.origin === b.origin && a.pathname === b.pathname) return true
  } catch {
    /* not URL-parseable */
  }
  // Dev ELECTRON_RENDERER_URL may append ?shotbg=… while expectedUrl already includes it —
  // expectedUrl is built with those params; require index.html presence as a soft gate only when
  // expected is a substring prefix of url or vice versa for same document.
  if (url.includes('index.html') && expectedUrl.includes('index.html')) {
    const strip = (u: string): string => u.split('#')[0] ?? u
    return strip(url) === strip(expectedUrl)
  }
  return false
}

function appendErr(write: typeof writeFileSync, shotPath: string, line: string): void {
  try {
    write(`${shotPath}.err.txt`, `${line}\n`, { flag: 'a' })
  } catch {
    /* ignore */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
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

function dumpDomAndCapture(
  target: AskTotoShotTarget,
  shotPath: string,
  label: string,
  write: typeof writeFileSync,
  timeoutMs = ASKTOTO_SHOT_TIMEOUT_MS
): void {
  if (target.isDestroyed()) return
  try {
    write(`${shotPath}.${label}.started.txt`, `dump-started ${new Date().toISOString()}\n`)
  } catch {
    /* ignore */
  }
  const expr =
    "(() => { const bed = document.getElementById('boot-bed'); const bedImg = document.getElementById('boot-bed-img');" +
    " const root = document.getElementById('root');" +
    ' const bedStyle = bed ? getComputedStyle(bed) : null; return {' +
    ` label: ${JSON.stringify(label)},` +
    ' url: location.href, readyState: document.readyState, hasBed: !!bed, hasBedImg: !!bedImg,' +
    ' bed: bed && bedStyle ? { w: bed.offsetWidth, h: bed.offsetHeight, display: bedStyle.display,' +
    ' opacity: bedStyle.opacity, visibility: bedStyle.visibility, bg: bedStyle.backgroundColor,' +
    ' bgImage: bedStyle.backgroundImage.slice(0, 240) } : null,' +
    ' bedImg: bedImg ? { src: (bedImg.getAttribute("src") || "").slice(-120),' +
    ' w: bedImg.naturalWidth, h: bedImg.naturalHeight, complete: bedImg.complete } : null,' +
    ' rootChildren: root ? root.childElementCount : -1,' +
    ' rootHTML: root ? root.innerHTML.slice(0, 1200) : null,' +
    " bodyText: (document.body.innerText || '').slice(0, 800)," +
    " starting: /Starting\\s+M/i.test(document.body.innerText || '')," +
    " loadingCaption: /\\bLoading\\b/i.test(document.body.innerText || '')," +
    " onboard: !!document.querySelector('.onboard-stage, .onboard-exclusive-lock, [class*=onboard]')," +
    " portalOpen: !!document.querySelector('.onboard-stage--portal-open')," +
    " videos: [...document.querySelectorAll('video')].map(v => ({ src: (v.currentSrc || '').slice(-120)," +
    " poster: (v.poster || '').slice(-120), w: v.videoWidth, h: v.videoHeight, ready: v.readyState, paused: v.paused }))," +
    ' imgs: [...document.images].slice(0, 12).map(i => ({ src: (i.currentSrc || i.src || "").slice(-120),' +
    ' w: i.naturalWidth, h: i.naturalHeight, complete: i.complete })),' +
    ' inner: { w: innerWidth, h: innerHeight } }; })()'
  void withTimeout(target.executeJavaScript(expr, true), timeoutMs, `dom:${label}`)
    .then((dom: unknown) => {
      try {
        write(`${shotPath}.${label}.dom.json`, JSON.stringify(dom, null, 2))
      } catch (e) {
        appendErr(write, shotPath, `dom-write:${label}:${String(e)}`)
      }
    })
    .catch((e: unknown) => {
      appendErr(write, shotPath, `dom:${label}:${String(e)}`)
    })
  void withTimeout(target.capturePage(), timeoutMs, `capture:${label}`)
    .then((img) => {
      try {
        const labeled = shotPath.replace(/\.png$/i, '') + `-${label}.png`
        write(labeled, img.toPNG())
        if (label === 'after-load') write(shotPath, img.toPNG())
      } catch (e) {
        appendErr(write, shotPath, `write:${label}:${String(e)}`)
      }
    })
    .catch((e: unknown) => {
      appendErr(write, shotPath, `capture:${label}:${String(e)}`)
    })
}

/**
 * Register BEFORE loadURL (like bindRendererReadiness). Does not navigate.
 * Ignores about:blank and any load whose getURL !== expectedUrl.
 * After a matching did-finish-load, waits delayMs (≥2000) then dumps once.
 */
export function bindAskTotoShot(target: AskTotoShotTarget, opts: BindAskTotoShotOptions): void {
  const write = opts.writeFile ?? writeFileSync
  const setTimer = opts.setTimer ?? setTimeout
  const now = opts.now ?? (() => new Date())
  const delayMs = Math.max(ASKTOTO_SHOT_DELAY_MS, opts.delayMs ?? ASKTOTO_SHOT_DELAY_MS)
  const { shotPath, expectedUrl } = opts

  try {
    write(`${shotPath}.registered.txt`, `shot-registered ${now().toISOString()}\n`)
  } catch {
    /* ignore */
  }

  let armed = false
  const onLoaded = (): void => {
    if (target.isDestroyed()) return
    const url = target.getURL()
    if (!isRealRendererShotUrl(url, expectedUrl)) return
    if (armed) return
    armed = true
    try {
      write(
        `${shotPath}.loaded.txt`,
        `did-finish-load ${now().toISOString()} url=${url}\n`
      )
    } catch {
      /* ignore */
    }
    const timer = setTimer(() => {
      if (target.isDestroyed()) return
      if (!isRealRendererShotUrl(target.getURL(), expectedUrl)) return
      dumpDomAndCapture(target, shotPath, 'after-load', write)
    }, delayMs)
    // Don't keep the process alive solely for shot capture.
    ;(timer as NodeJS.Timeout).unref?.()
  }

  // Persistent listener: about:blank may finish first; we ignore until URL matches.
  target.on('did-finish-load', onLoaded)
}
