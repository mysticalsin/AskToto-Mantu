import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeetingRow } from './RecallView'
import { DegradedBanner } from './history/DegradedBanner'
import {
  HISTORY_DEGRADED_MS,
  armSlowNotice,
  degradedBanner,
  listBody,
  nextListPhase,
  type ListPhase
} from './history/list-status'
import type { RowHydration } from './history/hydration'
import type { MeetingSummary } from '@shared/ipc'

const noop = (): void => {}

function row(meeting: Partial<MeetingSummary>, hydration?: RowHydration, onOpen: (file: string) => void = noop): string {
  return renderToStaticMarkup(
    <MeetingRow
      meeting={{ file: 'cloud.md', title: 'Cloud sync', date: '', mode: 'general', durationMin: 0, participants: [], ...meeting }}
      isSelected={false}
      isActive={false}
      isDeleting={false}
      isEditing={false}
      editingValue=""
      isRenaming={false}
      isOpen={false}
      error={null}
      indexStatus={null}
      indexError={null}
      hydration={hydration}
      onSelect={noop}
      onOpen={onOpen}
      onToggleConnections={noop}
      onTrash={noop}
      onExport={noop}
      onStartEdit={noop}
      onEditingChange={noop}
      onCommitEdit={noop}
      onCancelEdit={noop}
    />
  )
}

describe('History rows that are not on this device (MeetingRow)', () => {
  it('shows a cloud-only row as in OneDrive and not downloaded, with an explicit Download action', () => {
    const html = row({ notDownloaded: true, locked: true })
    expect(html).toContain('aria-label="In OneDrive, not downloaded"')
    expect(html).toContain('Not downloaded')
    expect(html).toContain('aria-label="Download and open Cloud sync"')
    // main marks it locked too; it must never read as an undecryptable meeting
    expect(html).not.toContain('Encrypted, can&#x27;t be opened on this device')
  })

  it('reports the download as progress and disables the action while it runs', () => {
    const html = row({ notDownloaded: true }, { state: 'hydrating' })
    expect(html).toContain('role="status"')
    expect(html).toContain('Downloading…')
    expect(html).toMatch(/<button[^>]*aria-label="Download and open Cloud sync"[^>]*disabled=""/)
  })

  it('offers a retry after a failed download', () => {
    const html = row({ notDownloaded: true }, { state: 'failed', error: 'Offline.' })
    expect(html).toContain('Download failed')
    expect(html).toContain('aria-label="Retry downloading Cloud sync"')
  })

  it('shows an unreadable row as Unavailable, with no download action', () => {
    const html = row({ unavailable: true, locked: true })
    expect(html).toContain('aria-label="Unavailable"')
    expect(html).toContain('>Unavailable<')
    expect(html).not.toContain('Download and open')
    expect(html).not.toContain('>Locked<')
  })

  it('keeps a plain local meeting free of any cloud state', () => {
    const html = row({ title: 'Local sync' })
    expect(html).not.toContain('Download')
    expect(html).not.toContain('In OneDrive')
    expect(html).not.toContain('Unavailable')
  })
})

describe('History list request (list-status)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it(`turns an unanswered request into the degraded state after ${HISTORY_DEGRADED_MS} ms, not before`, () => {
    vi.useFakeTimers()
    const onSlow = vi.fn()
    armSlowNotice(onSlow)

    vi.advanceTimersByTime(HISTORY_DEGRADED_MS - 1)
    expect(onSlow).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSlow).toHaveBeenCalledTimes(1)
  })

  it('never fires for a request that answered first', () => {
    vi.useFakeTimers()
    const onSlow = vi.fn()
    const cancel = armSlowNotice(onSlow)

    cancel()
    vi.advanceTimersByTime(HISTORY_DEGRADED_MS * 10)
    expect(onSlow).not.toHaveBeenCalled()
  })

  it('spins only while loading: a slow or failed request never spins and never claims there are no meetings', () => {
    let phase: ListPhase = nextListPhase('ready', 'request')
    expect(listBody(phase, 0)).toBe('spinner')
    phase = nextListPhase(phase, 'slow')
    expect(phase).toBe('slow')
    expect(listBody(phase, 0)).toBe('blank')
    expect(listBody(phase, 3)).toBe('rows')
    expect(listBody('failed', 0)).toBe('blank')
    expect(listBody('ready', 0)).toBe('empty')
  })

  it('a late slow notice never overrides an answer or a failure that already arrived', () => {
    expect(nextListPhase('ready', 'slow')).toBe('ready')
    expect(nextListPhase('failed', 'slow')).toBe('failed')
    expect(nextListPhase('slow', 'answered')).toBe('ready')
  })

  it('explains a slow source, a failed load and unreadable rows, and is silent otherwise', () => {
    expect(degradedBanner('slow', [])).toMatchObject({ kind: 'slow', retry: false })
    expect(degradedBanner('failed', [])).toMatchObject({ kind: 'failed', retry: true })
    expect(degradedBanner('ready', [{ unavailable: true }, {}, { unavailable: true }])).toMatchObject({
      kind: 'unavailable',
      message: '2 meetings could not be read right now.',
      retry: true
    })
    expect(degradedBanner('ready', [{ unavailable: true }])?.message).toBe('1 meeting could not be read right now.')
    expect(degradedBanner('ready', [{}, {}])).toBeNull()
    expect(degradedBanner('loading', [{ unavailable: true }])).toBeNull()
  })

  it('writes every banner without an em dash (user-facing copy rule)', () => {
    for (const banner of [degradedBanner('slow', []), degradedBanner('failed', []), degradedBanner('ready', [{ unavailable: true }])]) {
      expect(banner?.message).not.toContain('—')
    }
  })
})

describe('History degraded banner (DegradedBanner)', () => {
  it('announces a slow source as status, without a retry while the request is still out', () => {
    const banner = degradedBanner('slow', [])!
    const html = renderToStaticMarkup(<DegradedBanner banner={banner} onRetry={noop} />)
    expect(html).toContain('role="status"')
    expect(html).toContain(banner.message)
    expect(html).not.toContain('Retry')
  })

  it('announces a failed load as an alert with a labelled retry', () => {
    const html = renderToStaticMarkup(<DegradedBanner banner={degradedBanner('failed', [])!} onRetry={noop} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-label="Retry loading meetings"')
  })
})
