import { describe, expect, it } from 'vitest'
import { COMMAND_SPEECH_MAX_SECONDS } from '@shared/command-speech'
import { COMMAND_SPEECH_WORKLET_SRC } from './command-speech-worklet-src'

describe('command speech worklet', () => {
  it('seals at the same fifteen second cap as main, derived from the one shared constant', () => {
    expect(COMMAND_SPEECH_MAX_SECONDS).toBe(15)
    expect(COMMAND_SPEECH_WORKLET_SRC).toContain(`const MAX_SAMPLES = SAMPLE_RATE * ${COMMAND_SPEECH_MAX_SECONDS}`)
  })
})
