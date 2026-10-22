import { describe, expect, it } from 'vitest'
import { DESKTOP_ADAPTER_IDS, type DesktopActionRequest } from '../desktop-actions'
import {
  classifyDesktopRequest,
  isCatalogActionId,
  previewFor,
  validateDesktopRequest,
  verificationFor,
  voicePlatformOf
} from './catalog'

const req = (r: DesktopActionRequest): DesktopActionRequest => r

describe('voice catalog: validation is the argument boundary', () => {
  it('accepts every catalog action with bounded arguments', () => {
    expect(validateDesktopRequest({ id: 'desktop.open_notes', args: {} })).toEqual({
      id: 'desktop.open_notes',
      args: {}
    })
    expect(
      validateDesktopRequest({ id: 'desktop.create_note', args: { title: 'Groceries', body: 'milk\neggs' } })
    ).toEqual({
      id: 'desktop.create_note',
      args: { title: 'Groceries', body: 'milk\neggs' }
    })
    expect(validateDesktopRequest({ id: 'desktop.google_search', args: { q: 'a b', browser: 'arc' } })).not.toBeNull()
    expect(validateDesktopRequest({ id: 'desktop.open_x', args: { browser: 'arc' } })).not.toBeNull()
  })

  it('returns a frozen copy holding only the known fields', () => {
    const input = { id: 'desktop.google_search', args: { q: 'x' } }
    const out = validateDesktopRequest(input) as DesktopActionRequest
    expect(out).not.toBe(input)
    expect(Object.isFrozen(out)).toBe(true)
    expect(Object.isFrozen(out.args)).toBe(true)
  })

  it.each([
    ['unknown id', { id: 'shell.exec', args: {} }],
    ['an id from another namespace', { id: 'apps.open', args: {} }],
    ['extra argument', { id: 'desktop.open_notes', args: { app: 'Terminal' } }],
    ['extra top-level field', { id: 'desktop.open_notes', args: {}, command: 'rm' }],
    ['missing title', { id: 'desktop.create_note', args: {} }],
    ['empty title', { id: 'desktop.create_note', args: { title: '' } }],
    ['blank title', { id: 'desktop.create_note', args: { title: '   ' } }],
    ['padded title', { id: 'desktop.create_note', args: { title: ' x ' } }],
    ['title over 120', { id: 'desktop.create_note', args: { title: 'x'.repeat(121) } }],
    ['body over 2000', { id: 'desktop.create_note', args: { title: 'x', body: 'b'.repeat(2001) } }],
    ['query over 200', { id: 'desktop.google_search', args: { q: 'q'.repeat(201) } }],
    ['non-string query', { id: 'desktop.google_search', args: { q: 5 } }],
    ['an unknown browser', { id: 'desktop.google_search', args: { q: 'x', browser: 'chrome' } }],
    ['newline in a title', { id: 'desktop.create_note', args: { title: 'a\nb' } }],
    ['control character in a query', { id: 'desktop.google_search', args: { q: 'a\u0000b' } }],
    ['bidirectional override', { id: 'desktop.create_note', args: { title: 'a\u202eb' } }],
    ['line separator', { id: 'desktop.google_search', args: { q: 'a\u2028b' } }],
    ['byte order mark', { id: 'desktop.create_note', args: { title: '\ufeffa' } }],
    ['null', null],
    ['a string', 'desktop.open_notes']
  ])('rejects %s', (_label, raw) => {
    expect(validateDesktopRequest(raw)).toBeNull()
  })

  it('keeps quotes, script words and emoji as valid text (the adapters make them harmless)', () => {
    for (const title of ['say "hi"', 'end tell', '& do shell script "id"', "it's", '😀 👩‍💻', 'a;b|c`d`$(e)']) {
      expect(validateDesktopRequest({ id: 'desktop.create_note', args: { title } }), title).not.toBeNull()
    }
  })

  it('allows a multi-line body with tabs but no other control characters', () => {
    expect(
      validateDesktopRequest({ id: 'desktop.create_note', args: { title: 't', body: 'a\n\tb\r\nc' } })
    ).not.toBeNull()
    expect(validateDesktopRequest({ id: 'desktop.create_note', args: { title: 't', body: 'a\u0007b' } })).toBeNull()
  })

  it('covers exactly the adapter ids', () => {
    for (const id of DESKTOP_ADAPTER_IDS) expect(isCatalogActionId(id)).toBe(true)
    expect(isCatalogActionId('desktop.delete_everything')).toBe(false)
  })
})

describe('voice catalog: classes per platform', () => {
  it('classes follow the owner rule: read and reversible run, create waits for the card', () => {
    expect(classifyDesktopRequest(req({ id: 'desktop.google_search', args: { q: 'x' } }), 'darwin')).toBe('read')
    expect(classifyDesktopRequest(req({ id: 'desktop.open_notes', args: {} }), 'darwin')).toBe('reversible')
    expect(classifyDesktopRequest(req({ id: 'desktop.open_arc', args: {} }), 'darwin')).toBe('reversible')
    expect(classifyDesktopRequest(req({ id: 'desktop.open_x', args: {} }), 'darwin')).toBe('reversible')
    expect(classifyDesktopRequest(req({ id: 'desktop.create_note', args: { title: 't' } }), 'darwin')).toBe('create')
    expect(classifyDesktopRequest(req({ id: 'desktop.photo_booth_capture', args: {} }), 'darwin')).toBe('create')
  })

  it('Windows only opens Camera (reversible) and cannot run Arc, with or without naming it', () => {
    expect(classifyDesktopRequest(req({ id: 'desktop.photo_booth_capture', args: {} }), 'win32')).toBe('reversible')
    expect(classifyDesktopRequest(req({ id: 'desktop.open_arc', args: {} }), 'win32')).toBeNull()
    expect(
      classifyDesktopRequest(req({ id: 'desktop.google_search', args: { q: 'x', browser: 'arc' } }), 'win32')
    ).toBeNull()
    expect(classifyDesktopRequest(req({ id: 'desktop.open_x', args: { browser: 'arc' } }), 'win32')).toBeNull()
    expect(classifyDesktopRequest(req({ id: 'desktop.google_search', args: { q: 'x' } }), 'win32')).toBe('read')
  })

  it('no action exists on an unsupported platform', () => {
    for (const id of DESKTOP_ADAPTER_IDS) {
      const request = validateDesktopRequest({
        id,
        args: id === 'desktop.create_note' ? { title: 't' } : id === 'desktop.google_search' ? { q: 'q' } : {}
      })
      expect(classifyDesktopRequest(request as DesktopActionRequest, voicePlatformOf('linux'))).toBeNull()
    }
  })

  it('only note creation on Windows can be read back; URL hand-offs never can', () => {
    expect(verificationFor(req({ id: 'desktop.create_note', args: { title: 't' } }), 'win32')).toBe('readback')
    expect(verificationFor(req({ id: 'desktop.google_search', args: { q: 'x' } }), 'darwin')).toBe('handoff')
    expect(verificationFor(req({ id: 'desktop.open_notes', args: {} }), 'darwin')).toBe('readback')
  })
})

describe('voice catalog: card preview comes from templates and validated arguments', () => {
  it("describes each action in the person's terms", () => {
    expect(previewFor(req({ id: 'desktop.create_note', args: { title: 'Groceries' } }))).toEqual({
      title: 'Create a note in Notes',
      argument: 'Groceries'
    })
    expect(previewFor(req({ id: 'desktop.google_search', args: { q: 'cats', browser: 'arc' } }))).toEqual({
      title: 'Search Google in Arc',
      argument: 'cats'
    })
    expect(previewFor(req({ id: 'desktop.photo_booth_capture', args: {} }), 'win32')).toEqual({ title: 'Open Camera' })
    expect(previewFor(req({ id: 'desktop.create_note', args: { title: 'T' } }), 'win32').title).toMatch(/text file/)
  })
})
