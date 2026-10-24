import {
  ARTIFACT_PREVIEW_CSP,
  artifactContentType,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_TEXT_MAX_BYTES
} from '@shared/artifact'

export type PreviewDocument = { ok: true; html: string } | { ok: false; reason: 'unsupported' | 'too-large' }

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PREVIEW_CSP}">` +
  `<title>${escapeHtml(title)}</title>` +
  `<style>:root{color-scheme:light dark}body{margin:16px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}` +
  `pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}` +
  `img{max-width:100%;height:auto;display:block}</style></head><body>${body}</body></html>`

/**
 * The one document a preview window loads (G55), built from bytes main already verified against the artifact's digest.
 * Text of any kind (markdown, HTML, JSON) is shown as escaped source and images as an inline data URL, so there is no
 * script, no link and nothing to fetch: the CSP is a second lock, not the only one. Anything else has no preview.
 */
export function buildPreviewDocument(displayName: string, bytes: Buffer): PreviewDocument {
  const type = artifactContentType(displayName)
  if (!type) return { ok: false, reason: 'unsupported' }
  if (type === 'text') {
    if (bytes.length > PREVIEW_TEXT_MAX_BYTES) return { ok: false, reason: 'too-large' }
    return { ok: true, html: page(displayName, `<pre>${escapeHtml(bytes.toString('utf8'))}</pre>`) }
  }
  if (bytes.length > PREVIEW_IMAGE_MAX_BYTES) return { ok: false, reason: 'too-large' }
  const ext = displayName.slice(displayName.lastIndexOf('.')).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (!mime) return { ok: false, reason: 'unsupported' }
  return {
    ok: true,
    html: page(
      displayName,
      `<img alt="${escapeHtml(displayName)}" src="data:${mime};base64,${bytes.toString('base64')}">`
    )
  }
}
