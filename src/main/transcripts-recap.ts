import type { RecapExport } from '@shared/ipc'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escapes first, then turns **bold** into <strong>, so no markup from the model text ever survives. */
function inlineHtml(text: string): string {
  return escapeHtml(text).replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
}

type ListLevel = { indent: number; tag: 'ul' | 'ol' }

/**
 * Minimal, deterministic markdown→HTML for the recap shapes the prompts and the app's Markdown view produce:
 * ## and ### headings, "-"/"*" bullets and "1." numbered items (nested by indentation), **bold**, plain
 * paragraphs — not a general markdown parser. Used solely to print a recap to PDF via Electron's
 * webContents.printToPDF(); no npm dependency needed for that one job.
 */
export function recapMarkdownToHtml(markdown: string, title?: string): string {
  const body: string[] = []
  // Open lists, outermost first. Each item is left open (`<li>…`) so a deeper list can nest inside it.
  let levels: ListLevel[] = []
  let list = ''
  const closeLevel = (): void => {
    const top = levels[levels.length - 1]
    list += `</li></${top.tag}>`
    levels = levels.slice(0, -1)
  }
  const flushList = (): void => {
    while (levels.length) closeLevel()
    if (list) body.push(list)
    list = ''
  }
  const addItem = (indent: number, tag: 'ul' | 'ol', text: string): void => {
    while (levels.length && levels[levels.length - 1].indent > indent) closeLevel()
    const top = levels[levels.length - 1]
    if (top && top.indent === indent && top.tag === tag) {
      list += `</li><li>${inlineHtml(text)}`
      return
    }
    if (top && top.indent === indent) closeLevel() // same depth, other list kind: start the other kind
    list += `<${tag}><li>${inlineHtml(text)}`
    levels = [...levels, { indent, tag }]
  }
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const heading = /^(#{2,})\s+(.*)/.exec(line)
    const item = /^(\s*)([-*]|\d+[.)])\s+(.*)/.exec(line)
    if (heading) {
      flushList()
      const tag = heading[1].length === 2 ? 'h2' : 'h3'
      body.push(`<${tag}>${inlineHtml(heading[2])}</${tag}>`)
    } else if (item) {
      addItem(item[1].replace(/\t/g, '    ').length, /^\d/.test(item[2]) ? 'ol' : 'ul', item[3])
    } else if (line.trim()) {
      flushList()
      body.push(`<p>${inlineHtml(line)}</p>`)
    }
  }
  flushList()
  const style =
    'body{font-family:-apple-system,Helvetica,Arial,sans-serif;color:#1a1a1a;padding:32px;line-height:1.5}' +
    'h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.02em;' +
    'color:#444;margin:20px 0 8px}h3{font-size:13px;color:#333;margin:14px 0 6px}' +
    'ul,ol{margin:0 0 8px;padding-left:20px}li{margin-bottom:4px}p{margin:0 0 8px}'
  const heading = title ? `<h1>${escapeHtml(title)}</h1>` : ''
  const csp =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${style}</style></head><body>${heading}${body.join('\n')}</body></html>`
}

const RECAP_SECTION_ALIASES: Readonly<Record<string, string>> = {
  titre: 'title',
  etiquettes: 'tags',
  'mots-cles': 'tags',
  'mots cles': 'tags',
  resume: 'recap',
  synthese: 'overview',
  apercu: 'overview',
  "vue d'ensemble": 'overview',
  sujets: 'topics',
  'sujets abordes': 'topics',
  themes: 'topics',
  'themes abordes': 'topics',
  'questions-reponses': 'key q&a',
  'questions-reponses cles': 'key q&a',
  'questions et reponses': 'key q&a',
  'questions et reponses cles': 'key q&a',
  actions: 'action items',
  'actions a mener': 'action items',
  "points d'action": 'action items',
  "elements d'action": 'action items',
  'prochaines etapes': 'next steps',
  'etapes suivantes': 'next steps',
  suivis: 'follow-ups',
  'questions ouvertes': 'open questions',
  'questions en suspens': 'open questions',
  'citations notables': 'notable quotes',
  'citations marquantes': 'notable quotes'
}

export const foldRecapLabel =(text: string): string =>
  text.trim().normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'").toLowerCase()

export function recapSectionKey(text: string): string {
  const folded = foldRecapLabel(text)
  return Object.prototype.hasOwnProperty.call(RECAP_SECTION_ALIASES, folded) ? RECAP_SECTION_ALIASES[folded] : folded
}

/**
 * Parse a RECAP_PROMPT markdown document into a structured export (for piping into Jira/Asana/Notion).
 * Sections come from RECAP_PROMPT's fixed "## Name:" headings; action-item owners are pulled from the
 * common "task (Owner)" / "task — Owner" / "task - Owner" trailers when present. Best-effort: unknown or
 * reworded sections fall through to empty arrays, and the full original markdown is always included so
 * nothing is ever lost.
 */
export function parseRecapMarkdown(markdown: string): RecapExport {
  const md = typeof markdown === 'string' ? markdown : ''

  // Split on "## " headings; map each heading (colon-trimmed, lowercased) to its body up to the next "## ".
  // Models sometimes emit the content INLINE on the heading line ("## Title: Renault Contract Renewal")
  // instead of on the next line — the prompt's own "## Title: 2 to 4 words…" template invites that shape.
  // For KNOWN section names, split at the first colon and treat the remainder as the body's first line;
  // unknown headings keep the strict whole-line key so a legitimate colon in prose isn't mis-split.
  const KNOWN = new Set([
    'title',
    'tags',
    'overview',
    'topics',
    'key q&a',
    'key qa',
    'decisions',
    'action items',
    'next steps',
    'follow-ups',
    'follow ups',
    'open questions',
    'notable quotes',
    'recap',
    'outcome',
    'key numbers',
    'deal snapshot',
    'buying signals',
    'objections',
    'what the seller must know',
    'stakeholders',
    'candidate',
    'background',
    'motivations',
    'projects',
    'compensation and contract',
    'availability',
    'ratings',
    'strengths and concerns',
    'role',
    'questions and answers',
    'examples given',
    'next rounds',
    'positions',
    'interests',
    'concessions',
    'agreed terms',
    'still open',
    'what landed',
    'audience questions',
    'confusion or pushback',
    'follow-ups promised',
    'reported problem',
    'steps tried',
    'resolution',
    'how the call went',
    'qualifying facts',
    'commitment'
  ])
  const sections: Record<string, string> = {}
  for (const part of md.split(/^##\s+/m)) {
    const nl = part.indexOf('\n')
    const headRaw = (nl === -1 ? part : part.slice(0, nl)).trim()
    let body = nl === -1 ? '' : part.slice(nl + 1).trim()
    let heading = recapSectionKey(headRaw.replace(/:\s*$/, ''))
    const colon = headRaw.indexOf(':')
    if (colon > 0 && colon < headRaw.length - 1) {
      const maybeKey = recapSectionKey(headRaw.slice(0, colon))
      if (KNOWN.has(maybeKey)) {
        heading = maybeKey
        const inline = headRaw.slice(colon + 1).trim()
        body = body ? `${inline}\n${body}` : inline
      }
    }
    if (heading) sections[heading] = body
  }

  const bullets = (text: string | undefined): string[] =>
    (text || '')
      .split('\n')
      .map((l) => l.replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, '').trim()) // strip bullet + optional [ ]/[x] checkbox
      .filter((l) => l.length > 0 && !/^(?:none|aucun(?:e|s|es)?|neant)\.?$/.test(foldRecapLabel(l)))

  // Best-effort trailing "by <phrase>" clause on the OWNER-STRIPPED text (e.g. "Send the deck by Friday"
  // → dueDateText "Friday"). Never parsed into a Date — RECAP_PROMPT only asks the model for "an owner
  // when stated", never a structured date, so this is display text only (see RecapExportSchema).
  const splitDueDate = (text: string): { text: string; dueDateText: string | null } => {
    const by = text.match(/^(.*\S)\s+by\s+(.+)$/i)
    return by ? { text: by[1].trim(), dueDateText: by[2].trim() } : { text, dueDateText: null }
  }

  // Wave 1D / QA: SUMMARY_PROMPT uses "## Next steps" (and historically "**Follow-ups**"); RECAP_PROMPT
  // uses "## Action items". Prefer the first non-empty body so local summaries feed Book-next-steps,
  // wiki publish, and RecapExport the same way cloud recaps do.
  const actionBody =
    sections['action items'] ||
    sections['next steps'] ||
    sections['follow-ups'] ||
    sections['follow ups'] ||
    sections['follow-ups promised'] ||
    sections['commitment'] ||
    ''
  const actionItems = bullets(actionBody).map((raw) => {
    // "Do the thing (Alice)". Non-greedy text + a paren-free owner anchored to the end, so a stray inner
    // paren (e.g. "(Alice (boss))") degrades gracefully to owner:null rather than a wrong split.
    const paren = raw.match(/^(.*?\S)\s*\(([^()]+)\)\s*$/)
    if (paren) return { ...splitDueDate(paren[1].trim()), owner: paren[2].trim() }
    const dash = raw.match(/^(.*\S)\s+[—-]\s+(.+)$/) // "Do the thing — Alice" / "Do the thing - Alice"
    if (dash) return { ...splitDueDate(dash[1].trim()), owner: dash[2].trim() }
    return { ...splitDueDate(raw), owner: null as string | null }
  })

  // "## Title:" body — first line only, wrapping quotes/emphasis (models mirror the prompt's quoted
  // example) and trailing punctuation stripped, capped for filename/UI safety.
  const titleBody = (sections['title'] || '').split('\n')[0].trim()
  const title24 = titleBody
    .replace(/^["'“”*_\s]+|["'“”*_\s]+$/g, '')
    .replace(/[.!?,;:]+$/, '')
    .trim()
    .slice(0, 60)

  // "## Tags:" body — usually one comma-separated line, but tolerate the model emitting a bullet list.
  // Tags feed unquoted YAML flow-sequence frontmatter and React keys, so strip quote/bracket/backslash
  // characters, dedup case-insensitively, cap at 5.
  const tagsSection = sections['tags'] || ''
  const tagList = /^\s*[-*]/m.test(tagsSection) ? bullets(tagsSection) : [tagsSection]
  const tags: string[] = []
  const seenTags = new Set<string>()
  for (const raw of tagList.flatMap((t) => t.split(/[,\n]/))) {
    const tag = raw.replace(/["'“”\\[\]]/g, '').trim()
    if (!tag || seenTags.has(tag.toLowerCase())) continue
    seenTags.add(tag.toLowerCase())
    tags.push(tag)
    if (tags.length === 5) break
  }

  return {
    title24,
    tags,
    // SUMMARY_PROMPT's first section used to be "**Recap**" / "## Recap"; RECAP uses "## Overview".
    overview: sections['overview'] || sections['recap'] || sections['outcome'] || '',
    topics: bullets(sections['topics']),
    keyQA: bullets(sections['key q&a'] || sections['key qa']),
    decisions: bullets(sections['decisions']),
    actionItems,
    openQuestions: bullets(sections['open questions']),
    notableQuotes: bullets(sections['notable quotes']),
    markdown: md
  }
}
