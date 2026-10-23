import { describe, expect, it } from 'vitest'
import { wikiPublishDisclosure } from './wiki-publish-disclosure'

describe('wiki publish disclosure', () => {
  it('assumes encrypted transcript mode when no mode is supplied', () => {
    expect(wikiPublishDisclosure().mode).toBe('encrypted')
  })

  it('discloses that the wiki copy is plaintext even when transcripts are encrypted', () => {
    const disclosure = wikiPublishDisclosure(true)
    expect(disclosure.mode).toBe('encrypted')
    expect(disclosure.copy).toMatch(/plaintext wiki copy/i)
  })

  it('labels the plaintext transcript mode before publishing', () => {
    const disclosure = wikiPublishDisclosure(false)
    expect(disclosure.mode).toBe('plaintext')
    expect(disclosure.copy).toMatch(/plaintext/i)
  })
})
