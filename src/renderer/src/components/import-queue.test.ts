import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  importQueueHeadline,
  isImportDropFile,
  pickedFiles,
  skippedImportMessage,
  visibleImportJobs
} from './import-queue'
import type { ImportAssetsProgress, ImportJobView } from '@shared/ipc'
import { ImportQueue } from './ImportQueue'
import { ImportQueueSection } from './ImportQueueSection'

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
    expect(importQueueHeadline([job({ jobId: '1', state: 'decoding', title: 'Standup' })])).toBe('Importing Standup')
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
    expect(importQueueHeadline([job({ jobId: '1', state: 'failed', title: 'A' })])).toBe('1 meeting needs attention')
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

describe('import queue rendered behavior', () => {
  const failedJob = job({ jobId: 'failed-1', state: 'failed', title: 'Weekly sync', error: 'Could not transcribe.' })
  const doneJob = job({ jobId: 'done-1', state: 'done', title: 'Planning', file: '/private/meeting.json' })

  it('renders meeting names, progress states, and the appropriate actions', () => {
    const html = renderToStaticMarkup(
      createElement(ImportQueue, {
        jobs: [failedJob, doneJob, job({ jobId: 'active-1', state: 'transcribing', title: 'Active recording' })],
        assets: { status: 'downloading', progress: 0.5, label: 'Downloading' } as ImportAssetsProgress,
        dragOver: true,
        error: null,
        onCancel: () => {},
        onResume: () => {},
        onDismiss: () => {},
        onOpenMeeting: () => {}
      })
    )

    expect(html).toContain('Weekly sync')
    expect(html).toContain('Could not transcribe.')
    expect(html).toContain('Resume')
    expect(html).toContain('Active recording')
    expect(html).toContain('Cancel')
    expect(html).toContain('Planning')
    expect(html).toContain('Open')
    expect(html).toContain('Getting transcription files')
    expect(html).toContain('Drop recordings to import them')
  })

  it('keeps policy-held jobs visible and disables Resume while policy blocks retention', () => {
    const html = renderToStaticMarkup(
      createElement(ImportQueueSection, {
        jobs: [job({ jobId: 'held-1', state: 'policy-held', title: 'Saved import' })],
        policyBlocked: true,
        policyHeldJobIds: ['held-1'],
        inventoryOverflow: false,
        policyHoldOverflow: false,
        error: null,
        assets: null,
        dragOver: false,
        onCancel: () => {},
        onResume: () => {},
        onDismiss: () => {},
        onOpenMeeting: () => {}
      })
    )
    expect(html).toContain('Saved import')
    expect(html).toContain('summary-only policy prevents import')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?<\/button>/)
    expect(html).toContain('Resume</span>')
    expect(html).toContain('summary-only policy prevents resuming this import')
  })
})
