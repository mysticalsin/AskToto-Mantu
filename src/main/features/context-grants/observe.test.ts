import { describe, expect, it, vi } from 'vitest'
import { createSnapshotObserver } from './observe'

const identity = {
  observationId: 'obs-3',
  sequence: 3,
  sourceId: 'display:2',
  scope: 'display',
  generation: 4,
  capturedAt: 77
} as const

describe('snapshot observer', () => {
  it('takes one display capture, reads it on-device and returns its identity and the foreground app', async () => {
    const capture = vi.fn(async () => ({ image: 'AAAA', observation: identity }))
    const readText = vi.fn(async () => 'Synthetic page')
    const observe = createSnapshotObserver({
      capture,
      readText,
      foreground: () => ({ title: 'Synthetic\u0007 Reader\n' })
    })
    expect(await observe('document')).toEqual({
      sourceId: 'display:2',
      observationId: 'obs-3',
      generation: 4,
      capturedAt: 77,
      text: 'Synthetic page',
      app: 'Synthetic Reader'
    })
    expect(capture).toHaveBeenCalledOnce()
    expect(capture).toHaveBeenCalledWith({ kind: 'display' })
    expect(readText).toHaveBeenCalledWith('AAAA')
  })

  it('returns empty text when there is no on-device reader, and no app when none was observed', async () => {
    const observe = createSnapshotObserver({
      capture: async () => ({ image: 'AAAA', observation: identity }),
      readText: async () => null,
      foreground: () => null
    })
    expect(await observe('screen')).toMatchObject({ text: '', app: null })
  })

  it('lets a refused capture (Private View, locked) fail the request', async () => {
    const observe = createSnapshotObserver({
      capture: async () => {
        throw new Error('private view')
      },
      readText: async () => 'x',
      foreground: () => null
    })
    await expect(observe('screen')).rejects.toThrow('private view')
  })
})
