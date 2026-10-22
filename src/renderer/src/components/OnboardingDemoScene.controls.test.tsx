import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { OnboardingDemoScene } from './OnboardingDemoScene'

/**
 * The demo's Pause/Resume/Replay/Previous orchestration now resolves through
 * lib/onboarding-demo-controls.ts's pure, unit-tested orchestrator (see
 * onboarding-demo-controls.test.ts). This file pins the one thing only a real render can
 * show: the actual initial markup a viewer sees before any effect has run — renderToStaticMarkup
 * never flushes effects, so this is genuinely the first paint's controls, not a simulation of it.
 */
function stubReducedMotion(matches: boolean): () => void {
  const previous = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: { matchMedia: (query: string) => { matches: boolean } } }).window = {
    matchMedia: () => ({ matches })
  }
  return () => {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = previous
  }
}

function renderDemo(): string {
  return renderToStaticMarkup(<OnboardingDemoScene mode="general" onSetMode={() => {}} onContinue={() => {}} />)
}

function playbackControls(html: string): string {
  const start = html.indexOf('aria-label="Demo playback"')
  const end = html.indexOf('aria-label="Continue onboarding"')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

describe('OnboardingDemoScene — initial controls before any effect has run', () => {
  const restoreWindow: Array<() => void> = []
  afterEach(() => {
    while (restoreWindow.length) restoreWindow.pop()?.()
  })

  it('opens on step 1 of 4 with Previous disabled and Pause ready but not pressed', () => {
    const html = renderDemo()
    expect(html).toContain('Step 1 of 4')
    const controls = playbackControls(html)
    expect(controls).toMatch(/<button[^>]*disabled=""[^>]*>\s*Previous\s*<\/button>/)
    expect(controls).toMatch(
      /<button[^>]*aria-pressed="false"[^>]*aria-controls="[^"]+"[^>]*>\s*Pause demo\s*<\/button>/
    )
  })

  it('hides the Pause control entirely under reduced motion', () => {
    restoreWindow.push(stubReducedMotion(true))
    const html = renderDemo()
    const controls = playbackControls(html)
    expect(controls).not.toContain('Pause demo')
    expect(controls).not.toContain('Resume demo')
  })

  it('the illustrative Bar preview is inert', () => {
    const html = renderDemo()
    const open = html.match(/<div id="[^"]+"[^>]*>/g)?.find((tag) => /inert=""/.test(tag))
    expect(open, 'the preview wrapper carries inert').toBeDefined()
    // The wrapper is the one the playback buttons control, and it holds the real Bar.
    const id = open?.match(/id="([^"]+)"/)?.[1] ?? ''
    expect(html).toContain(`aria-controls="${id}"`)
    const preview = html.slice(html.indexOf(open as string))
    expect(preview.indexOf('Settings')).toBeGreaterThan(-1)
    // Playback and Continue stay live, outside the inert subtree.
    const controls = playbackControls(html)
    expect(controls).not.toContain('inert')
  })
})
