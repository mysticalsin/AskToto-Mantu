#!/usr/bin/env node
// C30 idle-render profile of the installed QA-identity app, inside _relay/goal-loop/sandbox-home/ only.
// Launches through the same guarded direct spawn as soak.mjs, lets the app settle with no meeting, then:
//   1. probes every page over loopback CDP: visibility, focus, running Web Animations (CSS animations and
//      transitions), canvases, requestAnimationFrame calls per second with their call sites, Performance metrics;
//   2. measures one-core CPU% per process kind over ps windows with CDP DISCONNECTED (as the soak idles);
//   3. optionally (--attribute) repeats the window with the page's CSS animations paused, then with
//      requestAnimationFrame disabled, so the idle cost is attributed to its source instead of guessed.
//
//   <isolate.sh> /bin/bash -c 'cd <checkout> && node scripts/qa/sandbox-acceptance/idle-profile.mjs --app <sandbox app>'
//
// Writes idle-profile-<runId>.json in the run's reports directory. Counts and selectors only, never page text.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep } from '../lib/app-driver.mjs'
import { assertWritableInSandbox, deriveSandboxRoot } from './guard.mjs'
import { CliError, EXIT_CODES, newRunId, parseCli, sandboxLayout } from './lib.mjs'
import { sampleTree } from './sampler.mjs'
import { guardReport, launchApp, prepareProfile } from './session.mjs'

export const CLI_SPEC = Object.freeze({
  app: { type: 'string' },
  'sandbox-root': { type: 'string' },
  'run-id': { type: 'string' },
  'settle-seconds': { type: 'number', default: 90, min: 10 },
  'window-seconds': { type: 'number', default: 60, min: 10 },
  'probe-seconds': { type: 'number', default: 5, min: 1 },
  attribute: { type: 'boolean', default: false },
  matrix: { type: 'string' },
  shots: { type: 'boolean', default: false },
  'ambient-seconds': { type: 'number', min: 10 },
  layout: { type: 'string', default: 'bar' },
  'dry-run': { type: 'boolean', default: false }
})

/** One-core CPU% per process kind between two samples of the same tree. */
export function cpuByKind(before, after, seconds) {
  const start = new Map(before.processes.map((entry) => [entry.pid, entry.cpuSeconds]))
  const out = {}
  let total = 0
  for (const entry of after.processes) {
    const from = start.get(entry.pid) ?? 0
    if (!Number.isFinite(entry.cpuSeconds)) continue
    const pct = ((entry.cpuSeconds - from) / seconds) * 100
    out[entry.kind] = Math.round(((out[entry.kind] ?? 0) + pct) * 100) / 100
    total += pct
  }
  return { ...out, total: Math.round(total * 100) / 100 }
}

/** In-page probe: what is rendering. Serialized into the page, so it must be self-contained. */
async function pageProbe(probeMs) {
  const describe = (node) => {
    if (!node || !node.tagName) return null
    const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).slice(0, 3).join('.') : ''
    const data = [...node.attributes].filter((attr) => attr.name.startsWith('data-')).map((attr) => attr.name)
    return `${node.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${data.length ? `[${data.slice(0, 3).join('][')}]` : ''}`
  }
  const out = {
    path: location.pathname + location.hash,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    viewport: [innerWidth, innerHeight],
    dpr: devicePixelRatio,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
  }
  out.animations = document.getAnimations().map((animation) => {
    const effect = animation.effect
    const timing = effect?.getComputedTiming?.() ?? {}
    return {
      kind: animation.constructor.name,
      name: animation.animationName ?? animation.transitionProperty ?? animation.id ?? '',
      playState: animation.playState,
      iterations: timing.iterations === Number.POSITIVE_INFINITY ? 'infinite' : timing.iterations,
      durationMs: timing.duration,
      target: describe(effect?.target),
      pseudo: effect?.pseudoElement ?? null
    }
  })
  out.canvases = [...document.querySelectorAll('canvas')].map((canvas) => {
    const rect = canvas.getBoundingClientRect()
    return {
      backing: [canvas.width, canvas.height],
      css: [Math.round(rect.width), Math.round(rect.height)],
      host: describe(canvas.parentElement),
      self: describe(canvas)
    }
  })
  const originalRaf = window.requestAnimationFrame
  const originalTimeout = window.setTimeout
  const rafSites = new Map()
  const timeoutSites = new Map()
  let rafCalls = 0
  let timeoutCalls = 0
  const site = (stack) =>
    String(stack ?? '')
      .split('\n')
      .slice(2, 4)
      .map((line) => line.trim().replace(/^at /, '').replace(/\?[^:)]*/, ''))
      .join(' < ')
  window.requestAnimationFrame = function countedRaf(callback) {
    rafCalls += 1
    const key = site(new Error().stack)
    rafSites.set(key, (rafSites.get(key) ?? 0) + 1)
    return originalRaf.call(window, callback)
  }
  window.setTimeout = function countedTimeout(...args) {
    timeoutCalls += 1
    const key = site(new Error().stack)
    timeoutSites.set(key, (timeoutSites.get(key) ?? 0) + 1)
    return originalTimeout.apply(window, args)
  }
  await new Promise((resolve) => originalTimeout(resolve, probeMs))
  window.requestAnimationFrame = originalRaf
  window.setTimeout = originalTimeout
  const top = (map) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([where, count]) => ({ where, count }))
  out.raf = { calls: rafCalls, perSecond: Math.round((rafCalls / (probeMs / 1000)) * 10) / 10, sites: top(rafSites) }
  out.setTimeout = {
    calls: timeoutCalls,
    perSecond: Math.round((timeoutCalls / (probeMs / 1000)) * 10) / 10,
    sites: top(timeoutSites)
  }
  return out
}

const METRIC_KEYS = ['ProcessTime', 'TaskDuration', 'ScriptDuration', 'LayoutCount', 'RecalcStyleCount', 'LayoutDuration']

async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(list.filter((entry) => METRIC_KEYS.includes(entry.name)).map((e) => [e.name, e.value]))
}

async function probeAll(session, probeMs) {
  return session.withPage(async (anyPage) => {
    const pages = anyPage
      .context()
      .browser()
      .contexts()
      .flatMap((context) => context.pages())
    const results = []
    for (const page of pages) {
      if (page.isClosed()) continue
      try {
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Performance.enable')
        const m0 = await metrics(cdp)
        const probe = await page.evaluate(pageProbe, probeMs)
        const m1 = await metrics(cdp)
        const delta = Object.fromEntries(METRIC_KEYS.map((key) => [key, Math.round((m1[key] - m0[key]) * 1000) / 1000]))
        await cdp.detach().catch(() => {})
        results.push({ ...probe, perfDeltaOverProbe: delta })
      } catch (error) {
        results.push({ error: String(error?.message ?? error).slice(0, 200) })
      }
    }
    return results
  })
}

/** Persistent in-page counters (idempotent): canvas paints (clearRect), rAF and setTimeout calls, focus/blur events. */
function counters(action) {
  const w = window
  if (!w.__idleCounters) {
    const c = { paints: 0, raf: 0, timeouts: 0, focus: 0, blur: 0 }
    w.__idleCounters = c
    const raf = w.requestAnimationFrame.bind(w)
    w.requestAnimationFrame = (callback) => {
      c.raf += 1
      return raf(callback)
    }
    const timeout = w.setTimeout.bind(w)
    w.setTimeout = (...args) => {
      c.timeouts += 1
      return timeout(...args)
    }
    const clear = CanvasRenderingContext2D.prototype.clearRect
    CanvasRenderingContext2D.prototype.clearRect = function countedClear(...args) {
      c.paints += 1
      return clear.apply(this, args)
    }
    w.addEventListener('focus', () => {
      c.focus += 1
    })
    w.addEventListener('blur', () => {
      c.blur += 1
    })
  }
  if (action === 'blur') w.dispatchEvent(new Event('blur'))
  return { ...w.__idleCounters, at: performance.now(), hasFocus: document.hasFocus() }
}

async function readCounters(session, action = 'read') {
  return session.withPage((page) => page.evaluate(counters, action)).catch((error) => ({ error: String(error?.message ?? error) }))
}

/** Per-second rates between two counter reads. */
export function counterRates(before, after) {
  if (!before || !after || before.error || after.error) return null
  const seconds = (after.at - before.at) / 1000
  const rate = (key) => Math.round(((after[key] - before[key]) / seconds) * 10) / 10
  return {
    seconds: Math.round(seconds),
    orbPaintsPerSecond: rate('paints'),
    rafPerSecond: rate('raf'),
    timeoutsPerSecond: rate('timeouts'),
    focusEvents: after.focus - before.focus,
    blurEvents: after.blur - before.blur,
    hasFocusAfter: after.hasFocus
  }
}

async function cpuWindow(session, appPath, seconds) {
  const before = sampleTree({ mainPid: session.pid, installRoot: appPath })
  await sleep(seconds * 1000)
  const after = sampleTree({ mainPid: session.pid, installRoot: appPath })
  return cpuByKind(before, after, seconds)
}

/** Interventions for --attribute. Each runs in every page and stays in effect until quit. */
const INTERVENTIONS = {
  pauseCssAnimations: () => {
    const paused = document.getAnimations().filter((animation) => animation.playState === 'running')
    for (const animation of paused) animation.pause()
    return paused.length
  },
  resumeCssAnimations: () => {
    const resumed = document.getAnimations().filter((animation) => animation.playState === 'paused')
    for (const animation of resumed) animation.play()
    return resumed.length
  },
  disableRaf: () => {
    window.requestAnimationFrame = () => 0
    return 1
  }
}

/** --matrix: one page-wide variant. rafFps caps every rAF loop (null restores it); css overrides via one style tag. */
function applyVariant({ rafFps, css }) {
  const w = window
  w.__idleProfile ??= { raf: w.requestAnimationFrame.bind(w), last: 0 }
  const state = w.__idleProfile
  if (rafFps == null) w.requestAnimationFrame = state.raf
  else {
    const interval = 1000 / rafFps
    w.requestAnimationFrame = (callback) =>
      state.raf(function step(ts) {
        if (ts - state.last >= interval - 1) {
          state.last = ts
          callback(ts)
        } else state.raf(step)
      })
  }
  let style = document.getElementById('idle-profile-override')
  if (!style) {
    style = document.createElement('style')
    style.id = 'idle-profile-override'
    document.head.append(style)
  }
  style.textContent = css ?? ''
  return 1
}

async function variant(session, args) {
  return session.withPage(async (anyPage) => {
    const pages = anyPage
      .context()
      .browser()
      .contexts()
      .flatMap((context) => context.pages())
    let count = 0
    for (const page of pages) count += await page.evaluate(applyVariant, args).catch(() => 0)
    return count
  })
}

const BREATHE_PAUSED = '.aw-hidden-rainbow::before{animation-play-state:paused!important}'
const NO_BACKDROP = '*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}'
export const MATRICES = Object.freeze({
  variants: [
    { label: 'orb-60fps', rafFps: 60, css: '' },
    { label: 'orb-30fps', rafFps: 30, css: '' },
    { label: 'breathe-paused', rafFps: null, css: BREATHE_PAUSED },
    { label: 'breathe-steps24', rafFps: null, css: '.aw-hidden-rainbow::before{animation-timing-function:steps(24)!important}' },
    { label: 'orb-30fps+breathe-paused', rafFps: 30, css: BREATHE_PAUSED },
    { label: 'restored', rafFps: null, css: '' }
  ],
  // Per-frame cost at a fixed 30 fps orb with the breathe paused: which layer makes each frame expensive.
  cost: [
    { label: 'control', rafFps: 30, css: BREATHE_PAUSED },
    { label: 'no-backdrop', rafFps: 30, css: BREATHE_PAUSED + NO_BACKDROP },
    { label: 'no-halo-shadow', rafFps: 30, css: `${BREATHE_PAUSED}.aw-hidden-rainbow{box-shadow:none!important}` },
    { label: 'no-rim', rafFps: 30, css: `${BREATHE_PAUSED}.aw-hidden-rainbow::before{display:none!important}` },
    { label: 'canvas-layer', rafFps: 30, css: `${BREATHE_PAUSED}.aw-orb__canvas{will-change:transform}` },
    { label: 'orb-frozen', rafFps: 0.001, css: BREATHE_PAUSED }
  ]
})

const FREEZE = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important}'

/** Pixel difference of two PNG screenshots (RGBA). */
async function pixelDiff(a, b) {
  const { default: sharp } = await import('sharp')
  const [ra, rb] = await Promise.all([a, b].map((png) => sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })))
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return { sameSize: false }
  let differing = 0
  let maxDelta = 0
  for (let i = 0; i < ra.data.length; i += 4) {
    let delta = 0
    for (let c = 0; c < 4; c += 1) delta = Math.max(delta, Math.abs(ra.data[i + c] - rb.data[i + c]))
    if (delta > 0) differing += 1
    maxDelta = Math.max(maxDelta, delta)
  }
  return { sameSize: true, width: ra.info.width, height: ra.info.height, differingPixels: differing, maxChannelDelta: maxDelta }
}

/** Frozen screenshots: the control frame against each candidate css, so a cost cut is proven pixel-identical or not. */
async function screenshotDiffs(session, candidates, outDir) {
  return session.withPage(async (page) => {
    await page.evaluate(applyVariant, { rafFps: 0.001, css: FREEZE })
    await sleep(1_000)
    const shoot = async (css, name) => {
      await page.evaluate(applyVariant, { rafFps: 0.001, css: FREEZE + css })
      await sleep(1_000)
      const png = await page.screenshot({ omitBackground: true })
      writeFileSync(join(outDir, `${name}.png`), png)
      return png
    }
    const control = await shoot('', 'shot-control')
    const control2 = await shoot('', 'shot-control-repeat')
    const out = { controlRepeat: await pixelDiff(control, control2) }
    for (const [name, css] of Object.entries(candidates)) out[name] = await pixelDiff(control, await shoot(css, `shot-${name}`))
    await page.evaluate(applyVariant, { rafFps: null, css: '' })
    return out
  })
}

async function intervene(session, name) {
  return session.withPage(async (anyPage) => {
    const pages = anyPage
      .context()
      .browser()
      .contexts()
      .flatMap((context) => context.pages())
    let count = 0
    for (const page of pages) count += await page.evaluate(INTERVENTIONS[name]).catch(() => 0)
    return count
  })
}

async function main(argv) {
  let values
  try {
    values = parseCli(argv, CLI_SPEC)
  } catch (error) {
    console.error(`[idle-profile] ${error.message}`)
    return EXIT_CODES.PRECONDITION
  }
  const sandboxRoot =
    values['sandbox-root'] ??
    process.env.METIS_SANDBOX_ROOT ??
    deriveSandboxRoot(process.env.HOME) ??
    deriveSandboxRoot(process.env.ASKTOTO_USERDATA)
  if (!sandboxRoot) {
    console.error('[idle-profile] cannot derive the sandbox root: run through isolate.sh or pass --sandbox-root')
    return EXIT_CODES.PRECONDITION
  }
  const runId = values['run-id'] ?? newRunId()
  if (!/^[A-Za-z0-9-]{1,16}$/.test(runId)) throw new CliError('--run-id must be 1-16 characters of letters, digits and -')
  const layout = sandboxLayout({ sandboxRoot, runId })
  const appPath = values.app ?? join(layout.appsDir, 'Metis QA.app')
  const guards = guardReport({ layout, appPath, parentEnv: process.env })
  for (const check of guards.checks) console.log(`[guard] ${check.ok ? 'ok  ' : 'FAIL'} ${check.id}: ${check.detail}`)
  if (!guards.ok) return EXIT_CODES.PRECONDITION
  if (values['dry-run']) return EXIT_CODES.PASS
  assertWritableInSandbox(layout.reportsDir, layout.sandboxRoot)
  mkdirSync(layout.reportsDir, { recursive: true })
  const log = (line) => console.log(`[idle-profile] ${line}`)
  const report = { schema: 'idle-profile/1', runId, appPath, startedAt: new Date().toISOString(), config: values }
  if (!['bar', 'hide', 'island'].includes(values.layout)) throw new CliError('--layout must be bar, hide or island')
  // Seeds the profile once (first launch of this run id); the soak's default seed is the 'bar' layout.
  prepareProfile(layout, { overlayLayout: values.layout })
  report.layout = values.layout
  const session = await launchApp({ layout, appPath, parentEnv: process.env, connect: false, log })
  try {
    log(`settling ${values['settle-seconds']} s with no CDP session`)
    await sleep(values['settle-seconds'] * 1000)
    report.probe = await probeAll(session, values['probe-seconds'] * 1000)
    log(`probe: ${JSON.stringify(report.probe.map((page) => ({ raf: page.raf?.perSecond, timers: page.setTimeout?.perSecond, animations: page.animations?.map((a) => `${a.name}:${a.playState}`), vis: page.visibilityState, focus: page.hasFocus })))}`)
    await sleep(5_000)
    report.windows = []
    const measure = async (label, seconds = values['window-seconds'], action = 'read') => {
      const before = await readCounters(session, action)
      const cpu = await cpuWindow(session, appPath, seconds)
      const page = counterRates(before, await readCounters(session))
      report.windows.push({ label, seconds, cpuOneCorePct: cpu, page })
      log(`${label}: ${JSON.stringify(cpu)} page ${JSON.stringify(page)}`)
    }
    await measure('baseline')
    if (values['ambient-seconds']) {
      // The harness cannot move OS focus without AppleScript, so the overlay's own blur signal is dispatched in-page
      // (the state of a user working in another app). Labelled as simulated; the focus/blur counters show whether it held.
      await measure('ambient-simulated-blur', values['ambient-seconds'], 'blur')
    }
    if (values.matrix) {
      const matrix = MATRICES[values.matrix]
      if (!matrix) throw new CliError(`--matrix must be one of ${Object.keys(MATRICES).join(', ')}`)
      for (const entry of matrix) {
        await variant(session, entry)
        await sleep(3_000)
        await measure(entry.label)
      }
    }
    if (values.shots) {
      report.screenshots = await screenshotDiffs(
        session,
        { 'no-backdrop': NO_BACKDROP, 'breathe-paused': BREATHE_PAUSED },
        layout.reportsDir
      )
      log(`screenshots: ${JSON.stringify(report.screenshots)}`)
    }
    if (values.attribute) {
      report.interventions = {}
      report.interventions.pauseCssAnimations = await intervene(session, 'pauseCssAnimations')
      await measure('css-animations-paused')
      report.interventions.resumeCssAnimations = await intervene(session, 'resumeCssAnimations')
      report.interventions.disableRaf = await intervene(session, 'disableRaf')
      await measure('raf-disabled')
      report.interventions.pauseCssAnimations2 = await intervene(session, 'pauseCssAnimations')
      await measure('raf-disabled-and-css-paused')
    }
  } finally {
    report.quit = await session.quit().catch((error) => ({ error: String(error?.message ?? error) }))
    if (!report.quit || report.quit.error) await session.kill().catch(() => {})
  }
  report.finishedAt = new Date().toISOString()
  const file = join(layout.reportsDir, `idle-profile-${runId}.json`)
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  log(`wrote ${file}`)
  return EXIT_CODES.PASS
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[idle-profile] ${error?.stack ?? error}`)
      process.exit(EXIT_CODES.FAIL ?? 1)
    }
  )
}
