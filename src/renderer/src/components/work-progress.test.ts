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
  describe('phase 1: warm-up (queued, or decoding/transcribing before a real checkpoint)', () => {
    it('shows the queue phase as indeterminate with the existing queued copy', () => {
      expect(
        describeImportProgress({ state: 'queued', cursor: 0, totalChunks: 0, pct: null })
      ).toEqual({
        active: true,
        detail: 'Waiting for the import queue',
        label: 'Queued to import',
        percent: null,
        valueText: 'Waiting for the import queue',
        pulseAtFull: false
      })
    })

    it('treats decoding with no percent yet as an indeterminate engine warm-up', () => {
      expect(
        describeImportProgress({ state: 'decoding', cursor: 0, totalChunks: 0, pct: null })
      ).toEqual({
        active: true,
        detail: 'Loading the transcription engine — this can take a moment.',
        label: 'Preparing on-device engine…',
        percent: null,
        valueText: 'Preparing on-device engine',
        pulseAtFull: false
      })
    })

    // A literal 0% (the decoder's first duration-based tick) is indistinguishable from "no checkpoint
    // yet" without a new IPC signal, so it is conservatively folded into the same warm-up state instead
    // of rendering a determinate bar frozen at a dead-looking 0%.
    it('treats a literal 0% during decoding as the same warm-up state, not a dead determinate bar', () => {
      expect(
        describeImportProgress({ state: 'decoding', cursor: 0, totalChunks: 0, pct: 0 })
      ).toEqual({
        active: true,
        detail: 'Loading the transcription engine — this can take a moment.',
        label: 'Preparing on-device engine…',
        percent: null,
        valueText: 'Preparing on-device engine',
        pulseAtFull: false
      })
    })

    it('treats a literal 0% right as transcribing begins as warm-up too', () => {
      expect(
        describeImportProgress({ state: 'transcribing', cursor: 0, totalChunks: 0, pct: 0 })
      ).toEqual({
        active: true,
        detail: 'Loading the transcription engine — this can take a moment.',
        label: 'Preparing on-device engine…',
        percent: null,
        valueText: 'Preparing on-device engine',
        pulseAtFull: false
      })
    })
  })

  describe('phase 2: transcribing — a determinate 0–100% bar with one progress text', () => {
    it('shows the backend-reported transcription percentage and active chunk, without repeating the percent in the header label', () => {
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
        valueText: '25% transcribed',
        pulseAtFull: false
      })
    })

    it('keeps a numeric transcription signal even before a total chunk count is known', () => {
      expect(
        describeImportProgress({
          state: 'transcribing',
          cursor: 0,
          totalChunks: 0,
          pct: 42
        })
      ).toEqual({
        active: true,
        detail: '42% transcribed',
        label: 'Transcribing audio',
        percent: 42,
        valueText: '42% transcribed',
        pulseAtFull: false
      })
    })

    it('shows real decoding progress once the decoder has produced a checkpoint', () => {
      expect(
        describeImportProgress({ state: 'decoding', cursor: 2, totalChunks: 5, pct: 40 })
      ).toEqual({
        active: true,
        detail: '40% transcribed · preparing the next audio segment',
        label: 'Decoding audio',
        percent: 40,
        valueText: '40% transcribed',
        pulseAtFull: false
      })
    })
  })

  describe('phase 3: wrapping up (saving, then recapping) — full bar + pulseAtFull, never a frozen 99%', () => {
    it('renders saving as a full, pulsing bar instead of freezing at its last transcription checkpoint', () => {
      expect(
        describeImportProgress({
          state: 'saving',
          cursor: 4,
          totalChunks: 4,
          pct: 99
        })
      ).toEqual({
        active: true,
        detail: 'Finalizing your meeting…',
        label: 'Saving transcript…',
        percent: 100,
        valueText: 'Finalizing your meeting',
        pulseAtFull: true
      })
    })

    it('renders the summary phase as a full, pulsing bar labeled "Creating summary…" for the whole recap call', () => {
      expect(
        describeImportProgress({
          state: 'recapping',
          cursor: 4,
          totalChunks: 4,
          pct: 99
        })
      ).toEqual({
        active: true,
        detail: 'Writing an AI summary of your meeting…',
        label: 'Creating summary…',
        percent: 100,
        valueText: 'Creating summary',
        pulseAtFull: true
      })
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
      valueText: 'Transcript saved; summary needs attention',
      pulseAtFull: false
    })
  })
})
