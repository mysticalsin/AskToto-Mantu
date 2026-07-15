import { describe, expect, it, vi } from 'vitest'
import {
  createKeyedSingleFlight,
  getScreenSourcesWithRetry,
  isScreenCapturePermissionError,
  isUsableScreenSource,
  screenCaptureUnavailableMessage
} from './screen-capture'

type FakeSource = { id: string; thumbnail: { getSize: () => { width: number; height: number } } }

const source = (id: string, width: number, height: number): FakeSource => ({
  id,
  thumbnail: { getSize: () => ({ width, height }) }
})
const usable = (id = 'primary'): FakeSource => source(id, 1280, 720)
const blank = (id = 'primary'): FakeSource => source(id, 0, 0)

describe('screen capture source recovery', () => {
  it('retries a rejected source lookup before returning a usable source', async () => {
    const getSources = vi
      .fn<() => Promise<FakeSource[]>>()
      .mockRejectedValueOnce(new Error('Failed to get sources.'))
      .mockResolvedValueOnce([usable()])
    const wait = vi.fn(async () => {})

    const result = await getScreenSourcesWithRetry(getSources, isUsableScreenSource, { attempts: 3, wait })
    expect(result.map(({ id, thumbnail }) => ({ id, ...thumbnail.getSize() }))).toEqual([{ id: 'primary', width: 1280, height: 720 }])
    expect(getSources).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledWith(250)
  })

  it('retries an empty or zero-pixel source result instead of treating it as a successful capture', async () => {
    const getSources = vi
      .fn<() => Promise<FakeSource[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([blank()])
      .mockResolvedValueOnce([usable()])
    const wait = vi.fn(async () => {})

    const result = await getScreenSourcesWithRetry(getSources, isUsableScreenSource, { attempts: 3, wait })
    expect(result.map(({ id, thumbnail }) => ({ id, ...thumbnail.getSize() }))).toEqual([{ id: 'primary', width: 1280, height: 720 }])
    expect(getSources).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenNthCalledWith(1, 250)
    expect(wait).toHaveBeenNthCalledWith(2, 500)
  })

  it('keeps the Mac permission recovery wording specific and Windows wording platform-neutral', () => {
    expect(screenCaptureUnavailableMessage('darwin', 'denied')).toMatch(/Screen Recording permission is off for Métis/i)
    expect(screenCaptureUnavailableMessage('win32', 'denied')).toMatch(/screen-capture permissions/i)
    expect(screenCaptureUnavailableMessage('win32', 'denied')).not.toMatch(/System Settings/i)
  })

  it('shares capture work only for the same display, never across monitors', async () => {
    const capture = vi.fn(async (displayId: number) => `display-${displayId}`)
    const singleFlight = createKeyedSingleFlight(capture)

    const [firstA, secondA, firstB] = await Promise.all([singleFlight(1), singleFlight(1), singleFlight(2)])

    expect([firstA, secondA, firstB]).toEqual(['display-1', 'display-1', 'display-2'])
    expect(capture).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenNthCalledWith(1, 1)
    expect(capture).toHaveBeenNthCalledWith(2, 2)
  })

  it('recognizes both macOS and Windows permission failures before a text-only fallback can run', () => {
    expect(isScreenCapturePermissionError(screenCaptureUnavailableMessage('darwin', 'denied'))).toBe(true)
    expect(isScreenCapturePermissionError(screenCaptureUnavailableMessage('win32', 'denied'))).toBe(true)
    expect(isScreenCapturePermissionError('Screen capture returned an empty image. Try again in a moment.')).toBe(false)
  })
})
