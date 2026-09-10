import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Answer } from './Answer'
import { Review } from './Review'

// Review is a client-only surface. Supply its actual session snapshot to React's server renderer
// so this test can inspect the real component without mounting a browser or mocking its children.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T {
      return actual.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }
  }
})

describe('partial completion error presentation', () => {
  const partial = 'The meeting discussed a new project. The next steps are still incomplete.'
  const error = 'The provider stopped before completing the response. Try again.'

  it('keeps the partial answer visible beside its error and retry action', () => {
    const html = renderToStaticMarkup(
      <Answer text={partial} streaming={false} error={error} onRetry={() => {}} />
    )
    expect(html).toContain(partial)
    expect(html).toContain(error)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Retry')
    expect(html).not.toContain('Answered by')
  })

  it('keeps substantial partial meeting notes visible with Retry summary', () => {
    const html = renderToStaticMarkup(
      <Review lines={[]} mode="meeting" startedAt={1} savedPath={null} saveError={null}
        recap={{ id: 'synthetic', prompt: '', text: partial, streaming: false, error }}
        onOpenFolder={() => {}} onRetryRecap={() => {}} />
    )
    expect(html).toContain(partial)
    expect(html).toContain(error)
    expect(html).toContain('Retry summary')
  })

  it('keeps a short partial meeting summary visible with its retry action', () => {
    const short = 'Decision: retry.'
    const html = renderToStaticMarkup(
      <Review lines={[]} mode="meeting" startedAt={1} savedPath={null} saveError={null}
        recap={{ id: 'short', prompt: '', text: short, streaming: false, error }}
        onOpenFolder={() => {}} onRetryRecap={() => {}} />
    )
    expect(html).toContain(short)
    expect(html).toContain(error)
    expect(html).toContain('Retry summary')
  })

  it('shows reopened incomplete notes with fixed local copy, Retry, and edit/export actions', () => {
    const html = renderToStaticMarkup(
      <Review lines={[]} mode="meeting" startedAt={1} savedPath="meeting.md" saveError={null}
        recap={{ id: 'past', prompt: '', text: 'Short partial', streaming: false, error: null }}
        recapStatus="incomplete" isPastMeeting onOpenFolder={() => {}} onRetryRecap={() => {}} />
    )
    expect(html).toContain('Short partial')
    expect(html).toContain('This summary may be incomplete. Review it before using it, or retry.')
    expect(html).toContain('Retry summary')
    expect(html).toContain('Copy Summary')
    expect(html).toContain('Edit')
    expect(html).toContain('Export JSON')
  })

  it('shows an empty explicit incomplete recap as terminal and retryable, never still writing', () => {
    const html = renderToStaticMarkup(
      <Review lines={[{ speaker: 'you', text: 'Captured speech', t: 1 }]}
        mode="meeting" startedAt={1} savedPath={null} saveError={null}
        recap={{ id: 'empty', prompt: '', text: '', streaming: false, error: null, completion: 'incomplete' }}
        recapStatus="incomplete" onOpenFolder={() => {}} onRetryRecap={() => {}} />
    )
    expect(html).toContain('This summary may be incomplete. Review it before using it, or retry.')
    expect(html).toContain('Retry summary')
    expect(html).not.toContain('data-agent-status="writing"')
  })

  it('keeps manual transcript Save available when no recap run owns the meeting', () => {
    const html = renderToStaticMarkup(
      <Review lines={[{ speaker: 'you', text: 'Captured speech', t: 1 }]}
        mode="meeting" startedAt={1} savedPath={null} saveError={null} recap={null}
        onOpenFolder={() => {}} onSave={() => {}} />
    )
    expect(html).toContain('>Save</span>')
    expect(html).not.toContain('disabled=""')
  })
})
