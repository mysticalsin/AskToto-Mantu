/**
 * Allow-list sanitizer for Shiki's highlighter output.
 *
 * CodeBlock renders model-produced fences through `dangerouslySetInnerHTML`. Shiki emits a small
 * set of tags (`pre`/`code`/`span`) with `class`/`style`/`tabindex`. Anything else — a coerced
 * model payload, a highlighter bug — is dropped rather than painted.
 */

const ALLOWED_TAGS = new Set(['pre', 'code', 'span'])
const ALLOWED_ATTR = new Set(['class', 'style', 'tabindex'])

const DANGEROUS = /<script|<iframe|<object|<embed|<svg|<link|<meta|<style[\s/>]|javascript:|on\w+\s*=/i

function sanitizeStyle(value: string): string | null {
  if (/url\s*\(|expression\s*\(|javascript:|@import/i.test(value)) return null
  return value
}

function sanitizeOpenTag(tag: string, rawAttrs: string): string {
  const kept: string[] = []
  const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(rawAttrs))) {
    const key = m[1].toLowerCase()
    if (!ALLOWED_ATTR.has(key)) continue
    const val = m[2] ?? m[3] ?? m[4] ?? ''
    if (key === 'style') {
      const cleaned = sanitizeStyle(val)
      if (cleaned) kept.push(`style="${cleaned.replace(/"/g, '')}"`)
    } else if (key === 'class') {
      if (/^[A-Za-z0-9 _-]+$/.test(val)) kept.push(`class="${val}"`)
    } else if (key === 'tabindex') {
      if (/^-?\d+$/.test(val)) kept.push(`tabindex="${val}"`)
    }
  }
  return kept.length ? `<${tag} ${kept.join(' ')}>` : `<${tag}>`
}

/** Strip anything Shiki does not emit. Returns '' when the blob looks hostile so the caller can fall back to text. */
export function sanitizeShikiHtml(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return ''
  if (DANGEROUS.test(html)) return ''
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (full, tag: string, attrs: string) => {
    const name = tag.toLowerCase()
    if (!ALLOWED_TAGS.has(name)) return ''
    if (full.startsWith('</')) return `</${name}>`
    return sanitizeOpenTag(name, attrs)
  })
}
