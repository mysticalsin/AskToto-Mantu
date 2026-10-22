import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  googleSearchUrl,
  isAllowedBrowserUrl,
  noteHtml,
  noteText,
  planWindowsNote,
  windowsNoteStem,
  X_URL
} from './safe-targets'

describe('web search URL (URL schemes)', () => {
  it('encodes every query character, so text can never add a parameter, a scheme or a host', () => {
    const url = googleSearchUrl('a&b=c#frag?x /../ "quoted" 日本語 😀')
    expect(url).toBe('https://www.google.com/search?q=' + encodeURIComponent('a&b=c#frag?x /../ "quoted" 日本語 😀'))
    expect((url as string).slice('https://www.google.com/search?q='.length)).not.toMatch(/[&#" ?\/]/)
    expect(isAllowedBrowserUrl(url as string)).toBe(true)
    const parsed = new URL(url as string)
    expect([...parsed.searchParams.keys()]).toEqual(['q'])
    expect(parsed.searchParams.get('q')).toBe('a&b=c#frag?x /../ "quoted" 日本語 😀')
    expect(parsed.hash).toBe('')
  })

  it('a query that looks like a URL or a scheme stays a query', () => {
    for (const q of [
      'https://attacker.invalid/?x=1',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'x-apple.systempreferences:'
    ]) {
      const url = googleSearchUrl(q) as string
      expect(new URL(url).host).toBe('www.google.com')
      expect(new URL(url).protocol).toBe('https:')
      expect(isAllowedBrowserUrl(url)).toBe(true)
    }
  })

  it('returns null for a query that cannot be encoded (a lone surrogate)', () => {
    expect(googleSearchUrl('\ud800')).toBeNull()
  })
})

describe('browser URL allowlist', () => {
  it('accepts Google search with one q and the fixed X address', () => {
    expect(isAllowedBrowserUrl('https://www.google.com/search?q=cats')).toBe(true)
    expect(isAllowedBrowserUrl(X_URL)).toBe(true)
    expect(isAllowedBrowserUrl('https://x.com/')).toBe(true)
  })

  it.each([
    'http://www.google.com/search?q=cats',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'ftp://www.google.com/search?q=cats',
    'x-apple.systempreferences:com.apple.preference.security',
    'slack://open',
    'https://www.google.com.evil.invalid/search?q=cats',
    'https://evil.invalid/search?q=cats',
    'https://user:pw@www.google.com/search?q=cats',
    'https://www.google.com:8443/search?q=cats',
    'https://www.google.com/search?q=cats#x',
    'https://www.google.com/search?q=cats&hl=fr',
    'https://www.google.com/search?hl=fr',
    'https://www.google.com/search?q=',
    'https://www.google.com/url?q=https://evil.invalid',
    'https://x.com/intent/tweet?text=hi',
    'https://x.com/home',
    'https://twitter.com',
    'not a url',
    ''
  ])('refuses %s', (url) => {
    expect(isAllowedBrowserUrl(url)).toBe(false)
  })
})

describe('Apple Notes body (injection into markup)', () => {
  it('escapes every markup character of the title and the body', () => {
    const html = noteHtml('<b>t</b> & "q" \'s\'', '<script>alert(1)</script>\n\nline & two')
    expect(html).toBe(
      '<div><h1>&lt;b&gt;t&lt;/b&gt; &amp; &quot;q&quot; &#39;s&#39;</h1></div>' +
        '<div>&lt;script&gt;alert(1)&lt;/script&gt;</div><div><br></div><div>line &amp; two</div>'
    )
    expect(html).not.toMatch(/<script|<b>/)
  })

  it('a title alone is a title', () => {
    expect(noteHtml('Groceries')).toBe('<div><h1>Groceries</h1></div>')
  })
})

describe('Windows note file (path traversal)', () => {
  const DOCS = 'C:\\Users\\ana\\Documents'
  const DIR = 'C:\\Users\\ana\\Documents\\Métis Notes'

  it('a plain title becomes <documents>\\Métis Notes\\<title>.txt', () => {
    const plan = planWindowsNote(DOCS, 'Groceries')
    expect(plan?.directory).toBe(DIR)
    expect(plan?.pathFor(1)).toBe(`${DIR}\\Groceries.txt`)
    expect(plan?.pathFor(2)).toBe(`${DIR}\\Groceries (2).txt`)
  })

  it.each([
    '..\\..\\Windows\\System32\\evil',
    '../../etc/passwd',
    'C:\\Windows\\evil',
    '\\\\server\\share\\x',
    'a/b\\c',
    '..',
    '.',
    '...',
    'con',
    'CON.txt',
    'nul',
    'lpt1',
    'COM9',
    'name:stream',
    'trailing dot.',
    'trailing space ',
    '<>:"|?*',
    'a\u0000b'
  ])('title %j stays a direct child of the notes folder', (title) => {
    const plan = planWindowsNote(DOCS, title)
    expect(plan).not.toBeNull()
    for (const attempt of [1, 2, 20]) {
      const file = plan!.pathFor(attempt)
      expect(win32.dirname(file)).toBe(DIR)
      expect(win32.relative(DIR, file)).toBe(win32.basename(file))
      expect(win32.basename(file)).toMatch(/\.txt$/)
      expect(win32.basename(file)).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/)
      expect(win32.basename(file).replace(/ \(\d+\)\.txt$|\.txt$/, '')).not.toMatch(/[. ]$/)
    }
  })

  it('reserved device names are neutralised, with or without an extension', () => {
    expect(windowsNoteStem('con')).toBe('_con')
    expect(windowsNoteStem('NUL.txt')).toBe('_NUL.txt')
    expect(windowsNoteStem('lpt3')).toBe('_lpt3')
    expect(windowsNoteStem('console')).toBe('console')
  })

  it('caps the name length and falls back for an empty stem', () => {
    expect(windowsNoteStem('x'.repeat(300)).length).toBeLessThanOrEqual(100)
    expect(windowsNoteStem('???')).toBe('Note')
  })

  it('refuses a documents folder that is not an absolute Windows path', () => {
    expect(planWindowsNote('Documents', 'x')).toBeNull()
    expect(planWindowsNote('/home/ana/Documents', 'x')).toBeNull()
  })

  it('file text starts with a byte-order mark, the title, a blank line and the body', () => {
    expect(noteText('T', 'a\nb')).toBe('\ufeffT\r\n\r\na\r\nb\r\n')
    expect(noteText('T')).toBe('\ufeffT\r\n')
  })
})
