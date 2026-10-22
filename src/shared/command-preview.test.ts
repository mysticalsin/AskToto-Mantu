import { describe, expect, it } from 'vitest'
import type { DesktopActionRequest } from './desktop-actions'
import { commandRiskNeedsConfirmation, desktopActionLabel, previewForDesktopAction } from './command-preview'

const note = (title: string): DesktopActionRequest => ({ id: 'desktop.create_note', args: { title } })

describe('previewForDesktopAction (main-built, allowlisted, never the transcript)', () => {
  it('shows a verb plus target and the exact quoted argument for a create', () => {
    expect(previewForDesktopAction(note('Groceries'), 'darwin')).toEqual({
      actionId: 'desktop.create_note',
      risk: 'create',
      appIconKey: 'notes',
      preview: { title: 'Create a note in Notes', argument: 'Groceries', confirmLabel: 'Create' }
    })
  })

  it('is a pure function of the request: nothing else (a transcript) can reach it', () => {
    const request = note('Groceries')
    expect(previewForDesktopAction.length).toBeLessThanOrEqual(2)
    const withStray = { ...request, transcript: 'create a note called Passwords' } as unknown as DesktopActionRequest
    expect(JSON.stringify(previewForDesktopAction(withStray, 'darwin'))).not.toContain('Passwords')
  })

  it('discloses the Windows difference for a note and for Photo Booth', () => {
    expect(previewForDesktopAction(note('Groceries'), 'win32')?.preview.title).toBe('Create a note in Notepad')
    const photo = previewForDesktopAction({ id: 'desktop.photo_booth_capture', args: {} }, 'win32')
    expect(photo?.risk).toBe('reversible')
    expect(photo?.preview).toMatchObject({ title: 'Open Camera', detail: 'Press the shutter yourself.' })
    expect(photo?.preview.argument).toBeUndefined()
  })

  it('treats search and opening an app as read and reversible, which never need a card by class', () => {
    expect(previewForDesktopAction({ id: 'desktop.google_search', args: { q: 'metis' } }, 'darwin')?.risk).toBe('read')
    expect(previewForDesktopAction({ id: 'desktop.open_notes', args: {} }, 'darwin')?.risk).toBe('reversible')
    expect(commandRiskNeedsConfirmation('read')).toBe(false)
    expect(commandRiskNeedsConfirmation('reversible')).toBe(false)
    for (const risk of ['create', 'send', 'type', 'delete'] as const) {
      expect(commandRiskNeedsConfirmation(risk)).toBe(true)
    }
  })

  it('refuses to preview an argument it would have to truncate, so the card never hides part of what runs', () => {
    expect(previewForDesktopAction(note('x'.repeat(240)), 'darwin')).not.toBeNull()
    expect(previewForDesktopAction(note('x'.repeat(241)), 'darwin')).toBeNull()
  })

  it.each([
    ['a control character', 'Groceries\u0007'],
    ['a newline', 'line one\nline two'],
    ['a bidirectional override', 'Groceries‮gnp.exe'],
    ['an isolate', 'a⁦b⁩']
  ])('refuses to preview an argument with %s, which could misrepresent what runs', (_name, title) => {
    expect(previewForDesktopAction(note(title), 'darwin')).toBeNull()
  })

  it('keeps accents, quotes and emoji verbatim', () => {
    expect(previewForDesktopAction(note('Réunion « équipe » 🎯 "ok"'), 'darwin')?.preview.argument).toBe(
      'Réunion « équipe » 🎯 "ok"'
    )
  })

  it('has a short label for every adapter, used by recovery copy', () => {
    expect(desktopActionLabel('desktop.create_note')).toBe('Create note')
    expect(desktopActionLabel('desktop.open_notes')).toBe('Open Notes')
  })

  it('returns null for an action id outside the allowlist', () => {
    expect(
      previewForDesktopAction({ id: 'desktop.format_disk', args: {} } as unknown as DesktopActionRequest)
    ).toBeNull()
  })
})
