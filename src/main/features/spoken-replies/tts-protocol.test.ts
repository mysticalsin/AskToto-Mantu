import { describe, expect, it } from 'vitest'
import { MAX_VOICE_LIST_CHARS, parsePlaybackLine, parseVoiceList } from './tts-protocol'

describe('parsePlaybackLine (G27)', () => {
  it('reads the three playback events and a coded error', () => {
    expect(parsePlaybackLine('started')).toEqual({ type: 'started' })
    expect(parsePlaybackLine('ended')).toEqual({ type: 'ended' })
    expect(parsePlaybackLine('cancelled')).toEqual({ type: 'cancelled' })
    expect(parsePlaybackLine('error no_voice')).toEqual({ type: 'error', code: 'no_voice' })
    expect(parsePlaybackLine('error engine')).toEqual({ type: 'error', code: 'engine' })
  })
  it('tolerates trailing whitespace and CRLF', () => {
    expect(parsePlaybackLine('started \r')).toEqual({ type: 'started' })
  })
  it('maps an unknown error code to a generic engine error and ignores anything else', () => {
    expect(parsePlaybackLine('error something_new')).toEqual({ type: 'error', code: 'engine' })
    expect(parsePlaybackLine('hello')).toBeNull()
    expect(parsePlaybackLine('')).toBeNull()
    expect(parsePlaybackLine('started now')).toBeNull()
  })
})

describe('parseVoiceList (G27)', () => {
  it('reads the helper object form', () => {
    expect(parseVoiceList('{"voices":[{"id":"a","name":"A","language":"en-US"}]}')).toEqual([
      { id: 'a', name: 'A', language: 'en-US' }
    ])
  })
  it('reads a bare array and a single object (PowerShell ConvertTo-Json collapses one item)', () => {
    expect(parseVoiceList('[{"id":"a","name":"A","language":"en-US"}]')).toHaveLength(1)
    expect(parseVoiceList('{"id":"a","name":"A","language":"en-US"}')).toHaveLength(1)
  })
  it('drops malformed entries, rejects bad JSON and oversize output', () => {
    expect(
      parseVoiceList('{"voices":[{"id":"","name":"A","language":"en"},{"id":"b","name":"B","language":"en","x":1}]}')
    ).toEqual([])
    expect(parseVoiceList('not json')).toBeNull()
    expect(parseVoiceList('')).toBeNull()
    expect(parseVoiceList(' '.repeat(MAX_VOICE_LIST_CHARS + 1))).toBeNull()
  })
  it('accepts a UTF-8 byte order mark before the JSON', () => {
    expect(parseVoiceList('﻿[{"id":"a","name":"A","language":"en-US"}]')).toHaveLength(1)
  })
})
