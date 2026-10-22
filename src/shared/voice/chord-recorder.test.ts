import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE_ACTIONS_SETTINGS, VOICE_CHORD_TOKENS, type VoiceChordToken } from '../voice-actions-settings'
import {
  RECORD_MIN_HOLD_MS,
  canonicalChord,
  chordChips,
  chordNotes,
  chordSpoken,
  latchDictationNote,
  tokenForKeyCode,
  validateChord
} from './chord-recorder'

const err = (tokens: VoiceChordToken[], platform: 'darwin' | 'win32'): string | null => {
  const result = validateChord(tokens, platform)
  return result.ok ? null : result.message
}

describe('chord recorder: key codes become the watcher vocabulary', () => {
  it('maps every sided modifier code to its chord token and nothing else', () => {
    expect(tokenForKeyCode('ControlLeft')).toBe('leftControl')
    expect(tokenForKeyCode('ControlRight')).toBe('rightControl')
    expect(tokenForKeyCode('AltLeft')).toBe('leftAlt')
    expect(tokenForKeyCode('AltRight')).toBe('rightAlt')
    expect(tokenForKeyCode('MetaLeft')).toBe('leftCommand')
    expect(tokenForKeyCode('MetaRight')).toBe('rightCommand')
    expect(tokenForKeyCode('ShiftLeft')).toBe('leftShift')
    expect(tokenForKeyCode('ShiftRight')).toBe('rightShift')
    for (const code of ['KeyA', 'Escape', 'Tab', 'Space', 'CapsLock', 'Fn', '', 'Meta']) {
      expect(tokenForKeyCode(code), code).toBeNull()
    }
  })

  it('every token the recorder can produce is one the settings schema accepts', () => {
    for (const code of [
      'ControlLeft',
      'ControlRight',
      'AltLeft',
      'AltRight',
      'MetaLeft',
      'MetaRight',
      'ShiftLeft',
      'ShiftRight'
    ]) {
      expect(VOICE_CHORD_TOKENS).toContain(tokenForKeyCode(code))
    }
  })

  it('orders and de-duplicates a held set so the same keys always store the same chord', () => {
    expect(canonicalChord(['rightAlt', 'leftControl', 'rightAlt'])).toEqual(['leftControl', 'rightAlt'])
    expect(canonicalChord(['rightCommand'])).toEqual(['rightCommand'])
  })

  it('asks for a hold of at least 400 ms before it commits', () => {
    expect(RECORD_MIN_HOLD_MS).toBe(400)
  })
})

describe('chord recorder: labels', () => {
  it('shows the sided glyph on macOS and the word on Windows', () => {
    expect(chordChips(['rightCommand'], 'darwin')).toEqual(['Right ⌘'])
    expect(chordChips(['leftControl', 'leftAlt'], 'darwin')).toEqual(['Left ⌃', 'Left ⌥'])
    expect(chordChips(['rightControl'], 'win32')).toEqual(['Right Ctrl'])
    expect(chordChips(['leftControl', 'leftAlt'], 'win32')).toEqual(['Left Ctrl', 'Left Alt'])
  })

  it('speaks the full key names for the accessible name', () => {
    expect(chordSpoken(['rightCommand'], 'darwin')).toBe('Right Command')
    expect(chordSpoken(['leftControl', 'leftAlt'], 'darwin')).toBe('Left Control and Left Option')
    expect(chordSpoken(['rightControl'], 'win32')).toBe('Right Control')
  })
})

describe('chord recorder: a single modifier is a valid chord', () => {
  it('accepts the shipped defaults on their own platform', () => {
    expect(validateChord(DEFAULT_VOICE_ACTIONS_SETTINGS.holdChord.mac, 'darwin')).toEqual({ ok: true })
    expect(validateChord(DEFAULT_VOICE_ACTIONS_SETTINGS.holdChord.win, 'win32')).toEqual({ ok: true })
  })

  it('accepts one modifier of each family where nothing collides', () => {
    for (const token of [
      'rightCommand',
      'rightControl',
      'leftControl',
      'leftAlt',
      'rightAlt',
      'leftCommand'
    ] as const) {
      expect(validateChord([token], 'darwin'), token).toEqual({ ok: true })
    }
  })
})

describe('chord recorder: inline validation (HIG S6), one sentence each, no em dashes', () => {
  it('refuses nothing held and more than four keys', () => {
    expect(err([], 'darwin')).toBe('Hold at least one modifier key.')
    expect(err(['leftControl', 'rightControl', 'leftAlt', 'rightAlt', 'leftShift'], 'darwin')).toBe(
      'Use four keys or fewer.'
    )
  })

  it('refuses Shift on its own because it is held while typing', () => {
    expect(err(['leftShift'], 'darwin')).toBe('Shift alone is held while you type. Choose another key, like Right ⌘.')
    expect(err(['rightShift'], 'win32')).toBe(
      'Shift alone is held while you type. Choose another key, like Right Ctrl.'
    )
    expect(err(['leftShift', 'rightShift'], 'darwin')).not.toBeNull()
  })

  it('refuses Command with Shift on macOS because it starts many app shortcuts', () => {
    expect(err(['rightCommand', 'rightShift'], 'darwin')).toBe(
      '⌘ with ⇧ starts many app shortcuts. Choose another combination.'
    )
  })

  it('refuses the Windows key on Windows because it opens Start', () => {
    expect(err(['rightCommand'], 'win32')).toBe('The Windows key opens Start. Choose Ctrl or Alt instead.')
    expect(err(['leftCommand', 'leftAlt'], 'win32')).toBe('The Windows key opens Start. Choose Ctrl or Alt instead.')
  })

  it('refuses Left Ctrl with Right Alt on Windows because that is AltGr', () => {
    expect(err(['leftControl', 'rightAlt'], 'win32')).toBe(
      'Left Ctrl with Right Alt is AltGr on many keyboards. Choose another combination.'
    )
    expect(err(['leftControl', 'rightAlt'], 'darwin')).toBeNull()
  })

  it('never uses an em dash or the word Error in any message', () => {
    const samples: Array<[VoiceChordToken[], 'darwin' | 'win32']> = [
      [[], 'darwin'],
      [['leftShift'], 'darwin'],
      [['rightCommand', 'rightShift'], 'darwin'],
      [['rightCommand'], 'win32'],
      [['leftControl', 'rightAlt'], 'win32']
    ]
    for (const [tokens, platform] of samples) {
      const message = err(tokens, platform) ?? ''
      expect(message).not.toMatch(/—|–|error/i)
      expect(message.endsWith('.')).toBe(true)
    }
  })
})

describe('chord recorder: explanations that stay beside a chord that is allowed', () => {
  it('explains the VoiceOver collision for any chord holding Control and Option', () => {
    const note = 'VoiceOver uses Control and Option together. If you use VoiceOver, choose another shortcut.'
    expect(chordNotes(['leftControl', 'leftAlt'], 'darwin')).toContain(note)
    expect(chordNotes(['rightControl', 'leftAlt'], 'darwin')).toContain(note)
    expect(chordNotes(['rightCommand'], 'darwin')).not.toContain(note)
    expect(chordNotes(['leftControl', 'leftAlt'], 'win32')).not.toContain(note)
  })

  it('explains that Left Command and Left Ctrl start most shortcuts', () => {
    expect(chordNotes(['leftCommand'], 'darwin')).toEqual([
      'Left ⌘ starts most shortcuts, so holding it a moment before one briefly starts listening. Right ⌘ avoids that.'
    ])
    expect(chordNotes(['leftControl'], 'win32')).toEqual([
      'Left Ctrl starts most shortcuts, so holding it a moment before one briefly starts listening. Right Ctrl avoids that.'
    ])
  })

  it('says nothing about the shipped defaults', () => {
    expect(chordNotes(['rightCommand'], 'darwin')).toEqual([])
    expect(chordNotes(['rightControl'], 'win32')).toEqual([])
  })

  it('warns that Fn can start Dictation on macOS', () => {
    expect(chordNotes(['fn'], 'darwin')).toEqual(['Fn (Globe) can be set to start Dictation in System Settings.'])
  })
})

describe('double-press latch: the macOS Dictation collision is named', () => {
  it('names it for a lone Command, Control or Fn on macOS', () => {
    expect(latchDictationNote(['rightCommand'], 'darwin')).toBe(
      'On macOS, pressing Right ⌘ twice can also start Dictation. Turn that shortcut off in System Settings › Keyboard › Dictation first.'
    )
    expect(latchDictationNote(['leftControl'], 'darwin')).toContain('Left ⌃')
    expect(latchDictationNote(['fn'], 'darwin')).toContain('Fn')
  })

  it('says nothing for a chord Dictation does not use, or on Windows', () => {
    expect(latchDictationNote(['rightAlt'], 'darwin')).toBeNull()
    expect(latchDictationNote(['leftControl', 'leftAlt'], 'darwin')).toBeNull()
    expect(latchDictationNote(['rightControl'], 'win32')).toBeNull()
  })
})
