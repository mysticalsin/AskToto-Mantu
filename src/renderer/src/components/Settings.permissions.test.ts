import { describe, it, expect } from 'vitest'
import { screenRecordingJustGranted } from './Settings'

describe('screenRecordingJustGranted — the Restart Métis trigger', () => {
  it('is false on the first observation since mount, even if already granted', () => {
    expect(screenRecordingJustGranted(null, 'granted', false)).toBe(false)
  })

  it('is true when a not-yet-granted status flips to granted while mounted', () => {
    expect(screenRecordingJustGranted('unknown', 'granted', false)).toBe(true)
    expect(screenRecordingJustGranted('denied', 'granted', false)).toBe(true)
  })

  it('is false when the status was already granted and stays granted', () => {
    expect(screenRecordingJustGranted('granted', 'granted', false)).toBe(false)
  })

  it('is false when the status is not granted', () => {
    expect(screenRecordingJustGranted('unknown', 'denied', false)).toBe(false)
    expect(screenRecordingJustGranted('unknown', 'unknown', false)).toBe(false)
  })

  it('is false on Windows, which has no relaunch-to-apply quirk', () => {
    expect(screenRecordingJustGranted('unknown', 'granted', true)).toBe(false)
  })
})
