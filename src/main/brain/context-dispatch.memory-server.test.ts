import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/ipc'
import type { ContextManifestEntry } from '@shared/context-manifest'
import { createBrainContextDispatch } from './context-dispatch'
import { unavailableBrainContextEnvelope, type BrainContextOwner } from './context-envelope'

vi.mock('electron')
vi.mock('./context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context')>()),
  areBrainContextRecordsCurrent: vi.fn(async () => true),
  areBrainContextSourcesCurrent: vi.fn(async () => true)
}))

const owner: BrainContextOwner = {
  authSessionGeneration: 2,
  contextRevision: 3,
  brainRevision: 4,
  profileKey: 'a'.repeat(64)
}

describe('server memory in the brain context dispatch', () => {
  it('quotes retrieved connector and document records as data and reports their origins to the turn manifest', async () => {
    const req: { id: string; prompt: string; transcript: string; brainContext?: string } = {
      id: 'turn-synthetic-1',
      prompt: 'What should I know?',
      transcript: ''
    }
    const sources: ContextManifestEntry[] = []
    const streams = new Map<string, { abort: () => void }>()
    const dispatch = vi.fn()
    const recall = vi.fn(async () => ({
      status: 'found' as const,
      value: [
        {
          id: 'synthetic-memory-1',
          sourceId: 'synthetic-source-1',
          origin: 'connector' as const,
          text: 'synthetic CRM fact',
          revision: 1
        },
        {
          id: 'synthetic-memory-2',
          sourceId: 'synthetic-source-2',
          origin: 'document' as const,
          text: 'synthetic document fact',
          revision: 1
        }
      ]
    }))
    const brain = createBrainContextDispatch({
      getSettings: () => ({}) as Settings,
      currentOwner: () => owner,
      req,
      streams,
      onError: vi.fn(),
      onApplied: (_text, applied) => sources.push(...(applied ?? [])),
      memoryServer: { recall }
    })

    brain.set(unavailableBrainContextEnvelope(owner))
    brain.dispatch(undefined, dispatch)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))

    expect(recall).toHaveBeenCalledWith('What should I know?')
    expect(req.brainContext).toContain('<context-data origin="connector" authority="data"')
    expect(req.brainContext).toContain('<context-data origin="document" authority="data"')
    expect(sources.map((entry) => [entry.origin, entry.authority])).toEqual([
      ['connector', 'data'],
      ['document', 'data']
    ])
  })

  it('sends only the redacted question as the recall query, never the meeting transcript', async () => {
    const req: { id: string; prompt: string; transcript: string; brainContext?: string } = {
      id: 'turn-synthetic-2',
      prompt: 'Summarise the plan, my key is sk-test-not-a-real-key-0123456789abcdef',
      transcript: 'THEM: synthetic private meeting line'
    }
    const dispatch = vi.fn()
    const recall = vi.fn(async () => ({ status: 'no-results' as const }))
    const brain = createBrainContextDispatch({
      getSettings: () => ({}) as Settings,
      currentOwner: () => owner,
      req,
      streams: new Map<string, { abort: () => void }>(),
      onError: vi.fn(),
      memoryServer: { recall }
    })
    brain.set(unavailableBrainContextEnvelope(owner))
    brain.dispatch(undefined, dispatch)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const [query] = recall.mock.calls[0] as unknown as [string]
    expect(query).toContain('Summarise the plan')
    expect(query).not.toContain('synthetic private meeting line')
    expect(query).not.toContain('sk-test-not-a-real-key-0123456789abcdef')
  })
})
