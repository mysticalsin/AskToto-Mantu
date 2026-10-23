import { describe, expect, it } from 'vitest'
import { isEmptyOrRecognizerSentinel } from './dictation-gate'

describe('dictation transcript gate (G25)', () => {
  it.each([
    '',
    '   \n\t',
    '[BLANK_AUDIO]',
    '<|nospeech|>',
    '<|endoftext|>',
    ' [blank_audio]\n<|NoSpeech|> '
  ])('rejects only empty text or exact whole-utterance recognizer markers: %j', (text) => {
    expect(isEmptyOrRecognizerSentinel(text)).toBe(true)
  })

  it.each([
    'Thank you for watching',
    'Thank you for watching 2',
    'Please subscribe',
    'Do not rename McDonald',
    '谢谢观看',
    'ご視聴ありがとうございました',
    'ขอบคุณที่รับชม',
    'um',
    'er',
    '123?!',
    '.',
    '(music)',
    '<|unknown|>',
    '[BLANK_AUDIO] spoken words',
    'spoken words <|nospeech|>'
  ])('does not reject other transcript text: %j', (text) => {
    expect(isEmptyOrRecognizerSentinel(text)).toBe(false)
  })
})
