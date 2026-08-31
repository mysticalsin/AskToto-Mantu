import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  importQueueHeadline,
  isImportDropFile,
  pickedFiles,
  skippedImportMessage,
  visibleImportJobs
} from './import-queue'
import type { ImportJobView } from '@shared/ipc'

function job(partial: Partial<ImportJobView> & Pick<ImportJobView, 'jobId' | 'state'>): ImportJobView {
  return {
    title: partial.title ?? partial.jobId,
    cursor: 0,
    totalChunks: 0,
    pct: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial
  }
}

describe('import queue helpers', () => {
  it('pickedFiles prefers the files array and falls back to the first token', () => {
    expect(
      pickedFiles({
        token: 'tok-a',
        name: 'a.m4a',
        files: [
          { token: 'tok-a', name: 'a.m4a', sizeBytes: 1, mtimeMs: 1 },
          { token: 'tok-b', name: 'b.wav', sizeBytes: 2, mtimeMs: 2 }
        ]
      })
    ).toHaveLength(2)
    expect(pickedFiles({ token: 'only', name: 'solo.mp3' })).toEqual([
      expect.objectContaining({ token: 'only', name: 'solo.mp3' })
    ])
    expect(pickedFiles({ cancelled: true })).toEqual([])
  })

  it('hides cancelled jobs and keeps done rows until dismiss', () => {
    const visible = visibleImportJobs([
      job({ jobId: 'd', state: 'done', title: 'Done', updatedAt: 3 }),
      job({ jobId: 'c', state: 'cancelled', title: 'Nope' }),
      job({ jobId: 'r', state: 'transcribing', title: 'Live', updatedAt: 2 }),
      job({ jobId: 'q', state: 'queued', title: 'Wait', updatedAt: 1 })
    ])
    expect(visible.map((j) => j.jobId)).toEqual(['r', 'q', 'd'])
  })

  it('headline is friendly for one, several, mixed, and attention', () => {
    expect(importQueueHeadline([job({ jobId: '1', state: 'decoding', title: 'Standup' })])).toBe(
      'Importing Standup'
    )
    expect(
      importQueueHeadline([
        job({ jobId: '1', state: 'queued', title: 'A' }),
        job({ jobId: '2', state: 'queued', title: 'B' }),
        job({ jobId: '3', state: 'decoding', title: 'C' })
      ])
    ).toBe('Importing 3 meetings')
    expect(
      importQueueHeadline([
        job({ jobId: '1', state: 'done', title: 'A' }),
        job({ jobId: '2', state: 'done', title: 'B' })
      ])
    ).toBe('2 meetings ready')
    expect(
      importQueueHeadline([
        job({ jobId: '1', state: 'done', title: 'A' }),
        job({ jobId: '2', state: 'transcribing', title: 'B' })
      ])
    ).toBe('1 of 2 ready')
    expect(importQueueHeadline([job({ jobId: '1', state: 'failed', title: 'A' })])).toBe(
      '1 meeting needs attention'
    )
  })

  it('drop filter accepts recordings by mime or extension', () => {
    expect(isImportDropFile({ type: 'audio/mpeg', name: 'x' })).toBe(true)
    expect(isImportDropFile({ type: 'video/mp4', name: 'x' })).toBe(true)
    expect(isImportDropFile({ type: '', name: 'notes.m4a' })).toBe(true)
    expect(isImportDropFile({ type: 'application/pdf', name: 'deck.pdf' })).toBe(false)
  })

  it('skippedImportMessage lists per-file reasons', () => {
    expect(
      skippedImportMessage({
        files: [{ token: 't', name: 'ok.mp3', sizeBytes: 1, mtimeMs: 1 }],
        skipped: [{ name: 'huge.mp3', error: 'That file is larger than 500 MB. Choose a smaller recording.' }]
      })
    ).toMatch(/huge\.mp3/)
  })
})

describe('import queue layout', () => {
  const queue = readFileSync(join(__dirname, 'ImportQueue.tsx'), 'utf8')
  const recall = readFileSync(join(__dirname, 'RecallView.tsx'), 'utf8')

  it('queue cards name the meeting and expose resume, cancel, and done', () => {
    expect(queue).toMatch(/job\.title/)
    expect(queue).toMatch(/Resume/)
    expect(queue).toMatch(/Cancel/)
    expect(queue).toMatch(/Open/)
    expect(queue).toMatch(/describeImportProgress/)
    expect(queue).toMatch(/Getting transcription files/)
    expect(queue).toMatch(/Drop recordings to import them/)
  })

  it('Recall offers several meetings via picker and drop, never a raw path', () => {
    expect(recall).toMatch(/Import meetings/)
    expect(recall).toMatch(/importAudioStartBatch/)
    expect(recall).toMatch(/importAudioDrop/)
    expect(recall).toMatch(/onDrop/)
    expect(recall).toMatch(/<ImportQueue/)
    expect(recall).not.toMatch(/webUtils\.getPathForFile/)
    expect(recall).not.toMatch(/file\.path/)
  })
})
