import { describe, expect, it } from 'vitest'
import { recapMarkdownToHtml } from './transcripts-recap'

describe('recapMarkdownToHtml (PDF export)', () => {
  it('renders numbered lists, ### headings, nested bullets and bold, escaping the text first', () => {
    const html = recapMarkdownToHtml(
      '### Owners\n1. Send the **revised** quote\n2. Book <b>venue</b>\n- parent\n  - child\n\n**Note:** done'
    )
    expect(html).toContain('<h3>Owners</h3>')
    expect(html).toContain('<ol><li>Send the <strong>revised</strong> quote</li>')
    expect(html).toContain('<li>Book &lt;b&gt;venue&lt;/b&gt;</li></ol>')
    expect(html).toContain('<ul><li>parent<ul><li>child</li></ul></li></ul>')
    expect(html).toContain('<p><strong>Note:</strong> done</p>')
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('**')
  })

  it('keeps the original shape: ## headings, flat bullets, paragraphs', () => {
    const html = recapMarkdownToHtml('## Overview\n- one\n* two\n\nplain line')
    expect(html).toContain('<h2>Overview</h2>')
    expect(html).toContain('<ul><li>one</li>')
    expect(html).toContain('<li>two</li></ul>')
    expect(html).toContain('<p>plain line</p>')
  })

  it('leaves an unmatched ** alone and never emits markup from the model text', () => {
    const html = recapMarkdownToHtml('1. a ** b\n2. <script>alert(1)</script>')
    expect(html).toContain('<li>a ** b</li>')
    expect(html).not.toContain('<script>alert')
  })

  it('handles CRLF input', () => {
    const html = recapMarkdownToHtml('1. one\r\n2. two\r\n')
    expect(html).toContain('<ol><li>one</li><li>two</li></ol>')
  })
})
