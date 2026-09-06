import { describe, expect, it } from 'vitest'
import { sanitizeShikiHtml } from './sanitize-html'

const SHIKI = `<pre class="shiki github-dark" style="background-color:#24292e;color:#e1e4e8" tabindex="0"><code><span class="line"><span style="color:#E1E4E8">const x = 1</span></span></code></pre>`

describe('sanitizeShikiHtml', () => {
  it('keeps Shiki pre/code/span with class, style, and tabindex', () => {
    const out = sanitizeShikiHtml(SHIKI)
    expect(out).toContain('<pre')
    expect(out).toContain('<code>')
    expect(out).toContain('class="shiki github-dark"')
    expect(out).toContain('style="background-color:#24292e;color:#e1e4e8"')
    expect(out).toContain('tabindex="0"')
    expect(out).toContain('const x = 1')
  })

  it('returns empty for script, event handlers, and javascript: URLs', () => {
    expect(sanitizeShikiHtml('<pre><script>alert(1)</script></pre>')).toBe('')
    expect(sanitizeShikiHtml('<pre onclick="alert(1)">x</pre>')).toBe('')
    expect(sanitizeShikiHtml('<pre><a href="javascript:alert(1)">x</a></pre>')).toBe('')
    expect(sanitizeShikiHtml('<iframe src="https://evil.example"></iframe>')).toBe('')
  })

  it('strips non-allowlisted tags and attributes from otherwise-safe markup', () => {
    const out = sanitizeShikiHtml('<pre class="shiki" data-evil="1"><img src=x><span>ok</span></pre>')
    expect(out).toBe('<pre class="shiki"><span>ok</span></pre>')
    expect(out).not.toContain('img')
    expect(out).not.toContain('data-evil')
  })

  it('drops style values that try to load a URL', () => {
    const out = sanitizeShikiHtml('<span style="background:url(https://evil.example)">x</span>')
    expect(out).toBe('<span>x</span>')
  })
})
