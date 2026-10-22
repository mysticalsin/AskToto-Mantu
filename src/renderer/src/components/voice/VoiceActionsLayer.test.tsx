import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { VoiceStateSnapshot } from '@shared/voice/voice-turn'
import { readModuleSource } from '../../../../test-helpers/module-source'
import { VoiceActionsLayer } from './VoiceActionsLayer'

const snap = (state: VoiceStateSnapshot['state'], message: string | null = null): VoiceStateSnapshot => ({
  revision: 3,
  state,
  turnId: 't1',
  reason: null,
  message,
  enabled: true,
  shortcut: 'running'
})

describe('VoiceActionsLayer (V05)', () => {
  it('renders the listening pill as a polite status under the bar', () => {
    const html = renderToStaticMarkup(
      <VoiceActionsLayer placement="top-center" soundCues={false} snapshot={snap('listening')} />
    )
    expect(html).toContain('data-voice-state="listening"')
    expect(html).toContain('data-voice-placement="top-center"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Listening…')
    expect(html).not.toMatch(/<button|tabindex/)
  })

  it('leans out of the right-edge dock in the right-edge placement', () => {
    const html = renderToStaticMarkup(
      <VoiceActionsLayer placement="right-edge" soundCues={false} snapshot={snap('done', 'Opened Notes')} />
    )
    expect(html).toContain('voice-layer--right-edge')
    expect(html).toContain('Opened Notes')
  })

  it('renders nothing while idle', () => {
    expect(
      renderToStaticMarkup(<VoiceActionsLayer placement="top-center" soundCues={false} snapshot={snap('idle')} />)
    ).toBe('')
  })

  it('never takes focus and never opens the microphone or starts a turn', () => {
    const source = readModuleSource(__dirname, './VoiceActionsLayer').text
    expect(source).not.toMatch(/\.focus\(/)
    expect(source).not.toMatch(/getUserMedia|voiceActions\.report|commandMic|startListen/)
  })

  it('reduced motion keeps only the opacity breathe on the listening bars', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'styles', 'voice-actions.css'), 'utf8')
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.voice-pill__bars > span \{[^}]*asktoto-loading-pulse/)
    // Motion uses the tokens: the hold-fast entry and the panel morph.
    expect(css).toMatch(/overlay-peek-in 150ms var\(--ease-spring\)/)
    expect(css).toMatch(/var\(--duration-panel\)/)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })
})
