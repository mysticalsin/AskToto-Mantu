import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { applyHydration, rowStatus, type Hydrations } from './hydration'
import { RowStatusChip } from './RowStatusChip'

const FILE = '2026-01-02_090000-cloud-sync.md'

describe('History explicit-open downloads (applyHydration)', () => {
  it('tracks a download from hydrating to done, leaving no entry once it finished', () => {
    const hydrating = applyHydration({}, { file: FILE, state: 'hydrating' })
    expect(hydrating).toEqual({ [FILE]: { state: 'hydrating' } })
    expect(applyHydration(hydrating, { file: FILE, state: 'done' })).toEqual({})
  })

  it('keeps a failed download with its reason until the next attempt starts', () => {
    const failed = applyHydration({ [FILE]: { state: 'hydrating' } }, { file: FILE, state: 'failed', error: 'Offline.' })
    expect(failed).toEqual({ [FILE]: { state: 'failed', error: 'Offline.' } })
    expect(applyHydration(failed, { file: FILE, state: 'hydrating' })).toEqual({ [FILE]: { state: 'hydrating' } })
  })

  it('never touches another row, nor the state it was given', () => {
    const current: Hydrations = { 'other.md': { state: 'failed', error: 'Offline.' } }
    expect(applyHydration(current, { file: FILE, state: 'hydrating' })).toEqual({ ...current, [FILE]: { state: 'hydrating' } })
    expect(current).toEqual({ 'other.md': { state: 'failed', error: 'Offline.' } })
  })
})

describe('History row status (rowStatus, RowStatusChip)', () => {
  it('shows a cloud-only row as Not downloaded, then Downloading…, then the failure reason', () => {
    const row = { notDownloaded: true }
    expect(rowStatus(row, undefined)).toMatchObject({ label: 'Not downloaded', live: false })
    expect(rowStatus(row, { state: 'hydrating' })).toMatchObject({ label: 'Downloading…', live: true })
    expect(rowStatus(row, { state: 'failed', error: 'Offline.' })).toMatchObject({ label: 'Download failed', title: 'Offline.', tone: 'danger' })
  })

  it('keeps the Locked chip for an undecryptable row and shows nothing on a plain row', () => {
    expect(rowStatus({ locked: true }, undefined)).toMatchObject({ label: 'Locked' })
    expect(rowStatus({}, undefined)).toBeNull()
  })

  it('writes every chip label and tooltip without an em dash (user-facing copy rule)', () => {
    const statuses = [
      rowStatus({ notDownloaded: true }, undefined),
      rowStatus({ notDownloaded: true }, { state: 'hydrating' }),
      rowStatus({ notDownloaded: true }, { state: 'failed', error: 'Offline.' }),
      rowStatus({ locked: true }, undefined)
    ]
    for (const status of statuses) {
      expect(status).not.toBeNull()
      expect(`${status?.label} ${status?.title}`).not.toContain('—')
    }
  })

  it('renders a live download as an announced status and nothing for a plain row', () => {
    const html = renderToStaticMarkup(<RowStatusChip meeting={{ notDownloaded: true }} hydration={{ state: 'hydrating' }} />)
    expect(html).toContain('role="status"')
    expect(html).toContain('Downloading…')
    expect(renderToStaticMarkup(<RowStatusChip meeting={{}} hydration={undefined} />)).toBe('')
  })
})
