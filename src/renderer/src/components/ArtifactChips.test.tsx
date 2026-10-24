import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ArtifactChip } from '@shared/artifact'
import { ArtifactChipList, ArtifactChips, settleArtifactAction } from './ArtifactChips'

const chip = (over: Partial<ArtifactChip> = {}): ArtifactChip => ({
  artifactId: 'art-1',
  turnId: 'turn-1',
  kind: 'document',
  displayName: 'notes.md',
  bytes: 2048,
  createdAt: 1,
  producer: 'tool',
  status: 'ready',
  ...over
})
const noop = (): void => {}
const list = (chips: ArtifactChip[], failure: string | null = null): string =>
  renderToStaticMarkup(
    <ArtifactChipList
      chips={chips}
      failure={failure}
      onOpen={noop}
      onReveal={noop}
      onPreview={noop}
      onCopy={noop}
      onArm={noop}
      onDrag={noop}
    />
  )

describe('ArtifactChips', () => {
  it('renders nothing for a turn with no artifacts, before a turn id exists, and before the bridge loads', () => {
    expect(list([])).toBe('')
    expect(renderToStaticMarkup(<ArtifactChips turnId={undefined} settled />)).toBe('')
    expect(renderToStaticMarkup(<ArtifactChips turnId="turn-1" settled={false} />)).toBe('')
  })

  it('shows a verified file as a draggable chip with open and reveal', () => {
    const html = list([chip()])
    expect(html).toContain('notes.md')
    expect(html).toContain('2 KB')
    expect(html).toContain('draggable="true"')
    expect(html).toContain('Open')
    expect(html).toContain('Show in folder')
  })

  it('says honestly that a missing or changed file was moved or changed, with no actions or drag', () => {
    for (const status of ['missing', 'changed'] as const) {
      const html = list([chip({ status })])
      expect(html).toContain('This file was moved or changed')
      expect(html).not.toContain('Open')
      expect(html).not.toContain('draggable')
    }
  })

  it('never renders a path', () => {
    expect(list([chip()])).not.toMatch(/[\\/]Users[\\/]|\.\.[\\/]/)
  })

  it('turns a failed or rejected open into the same honest notice, and success into none', async () => {
    expect(await settleArtifactAction(Promise.resolve({ ok: true }))).toBeNull()
    expect(await settleArtifactAction(Promise.resolve({ ok: false }))).toBe('This file was moved or changed')
    expect(await settleArtifactAction(Promise.reject(new Error('x')))).toBe('This file was moved or changed')
    expect(list([chip()], 'This file was moved or changed')).toContain('role="alert"')
  })

  it('offers preview and copy only for types main can preview, and never a PDF or svg', () => {
    expect(list([chip({ displayName: 'notes.md' })])).toContain('Preview')
    expect(list([chip({ displayName: 'pic.png', kind: 'image' })])).toContain('Copy')
    for (const displayName of ['a.pdf', 'a.svg', 'a.docx'])
      expect(list([chip({ displayName })])).not.toContain('Preview')
  })

  it('maps each failure reason to one fixed, content-free line', async () => {
    expect(await settleArtifactAction(Promise.resolve({ ok: false, reason: 'unsupported' }))).toContain(
      'only be opened'
    )
    expect(await settleArtifactAction(Promise.resolve({ ok: false, reason: 'too-large' }))).toContain('too large')
    expect(await settleArtifactAction(Promise.resolve({ ok: false, reason: 'failed' }))).toContain('did not work')
    expect(await settleArtifactAction(Promise.resolve({ ok: false, reason: 'missing' }))).toBe(
      'This file was moved or changed'
    )
  })
})
