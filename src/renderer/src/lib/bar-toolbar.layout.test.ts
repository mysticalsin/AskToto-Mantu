import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAppCss } from '../../../../scripts/lib/read-app-css.mjs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { overlayAllowsMinimize } from '@shared/overlay-chrome'
import { Bar, type BarProps } from '../components/Bar'

const barSrc = readFileSync(join(__dirname, '../components/Bar.tsx'), 'utf8').replace(/\r\n/g, '\n')
const css = readAppCss().replace(/\r\n/g, '\n')
const design = readFileSync(join(__dirname, '../../../../DESIGN.md'), 'utf8')
const contract = readFileSync(join(__dirname, '../../../../docs/design/BAR-PILL.md'), 'utf8')

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

  it('does not ship unused leftover chrome classes in the eager stylesheet', () => {
    expect(css).not.toMatch(/\.aw-menu\b/)
    expect(css).not.toMatch(/\.cl-sidebar\b/)
    expect(css).not.toMatch(/\.cl-navitem-active\b/)
    expect(css).not.toMatch(/\.onboard-skip-screen\b/)
  })
})
