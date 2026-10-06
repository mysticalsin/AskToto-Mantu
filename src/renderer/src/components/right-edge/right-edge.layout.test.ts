import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'
import type { MetisCommandState, TranscriptLine } from '@shared/ipc'
import { readerRect, type Rect } from '@shared/right-edge-geometry'
import { ConfirmSheet } from '../../ui/ConfirmSheet'
import { RIGHT_EDGE_STRINGS, rightEdgeStrings, type RightEdgeStrings } from '../../lib/right-edge/strings'
import { contrastRatio, parseCssColor, requiredContrast, textContrast, type Rgba } from '../../lib/right-edge/contrast'
import {
  RIGHT_EDGE_READER_KINDS,
  RightEdgeReader,
  RightEdgeReaderDetails,
  RightEdgeReaderTranscript,
  readerKindForView,
  type RightEdgeReaderKind,
  type RightEdgeReaderMeeting,
  type RightEdgeReaderTone
} from './RightEdgeReader'

// M2-0202 S3 (spec v3 §6, §13 RE-L01 Reader rows, RE-L05): the Reader rendered at readerRect with the app's
// compiled stylesheet (out/renderer/assets/index-*.css, written by `npm run build`, which CI runs before
// `npm test`) in Chromium. A missing stylesheet fails the suite: these rows never run unstyled.
//
// Each row passes:
//   (c) nothing is clipped: no element hides overflow it has, nothing leaves the window sideways;
//   (d) WCAG AA contrast for every text in the Reader over its composited background (contrast.ts);
//   (e) every Reader control is at least 24x24 CSS px (WCAG 2.5.8);
//   (f) the Reader fills its window, and with its scroller at the end its header controls are still on
//       screen and on top;
// and the page has exactly one scroll container, [data-re-reader-scroll].

const REPO = resolve(__dirname, '../../../../..')
const ASSETS = join(REPO, 'out', 'renderer', 'assets')
const RENDERER_SRC = resolve(__dirname, '../..')

function compiledAppCss(): string {
  const files = existsSync(ASSETS) ? readdirSync(ASSETS).filter((name) => /^index-.*\.css$/.test(name)) : []
  if (files.length === 0)
    throw new Error(`no compiled index-*.css under ${ASSETS}: run \`npm run build\` before the layout tests`)
  return files.map((name) => readFileSync(join(ASSETS, name), 'utf8')).join('\n')
}

/** The work areas the Reader rows run at: the floor sizes, the macOS row and the smallest the right edge serves. */
const WORK_AREAS: Rect[] = [
  { x: 0, y: 0, width: 853, height: 432 },
  { x: 0, y: 0, width: 1024, height: 528 },
  { x: 0, y: 25, width: 1280, height: 626 },
  { x: 0, y: 0, width: 384, height: 432 }
]

const EN = RIGHT_EDGE_STRINGS.en
const FR = RIGHT_EDGE_STRINGS.fr

const words = (n: number, seed: string): string =>
  Array.from({ length: n }, (_, i) => `${seed}${i % 7 === 0 ? 'ification' : ''}`).join(' ')

const transcriptLines = (count: number): TranscriptLine[] =>
  Array.from({ length: count }, (_, i) => ({
    speaker: i % 3 === 0 ? 'you' : 'them',
    text: `Synthetic line ${i}: ${words(18, 'roadmap')}`,
    t: i * 1000
  }))

const NO_COMMAND: MetisCommandState = { proposalId: null }
const PENDING: MetisCommandState = { proposalId: 'proposal-fixture' }

const MEETING: RightEdgeReaderMeeting = { startedAt: Date.now() - 754_000, paused: false, pausedMs: 0, pausedAt: null }

/** A full view's body shape: headings, paragraphs, a list of row buttons and a nested scroll box of its own. */
function viewFixture(view: string, rows: number): ReactNode {
  return createElement(
    'div',
    { 'data-fixture-view': view, className: 'flex flex-col gap-2' },
    createElement('h2', { className: 'm-0 text-[14px] font-semibold' }, `${view} fixture`),
    createElement('p', null, words(40, 'synthetic')),
    createElement(
      'div',
      { className: 'scroll-thin max-h-32 overflow-y-auto' },
      Array.from({ length: rows }, (_, i) =>
        createElement('p', { key: i, className: 'm-0' }, `Row ${i} ${words(12, 'entry')}`)
      )
    ),
    createElement('pre', null, `const synthetic = "${'x'.repeat(240)}"`)
  )
}

interface Row {
  id: string
  kind: RightEdgeReaderKind
  tone: RightEdgeReaderTone
  strings: RightEdgeStrings
  body: ReactNode
  meeting?: RightEdgeReaderMeeting
  sheet?: boolean
  /** The content is taller than every Reader rect, so its scroller must scroll (the Details may fit). */
  long: boolean
}

const ROWS: Row[] = [
  {
    id: 'R30 full answer',
    kind: 'answer',
    tone: 'ready',
    strings: EN,
    long: true,
    body: createElement('div', { 'data-fixture-view': 'answer' }, viewFixture('answer', 30))
  },
  {
    id: 'R31 live transcript',
    kind: 'transcript',
    tone: 'listening',
    strings: EN,
    long: true,
    meeting: MEETING,
    body: createElement(RightEdgeReaderTranscript, { lines: transcriptLines(80), strings: EN })
  },
  { id: 'R33 History', kind: 'history', tone: 'ready', strings: EN, long: true, body: viewFixture('history', 40) },
  {
    id: 'R33 Review with its ConfirmSheet',
    kind: 'review',
    tone: 'ready',
    strings: EN,
    long: true,
    body: viewFixture('review', 40),
    sheet: true
  },
  { id: 'R33 Agenda', kind: 'agenda', tone: 'ready', strings: EN, long: true, body: viewFixture('agenda', 30) },
  { id: 'R33 Brain', kind: 'brain', tone: 'thinking', strings: EN, long: true, body: viewFixture('brain', 30) },
  {
    id: 'R33 Details (error)',
    kind: 'details',
    tone: 'ready',
    strings: EN,
    long: false,
    body: createElement(RightEdgeReaderDetails, {
      commandState: NO_COMMAND,
      errors: [words(60, 'failure')],
      strings: EN
    })
  },
  {
    id: 'live meeting + pending approval',
    kind: 'details',
    tone: 'attention',
    strings: EN,
    long: false,
    meeting: MEETING,
    body: createElement(RightEdgeReaderDetails, {
      commandState: PENDING,
      errors: [words(20, 'microphone')],
      strings: EN
    })
  },
  {
    id: 'live meeting + pending approval (FR)',
    kind: 'history',
    tone: 'attention',
    strings: FR,
    long: true,
    meeting: MEETING,
    body: viewFixture('history', 40)
  }
]

function rowMarkup(row: Row): string {
  const reader = createElement(
    RightEdgeReader,
    {
      kind: row.kind,
      strings: row.strings,
      tone: row.tone,
      onAttention: () => undefined,
      meeting: row.meeting ?? null,
      consentDot: row.meeting !== undefined,
      onBack: () => undefined,
      onHide: () => undefined
    },
    row.body
  )
  const sheet = row.sheet
    ? createElement(ConfirmSheet, {
        request: {
          id: 1,
          title: 'Save recap changes?',
          message: 'You have unsaved edits to this recap.',
          destructive: true
        },
        onChoose: () => undefined
      })
    : null
  // The App root on the right edge: `relative flex w-full flex-col gap-2 h-full min-h-0 p-0`.
  return renderToStaticMarkup(
    createElement('div', { className: 'relative flex h-full min-h-0 w-full flex-col gap-2 p-0' }, sheet, reader)
  )
}

/** The overlay page: the compiled stylesheet makes html, body and #root fill the native window. */
function pageHtml(markup: string, css: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root">${markup}</div></body></html>`
}

interface TextSample {
  label: string
  fg: string
  layers: string[]
  bgImage: boolean
  opacity: number
  fontSizePx: number
  fontWeight: number
}

interface Probe {
  viewport: { width: number; height: number }
  reader: { left: number; top: number; width: number; height: number } | null
  docScrollWidth: number
  scrollers: string[]
  scrollerOverflows: boolean
  clipped: string[]
  outside: string[]
  texts: TextSample[]
  targets: Array<{ label: string; width: number; height: number }>
  headerAfterScroll: Array<{ label: string; inView: boolean; onTop: boolean }>
  island: number
  views: Array<{ view: string; inReader: boolean }>
  timer: boolean
  consentDot: boolean
  attention: boolean
}

const probe = (page: Page, sheet: boolean): Promise<Probe> =>
  page.evaluate((sheetOpen: boolean) => {
    const label = (el: Element): string => {
      const cls =
        typeof el.className === 'string' && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : ''
      return `${el.tagName.toLowerCase()}${cls} "${(el.textContent ?? '').trim().slice(0, 32)}"`
    }
    const reader = document.querySelector('[data-re-surface="reader"]')
    const all = Array.from(document.querySelectorAll('*'))
    const scrollers = all
      .filter((el) => {
        const s = getComputedStyle(el)
        return ['auto', 'scroll'].includes(s.overflowY) || ['auto', 'scroll'].includes(s.overflowX)
      })
      .map((el) => (el.hasAttribute('data-re-reader-scroll') ? '[data-re-reader-scroll]' : label(el)))
    const scroller = document.querySelector<HTMLElement>('[data-re-reader-scroll]')
    const inside = reader ? Array.from(reader.querySelectorAll('*')).concat(reader) : []
    const clipped: string[] = []
    const outside: string[] = []
    for (const el of inside) {
      if (!(el instanceof HTMLElement)) continue
      const s = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      const hides = (v: string): boolean => v === 'hidden' || v === 'clip'
      if (hides(s.overflowX) && el.scrollWidth > el.clientWidth + 1) clipped.push(`clipped-x ${label(el)}`)
      if (el !== scroller && hides(s.overflowY) && el.scrollHeight > el.clientHeight + 1)
        clipped.push(`clipped-y ${label(el)}`)
      if (r.left < -1 || r.right > window.innerWidth + 1) outside.push(label(el))
    }
    const texts = inside
      .filter((el) =>
        Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0)
      )
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility === 'visible'
      })
      .map((el) => {
        const layers: string[] = []
        let bgImage = false
        let opacity = 1
        for (let node: Element | null = el; node; node = node.parentElement) {
          const s = getComputedStyle(node)
          opacity *= Number(s.opacity)
          if (node === el || reader?.contains(node) || node === reader) {
            if (s.backgroundImage !== 'none') bgImage = true
            layers.unshift(s.backgroundColor)
          }
          if (node === reader) break
        }
        const s = getComputedStyle(el)
        return {
          label: label(el),
          fg: s.color,
          layers,
          bgImage,
          opacity,
          fontSizePx: Number.parseFloat(s.fontSize),
          fontWeight: Number(s.fontWeight)
        }
      })
    const controls = reader
      ? Array.from(
          reader.querySelectorAll('.re-reader__header button, [data-re-reader-jump], .re-reader__details button')
        )
      : []
    const targets = controls.map((el) => {
      const r = el.getBoundingClientRect()
      return { label: label(el), width: r.width, height: r.height }
    })
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    const header = reader ? Array.from(reader.querySelectorAll('.re-reader__header > *')) : []
    const headerAfterScroll = header.map((el) => {
      const r = el.getBoundingClientRect()
      const inView =
        r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { label: label(el), inView, onTop: sheetOpen || (hit !== null && (hit === el || el.contains(hit))) }
    })
    const box = reader?.getBoundingClientRect()
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      reader: box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null,
      docScrollWidth: document.documentElement.scrollWidth,
      scrollers,
      scrollerOverflows: scroller ? scroller.scrollHeight > scroller.clientHeight : false,
      clipped,
      outside,
      texts,
      targets,
      headerAfterScroll,
      island: document.querySelectorAll('[data-re-island]').length,
      views: Array.from(document.querySelectorAll('[data-fixture-view]')).map((el) => ({
        view: el.getAttribute('data-fixture-view') ?? '',
        inReader: el.closest('[data-re-surface="reader"]') !== null
      })),
      timer: reader !== null && reader.querySelector('.re-reader__header [data-re-reader-timer]') !== null,
      consentDot: reader !== null && reader.querySelector('[data-re-reader-timer] [data-re-consent-dot]') !== null,
      attention:
        reader !== null &&
        reader.querySelector('.re-reader__header button[data-re-status][data-re-tone="attention"]') !== null
    }
  }, sheet)

function contrastFailures(texts: TextSample[]): string[] {
  const failures: string[] = []
  for (const t of texts) {
    if (t.bgImage) {
      failures.push(`${t.label}: background image behind the text`)
      continue
    }
    const fg = parseCssColor(t.fg)
    const layers = t.layers.map(parseCssColor)
    if (!fg || layers.some((layer) => layer === null)) {
      failures.push(`${t.label}: unparsed colour ${t.fg} over ${t.layers.join(' | ')}`)
      continue
    }
    const ratio = textContrast([fg[0], fg[1], fg[2], fg[3] * t.opacity], layers as Rgba[], [0, 0, 0])
    const required = requiredContrast(t)
    if (ratio < required) failures.push(`${t.label}: ${ratio.toFixed(2)} < ${required}`)
  }
  return failures
}

describe('right-edge Reader pure parts (M2-0202 S3)', () => {
  it('RE-L05: History, Review, Agenda and Brain are Reader kinds; Settings and the answer views are not', () => {
    expect(readerKindForView('history')).toBe('history')
    expect(readerKindForView('review')).toBe('review')
    expect(readerKindForView('agenda')).toBe('agenda')
    expect(readerKindForView('brain')).toBe('brain')
    for (const view of ['answer', 'copilot', 'settings']) expect(readerKindForView(view), view).toBeNull()
    expect(RIGHT_EDGE_READER_KINDS).toEqual(['answer', 'transcript', 'history', 'review', 'agenda', 'brain', 'details'])
  })

  it('the Reader copy exists in English and French with the same keys; a French tag picks French', () => {
    expect(Object.keys(FR).sort()).toEqual(Object.keys(EN).sort())
    for (const [key, value] of Object.entries(FR)) expect(value.trim(), key).not.toBe('')
    expect(rightEdgeStrings('fr-CA')).toBe(FR)
    expect(rightEdgeStrings('en-GB')).toBe(EN)
    expect(rightEdgeStrings(undefined)).toBe(EN)
    // Label in Name (WCAG 2.5.3): every control's visible words are inside its accessible name.
    for (const s of [EN, FR]) {
      const visible = (text: string): string => text.replace(/[←↗]/g, '').trim().toLowerCase()
      expect(s.backToIslandName.toLowerCase()).toContain(visible(s.backToIsland))
      expect(s.hideName.toLowerCase()).toContain(visible(s.hide))
      expect(s.statusAttentionName.toLowerCase()).toContain(visible(s.statusAttention))
      expect(s.openReaderName.toLowerCase()).toContain(visible(s.openReader))
    }
  })

  it('contrast.ts follows WCAG: 21:1 black on white, alpha composited, 3:1 for large text', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5)
    expect(parseCssColor('rgba(255, 255, 255, 0.5)')).toEqual([255, 255, 255, 0.5])
    expect(parseCssColor('rgb(22 22 27 / 50%)')).toEqual([22, 22, 27, 0.5])
    expect(parseCssColor('color(srgb 1 1 1)')).toBeNull()
    expect(textContrast([255, 255, 255, 1], [[0, 0, 0, 0.5]], [255, 255, 255])).toBeCloseTo(
      contrastRatio([255, 255, 255], [128, 128, 128]),
      1
    )
    expect(requiredContrast({ fontSizePx: 13, fontWeight: 400 })).toBe(4.5)
    expect(requiredContrast({ fontSizePx: 19, fontWeight: 700 })).toBe(3)
    expect(requiredContrast({ fontSizePx: 24, fontWeight: 400 })).toBe(3)
  })
})

describe('right-edge Reader layout at readerRect on the compiled stylesheet (M2-0202 S3, RE-L01 Reader rows)', () => {
  let browser: Browser
  let page: Page
  let css = ''

  beforeAll(async () => {
    css = compiledAppCss()
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('the compiled stylesheet carries the Reader rules', () => {
    expect(css).toMatch(/\.re-reader__scroll\s*\{[^}]*overflow/)
    expect(css).toMatch(/\[data-re-reader-scroll\]|\.re-reader__scroll/)
  })

  for (const area of WORK_AREAS) {
    const rect = readerRect(area)
    for (const scheme of ['dark', 'light'] as const) {
      it(`${area.width}x${area.height} (Reader ${rect.width}x${rect.height}, ${scheme}): every row passes (c)-(f) with exactly one scroller`, async () => {
        await page.setViewportSize({ width: rect.width, height: rect.height })
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        for (const row of ROWS) {
          await page.setContent(pageHtml(rowMarkup(row), css), { waitUntil: 'domcontentloaded' })
          const p = await probe(page, row.sheet === true)
          const where = `${row.id} @ ${rect.width}x${rect.height} ${scheme}`
          expect(p.reader, where).not.toBeNull()
          // Exactly one scroller, and it is the Reader's; a hosted view's own scroll box grows into it.
          expect(p.scrollers, where).toEqual(['[data-re-reader-scroll]'])
          if (row.long) expect(p.scrollerOverflows, `${where}: the long fixture scrolls in the one scroller`).toBe(true)
          // RE-L05: the full views mount under the Reader, and no island is rendered beside it.
          expect(p.island, where).toBe(0)
          expect(
            p.views.every((v) => v.inReader),
            where
          ).toBe(true)
          // (c)
          expect(p.clipped, where).toEqual([])
          expect(p.outside, where).toEqual([])
          expect(p.docScrollWidth, where).toBeLessThanOrEqual(p.viewport.width)
          // (d)
          expect(contrastFailures(p.texts), where).toEqual([])
          // (e)
          // ← Island and Hide always; the attention status control and a pending action's Cancel when present.
          expect(p.targets.length, where).toBeGreaterThanOrEqual(2)
          for (const target of p.targets) {
            expect(target.width, `${where} ${target.label}`).toBeGreaterThanOrEqual(24)
            expect(target.height, `${where} ${target.label}`).toBeGreaterThanOrEqual(24)
          }
          // (f)
          expect(p.reader, where).toEqual({ left: 0, top: 0, width: rect.width, height: rect.height })
          for (const control of p.headerAfterScroll) {
            expect(control.inView, `${where} ${control.label}`).toBe(true)
            expect(control.onTop, `${where} ${control.label}`).toBe(true)
          }
          // The Reader header: the meeting timer with its consent dot while live, the attention status control.
          expect(p.timer, where).toBe(row.meeting !== undefined)
          expect(p.consentDot, where).toBe(row.meeting !== undefined)
          expect(p.attention, where).toBe(row.tone === 'attention')
        }
      }, 120_000)
    }
  }
})

// The Reader's runtime behaviour, hydrated in Chromium: the live transcript follows its newest line, a reader
// scrolled back gets "Jump to live", and a Reader closed and reopened comes back at its scroll position.
const HARNESS_ID = '\0right-edge-reader-harness'
const modulePath = (path: string): string => JSON.stringify(resolve(RENDERER_SRC, path).replace(/\\/g, '/'))
const HARNESS = `
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { RightEdgeReader, RightEdgeReaderTranscript } from ${modulePath('components/right-edge/RightEdgeReader')}
import { RIGHT_EDGE_STRINGS } from ${modulePath('lib/right-edge/strings')}

const strings = RIGHT_EDGE_STRINGS.en
const memory = { current: {} }
const line = (i) => ({ speaker: i % 2 ? 'them' : 'you', text: 'Synthetic line ' + i + ' about the plan and the next steps for the team.', t: i })
const root = createRoot(document.getElementById('root'))
let state = { mounted: true, kind: 'transcript', count: 40 }
const body = () => state.kind === 'transcript'
  ? createElement(RightEdgeReaderTranscript, { lines: Array.from({ length: state.count }, (_, i) => line(i)), strings })
  : createElement('div', null, Array.from({ length: 80 }, (_, i) => createElement('p', { key: i }, 'Synthetic answer paragraph ' + i)))
const render = () => flushSync(() => root.render(state.mounted
  ? createElement(RightEdgeReader, { kind: state.kind, strings, tone: 'listening', onBack: () => {}, onHide: () => {}, liveCount: state.count, scrollMemory: memory }, body())
  : null))
window.__reader = { set: (patch) => { state = { ...state, ...patch }; render() } }
render()
`

async function bundleHarness(): Promise<{ js: string; css: string }> {
  const rendererRoot = resolve(RENDERER_SRC, '..')
  const output = (await build({
    root: rendererRoot,
    configFile: false,
    logLevel: 'silent',
    define: { __METIS_FEEDBACK_EMAIL__: '""', __METIS_QA_IDENTITY__: 'false' },
    resolve: { alias: { '@': RENDERER_SRC, '@shared': resolve(rendererRoot, '../shared') } },
    plugins: [
      react(),
      {
        name: 'right-edge-reader-harness',
        resolveId: (id) => (id === HARNESS_ID ? id : null),
        load: (id) => (id === HARNESS_ID ? HARNESS : null)
      }
    ],
    build: {
      write: false,
      minify: false,
      cssCodeSplit: false,
      rollupOptions: { input: HARNESS_ID, output: { format: 'iife', inlineDynamicImports: true } }
    }
  })) as Rollup.RollupOutput | Rollup.RollupOutput[]
  const files = (Array.isArray(output) ? output : [output]).flatMap((result) => result.output)
  const js = files
    .filter((file): file is Rollup.OutputChunk => file.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n')
  const css = files
    .filter((file): file is Rollup.OutputAsset => file.type === 'asset' && file.fileName.endsWith('.css'))
    .map((asset) => String(asset.source))
    .join('\n')
  return { js, css }
}

describe('right-edge Reader behaviour (M2-0202 S3)', () => {
  let browser: Browser
  let page: Page
  const rect = readerRect({ x: 0, y: 0, width: 1024, height: 528 })

  beforeAll(async () => {
    const { js, css } = await bundleHarness()
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: rect.width, height: rect.height } })
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body style="margin:0"><div id="root" style="position:relative;width:${rect.width}px;height:${rect.height}px"></div></body></html>`
    )
    await page.addScriptTag({ content: `window.toto = {};\n${js}` })
    await page.waitForSelector('[data-re-reader-scroll]')
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
  })

  const set = (patch: { mounted?: boolean; kind?: string; count?: number }): Promise<void> =>
    page.evaluate((next) => (window as unknown as { __reader: { set(p: object): void } }).__reader.set(next), patch)
  const frames = (): Promise<void> =>
    page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  const scroll = (): Promise<{ top: number; end: boolean; jump: boolean }> =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-re-reader-scroll]')!
      return {
        top: el.scrollTop,
        end: el.scrollHeight - el.scrollTop - el.clientHeight <= 1,
        jump: document.querySelector('[data-re-reader-jump]') !== null
      }
    })
  const scrollTo = async (top: number): Promise<void> => {
    await page.evaluate((y) => {
      document.querySelector<HTMLElement>('[data-re-reader-scroll]')!.scrollTop = y
    }, top)
    await frames()
  }

  it('the live transcript opens at its newest line and follows each new one', async () => {
    expect(await scroll()).toMatchObject({ end: true, jump: false })
    await set({ count: 41 })
    await set({ count: 42 })
    expect(await scroll()).toMatchObject({ end: true, jump: false })
  })

  it('scrolled back, a new line leaves the text where it is and offers "Jump to live", which returns to it', async () => {
    await scrollTo(0)
    await set({ count: 43 })
    await frames()
    expect(await scroll()).toEqual({ top: 0, end: false, jump: true })
    await page.getByRole('button', { name: 'Jump to live' }).click()
    await frames()
    expect(await scroll()).toMatchObject({ end: true, jump: false })
    // Back at live, it follows again.
    await set({ count: 44 })
    expect(await scroll()).toMatchObject({ end: true, jump: false })
  })

  it('a Reader closed and reopened (a park, then the next explicit reveal) comes back at its scroll position', async () => {
    await set({ kind: 'answer' })
    await frames()
    await scrollTo(300)
    expect((await scroll()).top).toBe(300)
    await set({ mounted: false })
    expect(await page.locator('[data-re-reader-scroll]').count()).toBe(0)
    await set({ mounted: true })
    await frames()
    expect((await scroll()).top).toBe(300)
    // A transcript left at live reopens at live, newest line included.
    await set({ kind: 'transcript' })
    await frames()
    expect(await scroll()).toMatchObject({ end: true })
    await set({ mounted: false })
    await set({ count: 50 })
    await set({ mounted: true })
    await frames()
    expect(await scroll()).toMatchObject({ end: true, jump: false })
  })

  it('fades in over RE_READER_CROSSFADE_MS', async () => {
    const animation = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('[data-re-surface="reader"]')!)
      return { name: s.animationName, duration: s.animationDuration }
    })
    expect(animation).toEqual({ name: 're-reader-in', duration: '0.12s' })
  })
})
