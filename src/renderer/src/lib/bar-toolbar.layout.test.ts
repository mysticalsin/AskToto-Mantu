import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { overlayAllowsMinimize } from '@shared/overlay-chrome'
import { Bar, type BarProps } from '../components/Bar'
import {
  BAR_OVERLAY_WIDTH_PX,
  BAR_TOOLBAR_MARK_PX,
  BAR_TOOLBAR_ORB_PX,
  layoutToolbarRow,
  listeningToolbarFixtureHtml,
  measureToolbarChildren,
  overlappingPairs,
  rectsIntersect,
  type ToolbarRect
} from './bar-toolbar-layout'

const barSrc = readFileSync(join(__dirname, '../components/Bar.tsx'), 'utf8').replace(/\r\n/g, '\n')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8').replace(/\r\n/g, '\n')
const design = readFileSync(join(__dirname, '../../../DESIGN.md'), 'utf8')
const contract = readFileSync(join(__dirname, '../../../docs/design/BAR-PILL.md'), 'utf8')

function barProps(overrides: Partial<BarProps> = {}): BarProps {
  return {
    value: '',
    onChange: () => {},
    onSubmit: () => {},
    onStop: () => {},
    busy: false,
    listening: false,
    onToggleListen: () => {},
    paused: false,
    onTogglePause: () => {},
    onCapture: () => {},
    capturing: false,
    captureAccel: 'Alt+Shift+S',
    onSettings: () => {},
    onHistory: () => {},
    onMinimize: () => {},
    stealth: true,
    onToggleStealth: () => {},
    startedAt: Date.now() - 47_000,
    panelOpen: false,
    onTogglePanel: () => {},
    canTogglePanel: true,
    focusSignal: 0,
    mode: 'general',
    onSetMode: () => {},
    onTranscript: () => {},
    onNewMeeting: () => {},
    canMinimize: overlayAllowsMinimize('bar'),
    ...overrides
  }
}

function named(rects: ToolbarRect[]): Record<string, ToolbarRect> {
  return Object.fromEntries(rects.map((r) => [r.name, r]))
}

describe('Bar toolbar reserved boxes (production overlay width)', () => {
  it('forbids the colliding 3-col grid, dummy spacer, and listening New meeting', () => {
    expect(barSrc).not.toMatch(/grid-cols-\[minmax\(30px,1fr\)_auto_minmax\(30px,1fr\)\]/)
    expect(barSrc).not.toMatch(/w-\[100px\]/)
    expect(barSrc).toMatch(/data-bar-toolbar/)
    expect(barSrc).toMatch(/data-bar-listen-timer/)
    expect(barSrc).toMatch(/data-bar-transcript/)
    expect(barSrc).toMatch(/aw-toolbar__transcript-copy/)
    expect(barSrc).not.toMatch(/<Plus/)
    expect(barSrc).not.toMatch(/onClick=\{props\.onNewMeeting\}/)
    expect(css).toMatch(/\.aw-toolbar \{[\s\S]*?display:\s*flex/)
    expect(css).toMatch(/\.aw-toolbar__timer \{[\s\S]*?flex:\s*0 0 auto/)
    expect(css).toMatch(/\.aw-bar-mark \{[\s\S]*?flex:\s*0 0 30px/)
    expect(css).toMatch(/@container aw-toolbar \(max-width: 720px\)/)
    expect(design).toMatch(/Hide "\+ New meeting"/)
    expect(contract).toMatch(/overlap is a ship blocker/)
  })

  it('listening markup has timer, Transcript, orb — and no New meeting', () => {
    const listen = renderToStaticMarkup(
      createElement(Bar, barProps({ listening: true, canMinimize: true }))
    )
    const idle = renderToStaticMarkup(createElement(Bar, barProps({ listening: false, canMinimize: true })))

    expect(listen).toContain('data-bar-toolbar')
    expect(listen).toContain('data-bar-listening="true"')
    expect(listen).toContain('data-bar-listen-timer')
    expect(listen).toContain('data-bar-transcript')
    expect(listen).toContain('Transcript')
    expect(listen).toContain('data-bar-pill-orb')
    expect(listen).toContain('Pause recording')
    expect(listen).not.toContain('New meeting')
    expect(listen).not.toContain('w-[100px]')
    expect(listen).not.toContain('data-bar-history')

    expect(idle).toContain('data-bar-listening="false"')
    expect(idle).toContain('data-bar-history')
    expect(idle).toContain('History')
    expect(idle).not.toContain('data-bar-listen-timer')
    expect(idle).not.toContain('New meeting')
    expect(idle).toContain('data-bar-mark')
    expect(idle).toContain('data-bar-pill-orb')
  })

  it('toolbar children getBoundingClientRect must not intersect while listening', () => {
    const { children, rects, transcriptCopy } = layoutToolbarRow({
      listening: true,
      overlayWidth: BAR_OVERLAY_WIDTH_PX
    })
    expect(BAR_OVERLAY_WIDTH_PX).toBe(880)
    expect(transcriptCopy).toBe(true)
    expect(children.map((c) => c.name)).toEqual(['mark', 'tools', 'timer', 'transcript', 'orb', 'chevron'])
    expect(children.map((c) => c.name)).not.toContain('new-meeting')

    const measured = children.map((child) => child.getBoundingClientRect())
    expect(overlappingPairs(measured)).toEqual([])

    const byName = named(rects)
    expect(byName.mark.width).toBe(BAR_TOOLBAR_MARK_PX)
    expect(byName.mark.height).toBe(BAR_TOOLBAR_MARK_PX)
    expect(rectsIntersect(byName.timer, byName.transcript)).toBe(false)
    expect(rectsIntersect(byName.timer, byName.orb)).toBe(false)
    expect(byName.orb.width).toBe(BAR_TOOLBAR_ORB_PX)
    expect(byName.timer.right).toBeLessThanOrEqual(byName.transcript.left)
    expect(byName.transcript.right).toBeLessThanOrEqual(byName.orb.left)
  })

  it('idle History + orb do not clip the locked M and have no timer', () => {
    const { children, rects } = layoutToolbarRow({ listening: false, overlayWidth: BAR_OVERLAY_WIDTH_PX })
    expect(children.map((c) => c.name)).toEqual(['mark', 'tools', 'history', 'orb', 'chevron'])
    expect(overlappingPairs(children.map((c) => c.getBoundingClientRect()))).toEqual([])
    const byName = named(rects)
    expect(byName.mark.width).toBe(30)
    expect(byName.mark.height).toBe(30)
    expect(byName.history).toBeTruthy()
    expect(byName.timer).toBeUndefined()
  })
})

describe('listening toolbar fixture at production overlay width', () => {
  let browser: import('playwright').Browser | null = null

  afterAll(async () => {
    await browser?.close()
  })

  it('getBoundingClientRect of fixture children do not intersect', async () => {
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: BAR_OVERLAY_WIDTH_PX, height: 200 } })
    await page.setContent(listeningToolbarFixtureHtml(BAR_OVERLAY_WIDTH_PX), { waitUntil: 'domcontentloaded' })

    const measured = await page.evaluate((selectorList: string) => {
      const root = document.querySelector('[data-bar-toolbar]')
      if (!root) throw new Error('missing toolbar fixture')
      if (root.querySelector('[data-bar-new-meeting]') || (root.textContent || '').includes('New meeting')) {
        throw new Error('New meeting must not be in the listening toolbar row')
      }
      return Array.from(root.querySelectorAll(selectorList)).map((node) => {
        const r = node.getBoundingClientRect()
        const name =
          (node.hasAttribute('data-bar-mark') && 'mark') ||
          (node.hasAttribute('data-bar-tools') && 'tools') ||
          (node.hasAttribute('data-bar-listen-timer') && 'timer') ||
          (node.hasAttribute('data-bar-transcript') && 'transcript') ||
          (node.hasAttribute('data-bar-pill-orb') && 'orb') ||
          (node.hasAttribute('data-bar-chevron') && 'chevron') ||
          'unknown'
        return { name, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
      })
    }, '[data-bar-mark], [data-bar-tools], [data-bar-listen-timer], [data-bar-transcript], [data-bar-pill-orb], [data-bar-chevron]')

    expect(measured.map((m) => m.name)).toEqual(['mark', 'tools', 'timer', 'transcript', 'orb', 'chevron'])
    expect(measured.every((m) => m.width > 0 && m.height > 0)).toBe(true)

    const hits: Array<[string, string]> = []
    for (let i = 0; i < measured.length; i++) {
      for (let j = i + 1; j < measured.length; j++) {
        if (rectsIntersect(measured[i], measured[j])) hits.push([measured[i].name, measured[j].name])
      }
    }
    expect(hits).toEqual([])

    const timer = measured.find((m) => m.name === 'timer')
    const transcript = measured.find((m) => m.name === 'transcript')
    const orb = measured.find((m) => m.name === 'orb')
    expect(timer && transcript && orb).toBeTruthy()
    if (timer && transcript && orb) {
      expect(rectsIntersect(timer, transcript)).toBe(false)
      expect(rectsIntersect(timer, orb)).toBe(false)
    }

    // Keep measureToolbarChildren wired so a live document uses the same helper.
    expect(typeof measureToolbarChildren).toBe('function')
  }, 30_000)
})
