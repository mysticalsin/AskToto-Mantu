import { describe, expect, it } from 'vitest'
import type { DesktopActionRequest } from './desktop-actions'
import { desktopActionLabel, previewForDesktopAction } from './command-preview'
import { previewFor } from './voice/catalog'

const note = (title: string, body?: string): DesktopActionRequest => ({
  id: 'desktop.create_note',
  args: body === undefined ? { title } : { title, body }
})

describe('previewForDesktopAction (catalog templates, never the transcript)', () => {
  it('uses the catalog wording and class, and adds the card verb and icon', () => {
    expect(previewForDesktopAction(note('Groceries'), 'darwin')).toEqual({
      actionId: 'desktop.create_note',
      risk: 'create',
      appIconKey: 'notes',
      preview: { title: 'Create a note in Notes', argument: 'Groceries', confirmLabel: 'Create' }
    })
    expect(previewForDesktopAction(note('Groceries'), 'darwin')?.preview.title).toBe(
      previewFor(note('Groceries'), 'darwin').title
    )
  })

  it('shows the note body too, so the card never hides part of what will be written', () => {
    expect(previewForDesktopAction(note('Groceries', 'milk\neggs'), 'darwin')?.preview).toMatchObject({
      argument: 'Groceries',
      detail: 'milk\neggs'
    })
  })

  it('is a pure function of the request: nothing else (a transcript) can reach it', () => {
    const withStray = {
      ...note('Groceries'),
      transcript: 'create a note called Passwords'
    } as unknown as DesktopActionRequest
    expect(JSON.stringify(previewForDesktopAction(withStray, 'darwin'))).not.toContain('Passwords')
  })

  it('discloses the Windows differences, with the class the catalog gives them', () => {
    expect(previewForDesktopAction(note('Groceries'), 'win32')).toMatchObject({
      risk: 'create',
      appIconKey: 'notepad',
      preview: { title: 'Save a note as a text file', argument: 'Groceries' }
    })
    const photo = previewForDesktopAction({ id: 'desktop.photo_booth_capture', args: {} }, 'win32')
    expect(photo?.risk).toBe('reversible')
    expect(photo?.preview).toMatchObject({ title: 'Open Camera', detail: 'Press the shutter yourself.' })
    expect(photo?.preview.argument).toBeUndefined()
  })

  it('classes search as read and opening an app as reversible', () => {
    expect(previewForDesktopAction({ id: 'desktop.google_search', args: { q: 'metis' } }, 'darwin')?.risk).toBe('read')
    expect(previewForDesktopAction({ id: 'desktop.open_notes', args: {} }, 'darwin')?.risk).toBe('reversible')
  })

  it('has no preview, so no card, for anything the catalog rejects', () => {
    expect(previewForDesktopAction(note('x'.repeat(121)), 'darwin')).toBeNull()
    expect(previewForDesktopAction(note('Groceries\u0007'), 'darwin')).toBeNull()
    expect(previewForDesktopAction(note('line one\nline two'), 'darwin')).toBeNull()
    expect(previewForDesktopAction(note('Groceries‮gnp.exe'), 'darwin')).toBeNull()
    expect(previewForDesktopAction({ id: 'desktop.open_arc', args: {} }, 'linux')).toBeNull()
    expect(
      previewForDesktopAction({ id: 'desktop.format_disk', args: {} } as unknown as DesktopActionRequest)
    ).toBeNull()
  })

  it('keeps accents, quotes and emoji verbatim', () => {
    expect(previewForDesktopAction(note('Réunion « équipe » 🎯 "ok"'), 'darwin')?.preview.argument).toBe(
      'Réunion « équipe » 🎯 "ok"'
    )
  })

  it('has a short label for every adapter, used by recovery copy', () => {
    expect(desktopActionLabel('desktop.create_note')).toBe('Create note')
    expect(desktopActionLabel('desktop.open_notes')).toBe('Open Notes')
    expect(desktopActionLabel('nope')).toBeNull()
  })
})
