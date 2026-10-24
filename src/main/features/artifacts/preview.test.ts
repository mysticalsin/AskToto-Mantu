import { describe, expect, it } from 'vitest'
import { ARTIFACT_PREVIEW_CSP } from '@shared/artifact'
import { buildPreviewDocument } from './preview'

describe('buildPreviewDocument (G55)', () => {
  it('escapes hostile text so it can never become markup, script or a link', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)><a href="https://evil.test">x</a>'
    const doc = buildPreviewDocument('notes.html', Buffer.from(hostile))
    expect(doc.ok).toBe(true)
    if (!doc.ok) return
    expect(doc.html).not.toContain('<script>alert')
    expect(doc.html).not.toContain('<img src=x')
    expect(doc.html).not.toMatch(/<a\s/i)
    expect(doc.html).toContain('&lt;script&gt;')
  })

  it('carries the strict CSP as the first thing in the document, with no script element at all', () => {
    const doc = buildPreviewDocument('a.txt', Buffer.from('hi'))
    if (!doc.ok) throw new Error('expected ok')
    expect(doc.html).toContain(`<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PREVIEW_CSP}">`)
    expect(doc.html.indexOf('Content-Security-Policy')).toBeLessThan(doc.html.indexOf('<body'))
    expect(doc.html).not.toMatch(/<script/i)
    expect(ARTIFACT_PREVIEW_CSP).toContain("default-src 'none'")
    expect(ARTIFACT_PREVIEW_CSP).toContain("script-src 'none'")
  })

  it('shows an image as an inline data URL of exactly the file bytes', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const doc = buildPreviewDocument('pic.PNG', bytes)
    if (!doc.ok) throw new Error('expected ok')
    expect(doc.html).toContain(`src="data:image/png;base64,${bytes.toString('base64')}"`)
  })

  it('refuses svg, pdf and unknown types: they are opened, never previewed', () => {
    for (const name of ['a.svg', 'a.pdf', 'a.exe', 'noext']) {
      expect(buildPreviewDocument(name, Buffer.from('x'))).toEqual({ ok: false, reason: 'unsupported' })
    }
  })

  it('refuses text over 1 MiB and images over 8 MiB', () => {
    expect(buildPreviewDocument('a.txt', Buffer.alloc(1024 * 1024 + 1))).toEqual({ ok: false, reason: 'too-large' })
    expect(buildPreviewDocument('a.png', Buffer.alloc(8 * 1024 * 1024 + 1))).toEqual({ ok: false, reason: 'too-large' })
  })

  it('escapes the title too', () => {
    const doc = buildPreviewDocument('<b>.txt', Buffer.from('x'))
    if (!doc.ok) throw new Error('expected ok')
    expect(doc.html).not.toContain('<b>')
  })
})
