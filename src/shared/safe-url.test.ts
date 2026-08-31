import { describe, expect, it } from 'vitest'
import { safeHref } from './safe-url'

describe('safeHref', () => {
  it('allows http(s) and mailto', () => {
    expect(safeHref('https://teams.microsoft.com/l/meetup-join/1')).toMatch(/^https:\/\//)
    expect(safeHref('http://localhost:3000/join')).toMatch(/^http:\/\//)
    expect(safeHref('mailto:ops@example.com')).toBe('mailto:ops@example.com')
  })

  it('refuses javascript, data, file, and other executable schemes', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ms-msdt:foo',
      'search-ms:bar',
      '//evil.example/path',
      'https://evil.example\njavascript:alert(1)'
    ]) {
      expect(safeHref(bad)).toBeNull()
    }
  })

  it('refuses empty, oversized, and non-string values', () => {
    expect(safeHref('')).toBeNull()
    expect(safeHref(null)).toBeNull()
    expect(safeHref('https://' + 'a'.repeat(3000))).toBeNull()
  })
})
