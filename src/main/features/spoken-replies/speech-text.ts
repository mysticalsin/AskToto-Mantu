/**
 * speech-text.ts — turns an assistant answer (markdown) into the text a voice reads.
 *
 * Pure and bounded. It removes what is useless or unpleasant aloud (code blocks, addresses, markup) and caps the
 * length. It is applied to the assistant's answer only; nothing here knows about meeting transcripts.
 */

/** A voice reads at most this many characters of one answer. Longer answers stay on screen in full. */
export const MAX_SPOKEN_CHARS = 4000

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

function cutAtSentence(text: string): string {
  if (text.length <= MAX_SPOKEN_CHARS) return text
  const head = text.slice(0, MAX_SPOKEN_CHARS)
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('\n'))
  // A sentence end in the last third only; otherwise a hard cut is kinder than dropping most of the answer.
  if (end > MAX_SPOKEN_CHARS * 0.66) return head.slice(0, end + 1).trimEnd()
  return head
}

export function toSpokenText(markdown: string): string {
  if (typeof markdown !== 'string' || markdown.length === 0) return ''
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/```[\s\S]*?(?:```|$)/g, '\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/gi, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)/, '')
        .replace(/[ \t]+/g, ' ')
        .trim()
    )
    .filter((line) => line.length > 0)
  return cutAtSentence(lines.join('\n'))
}
