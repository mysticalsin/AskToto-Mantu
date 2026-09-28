import { describe, expect, it } from 'vitest'
import {
  parseMeetingDocument,
  readMeetingFields,
  serializeMeetingDocument,
  setMeetingField,
  stripMeetingFrontmatter
} from './meeting-document'

const LF = '---\ntype: meeting-transcript\ntitle: "Weekly sync"\nconfidential: true\n---\n\n# Weekly sync\n'
const CRLF = LF.replace(/\n/g, '\r\n')

describe('meeting-document codec', () => {
  it('parses LF frontmatter into lines, eol and body', () => {
    expect(parseMeetingDocument(LF)).toEqual({
      lines: ['type: meeting-transcript', 'title: "Weekly sync"', 'confidential: true'],
      eol: '\n',
      body: '\n\n# Weekly sync\n'
    })
  })

  it('parses CRLF frontmatter with no carriage return left in a line', () => {
    expect(parseMeetingDocument(CRLF)).toEqual({
      lines: ['type: meeting-transcript', 'title: "Weekly sync"', 'confidential: true'],
      eol: '\r\n',
      body: '\r\n\r\n# Weekly sync\r\n'
    })
    expect(readMeetingFields(CRLF)).toEqual({ type: 'meeting-transcript', title: 'Weekly sync', confidential: 'true' })
  })

  it('round-trips LF and CRLF byte for byte', () => {
    expect(serializeMeetingDocument(parseMeetingDocument(LF)!)).toBe(LF)
    expect(serializeMeetingDocument(parseMeetingDocument(CRLF)!)).toBe(CRLF)
  })

  it('decodes quoted scalars, escaped quotes and backslashes; strips brackets from flow lists', () => {
    const text = '---\ntitle: "Say \\"hi\\" to C:\\\\temp"\ntags: [a, b]\ndate: 2026-01-01T10:00:00Z\n---\nbody'
    expect(readMeetingFields(text)).toEqual({
      title: 'Say "hi" to C:\\temp',
      tags: 'a, b',
      date: '2026-01-01T10:00:00Z'
    })
  })

  it('returns no block and empty fields when frontmatter is missing', () => {
    expect(parseMeetingDocument('# Just a heading\n')).toBeNull()
    expect(readMeetingFields('# Just a heading\n')).toEqual({})
    expect(stripMeetingFrontmatter('# Just a heading\n')).toBe('# Just a heading\n')
  })

  it('treats unclosed frontmatter as no block, in LF and CRLF', () => {
    expect(parseMeetingDocument('---\ntype: x\nconfidential: true\n')).toBeNull()
    expect(parseMeetingDocument('---\r\ntype: x\r\nconfidential: true\r\n')).toBeNull()
    expect(readMeetingFields('---\ntype: x\n')).toEqual({})
  })

  it('does not close on a line that merely starts with three dashes', () => {
    expect(parseMeetingDocument('---\ntype: x\n----\nmore\n')).toBeNull()
  })

  it('reads a summary-only meeting document', () => {
    const text = '---\ntype: meeting-summary\ntitle: "Recap"\n---\n\n## Notes & follow-ups\n\nx\n\n## Retention\n'
    expect(readMeetingFields(text).type).toBe('meeting-summary')
    expect(stripMeetingFrontmatter(text).startsWith('## Notes & follow-ups')).toBe(true)
  })

  it('strips the frontmatter block and the line ending after it for LF and CRLF', () => {
    expect(stripMeetingFrontmatter('---\na: 1\n---\nbody')).toBe('body')
    expect(stripMeetingFrontmatter('---\r\na: 1\r\n---\r\nbody')).toBe('body')
  })

  it('sets, replaces and removes a field without changing the line ending', () => {
    const doc = parseMeetingDocument(CRLF)!
    expect(serializeMeetingDocument(setMeetingField(doc, 'recap_status', 'ready'))).toBe(
      CRLF.replace('confidential: true\r\n', 'confidential: true\r\nrecap_status: ready\r\n')
    )
    expect(serializeMeetingDocument(setMeetingField(doc, 'confidential', null))).toBe(
      CRLF.replace('confidential: true\r\n', '')
    )
    expect(serializeMeetingDocument(setMeetingField(doc, 'title', '"Renamed $&"'))).toContain('title: "Renamed $&"\r\n')
  })
})
