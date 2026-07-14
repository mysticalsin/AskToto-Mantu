import { describe, expect, it } from 'vitest'
import { describeImportProgress, describeMeetingIndexProgress } from './work-progress'

describe('meeting index progress presentation', () => {
  it('uses the completed-meeting count to show an exact percentage', () => {
    expect(describeMeetingIndexProgress({ done: 1, total: 4, running: true })).toEqual({
      percent: 25,
      label: 'Mapping 1 of 4 meetings · 25%',
      valueText: '1 of 4 meetings mapped'
    })
  })

  it('does not invent a percentage before the index knows its total', () => {
    expect(describeMeetingIndexProgress({ done: 0, total: 0, running: true })).toEqual({
      percent: null,
      label: 'Mapping meetings…',
      valueText: 'Mapping meetings'
    })
  })

  it('labels the initial folder scan without reusing stale completed counts', () => {
    expect(describeMeetingIndexProgress({ done: 9, total: 9, preparing: true, running: true })).toEqual({
      percent: null,
      label: 'Preparing saved meetings…',
      valueText: 'Preparing saved meetings'
    })
  })

  it('never renders more than 100% when a stale poll races a completed run', () => {
    expect(describeMeetingIndexProgress({ done: 5, total: 4, running: true }).percent).toBe(100)
  })

  it('does not call failed extractions mapped when the queue has finished', () => {
    expect(
      describeMeetingIndexProgress({
        done: 4,
        failed: 1,
        total: 4,
        running: false
      })
    ).toEqual({
      percent: 100,
      label: 'Mapped 3 of 4 meetings · 1 needs attention',
      valueText: '3 of 4 meetings mapped; 1 needs attention'
    })
  })
})

describe('audio import progress presentation', () => {
  it('shows the backend-reported transcription percentage and active chunk', () => {
    expect(
      describeImportProgress({
        state: 'transcribing',
        cursor: 1,
        totalChunks: 4,
        pct: 25
      })
    ).toEqual({
      active: true,
      detail: '25% transcribed · chunk 2 of 4',
      label: 'Transcribing audio',
      percent: 25,
      valueText: '25% transcribed'
    })
  })

  it('keeps early decoding indeterminate until the decoder knows the recording length', () => {
    expect(
      describeImportProgress({
        state: 'decoding',
        cursor: 0,
        totalChunks: 0,
        pct: 0
      })
    ).toEqual({
      active: true,
      detail: 'Preparing audio for transcription',
      label: 'Decoding audio',
      percent: null,
      valueText: 'Preparing audio for transcription'
    })
  })

  it('does not call a still-finalizing import complete', () => {
    expect(
      describeImportProgress({
        state: 'saving',
        cursor: 4,
        totalChunks: 4,
        pct: 99
      })
    ).toEqual({
      active: true,
      detail: '99% transcribed · finalizing your meeting',
      label: 'Saving transcript',
      percent: 99,
      valueText: '99% transcribed'
    })
  })

  it("keeps a saved transcript's summary failure visible after transcription finishes", () => {
    expect(
      describeImportProgress({
        state: 'done',
        cursor: 4,
        totalChunks: 4,
        pct: 100,
        recapError: 'summary failed'
      })
    ).toEqual({
      active: false,
      detail: 'Transcript saved. Open the meeting to retry the summary.',
      label: 'Summary needs attention',
      percent: 100,
      valueText: 'Transcript saved; summary needs attention'
    })
  })
})
