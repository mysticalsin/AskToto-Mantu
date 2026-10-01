import { describe, expect, it } from 'vitest'
import {
  hasMeetingFlag,
  parse,
  readMeetingFields,
  serialize,
  setMeetingField,
  stripMeetingFrontmatter
} from './meeting-document'

const LF = '---\ntype: meeting-transcript\ntitle: "Weekly sync"\nconfidential: true\n---\n\n# Weekly sync\n'
const CRLF = LF.replace(/\n/g, '\r\n')

describe('meeting-document codec', () => {
  it('parses LF frontmatter into lines, eol and body', () => {
    expect(parse(LF)).toEqual({
      lines: ['type: meeting-transcript', 'title: "Weekly sync"', 'confidential: true'],
      eol: '\n',
      body: '\n\n# Weekly sync\n'
    })
  })

  it('parses CRLF frontmatter with no carriage return left in a line', () => {
    expect(parse(CRLF)).toEqual({
      lines: ['type: meeting-transcript', 'title: "Weekly sync"', 'confidential: true'],
      eol: '\r\n',
      body: '\r\n\r\n# Weekly sync\r\n'
    })
    expect(readMeetingFields(CRLF)).toEqual({ type: 'meeting-transcript', title: 'Weekly sync', confidential: 'true' })
  })

  it('round-trips LF and CRLF byte for byte', () => {
    expect(serialize(parse(LF)!)).toBe(LF)
    expect(serialize(parse(CRLF)!)).toBe(CRLF)
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
    expect(parse('# Just a heading\n')).toBeNull()
    expect(readMeetingFields('# Just a heading\n')).toEqual({})
    expect(stripMeetingFrontmatter('# Just a heading\n')).toBe('# Just a heading\n')
  })

  it('treats unclosed frontmatter as no block, in LF and CRLF', () => {
    expect(parse('---\ntype: x\nconfidential: true\n')).toBeNull()
    expect(parse('---\r\ntype: x\r\nconfidential: true\r\n')).toBeNull()
    expect(readMeetingFields('---\ntype: x\n')).toEqual({})
  })

  it('tolerates trailing spaces or tabs after the delimiters and keeps the eol from the opening line', () => {
    const doc = parse('---\t\r\ntype: x\r\nconfidential: true\r\n--- \r\n\r\nbody')
    expect(doc).toEqual({ lines: ['type: x', 'confidential: true'], eol: '\r\n', body: '\r\n\r\nbody' })
    expect(parse('---\ntype: x\n---  \nbody')?.eol).toBe('\n')
  })

  it('hasMeetingFlag is true when any duplicate line is true and false without a block', () => {
    expect(hasMeetingFlag('---\nconfidential: true\nconfidential: false\n---\n', 'confidential')).toBe(true)
    expect(hasMeetingFlag('---\nconfidential: "true"\n---\n', 'confidential')).toBe(true)
    expect(hasMeetingFlag('---\nconfidential: false\n---\n', 'confidential')).toBe(false)
    expect(hasMeetingFlag('confidential: true\n', 'confidential')).toBe(false)
  })

  it('does not close on a line that merely starts with three dashes', () => {
    expect(parse('---\ntype: x\n----\nmore\n')).toBeNull()
  })

  it('reads a summary-only meeting document', () => {
    const text = '---\ntype: meeting-summary\ntitle: "Recap"\n---\n\n## Notes & follow-ups\n\nx\n\n## Retention\n'
    expect(readMeetingFields(text).type).toBe('meeting-summary')
    expect(stripMeetingFrontmatter(text)).toBe('\n## Notes & follow-ups\n\nx\n\n## Retention\n')
  })

  it('strips the frontmatter block and the line ending after it for LF and CRLF', () => {
    expect(stripMeetingFrontmatter('---\na: 1\n---\nbody')).toBe('body')
    expect(stripMeetingFrontmatter('---\r\na: 1\r\n---\r\nbody')).toBe('body')
  })

  it('sets, replaces and removes a field without changing the line ending', () => {
    const doc = parse(CRLF)!
    expect(serialize(setMeetingField(doc, 'recap_status', 'ready'))).toBe(
      CRLF.replace('confidential: true\r\n', 'confidential: true\r\nrecap_status: ready\r\n')
    )
    expect(serialize(setMeetingField(doc, 'confidential', null))).toBe(
      CRLF.replace('confidential: true\r\n', '')
    )
    expect(serialize(setMeetingField(doc, 'title', '"Renamed $&"'))).toContain('title: "Renamed $&"\r\n')
  })
})
