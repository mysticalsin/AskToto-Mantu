import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WHISPER_WORKLET_SRC } from './whisper-worklet-src'

const listenSrc = readFileSync(join(__dirname, 'listen.ts'), 'utf8').replace(/\r\n/g, '\n')

describe('live capture PCM handoff', () => {
  it('passes AudioContext’s actual rate into a worklet that emits only 16 kHz PCM', () => {
    expect(listenSrc).toMatch(/processorOptions: \{ sourceSampleRate: ctx\.sampleRate \}/)
    expect(WHISPER_WORKLET_SRC).toContain('this.resampler = new Pcm16kResampler(this.sourceSampleRate, SAMPLE_RATE)')
    expect(WHISPER_WORKLET_SRC).toContain('{ audio: chunk, sampleRate: SAMPLE_RATE, partial: true }')
    expect(WHISPER_WORKLET_SRC).toContain('{ audio: chunk, sampleRate: SAMPLE_RATE, partial: false }')
    expect(WHISPER_WORKLET_SRC).not.toContain('this.resampled.subarray(')
    expect(WHISPER_WORKLET_SRC).toContain('this.buf[this.fill + i] = this.resampled[offset + i]')
    expect(listenSrc).toMatch(/data\.sampleRate !== SR\) return/)
  })
})
