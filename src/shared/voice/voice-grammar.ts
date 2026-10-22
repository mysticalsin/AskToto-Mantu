/**
 * The multilingual command grammar (V03): English, French, Portuguese and Spanish, deterministic, pure.
 *
 * A held-chord utterance becomes exactly one of: a catalog action with typed, bounded slots; a question for
 * the Ask path; a cancellation ("never mind"); an incomplete request; an action Métis does not support; or
 * nothing recognised (the router may then offer it to a classifier). The grammar never executes anything and
 * never decides policy: it only names a request. `validateDesktopRequest` has the last word on every slot.
 *
 * Slot text is verbatim. Matching is accent- and case-insensitive through the patterns themselves, and the text
 * a slot captures is the person's own characters (accents, quotes, emoji), cleaned only of surrounding spaces,
 * trailing sentence punctuation and one matched pair of outer quotes. The wake word is dropped only at the very
 * start, so a title that contains "Métis" keeps it.
 */
import type { DesktopActionRequest, DesktopAdapterId } from '../desktop-actions'
import { NOTE_BODY_MAX_CHARS, NOTE_TITLE_MAX_CHARS, SEARCH_QUERY_MAX_CHARS, validateDesktopRequest } from './catalog'

export type VoiceUtterance =
  | { kind: 'action'; request: DesktopActionRequest }
  | { kind: 'question'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'incomplete'; missing: 'title' | 'query' | 'too_long' }
  | { kind: 'unsupported' }
  | { kind: 'none' }

/** Longer than a 15 s hold can say: not a command. */
const MAX_UTTERANCE_CHARS = 4_000

/** `\b` is ASCII-only in JavaScript, so a boundary after an accented letter is spelled out. */
const END = '(?![\\p{L}\\p{N}])'
const rx = (source: string): RegExp => new RegExp(source, 'iu')

const WAKE_LEAD = rx(`^(?:(?:hey|hi|ok|okay|ola|olá|oi|ei|salut|dis|hola)[\\s,]+)?m[eé]tis${END}[\\s,:;.!?\\-]*`)
const POLITE_LEAD = rx(
  '^(?:' +
    [
      `(?:please|pls|okay|ok|hey|por favor|s['’]il (?:te|vous) pla[iî]t)[\\s,]+`,
      `(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?`,
      `(?:i['’]d like you to|i would like you to|i want you to|i need you to|i['’]d like to|i want to)\\s+`,
      `(?:peux-tu|peux tu|pouvez-vous|pouvez vous|pourrais-tu|pourriez-vous|tu peux|vous pouvez|peux)\\s+`,
      `(?:você pode|voce pode|tu podes|podes|pode|poderia|podias)\\s+`,
      `(?:puedes|puede|podrías|podrias|podría|podria)\\s+`
    ].join('|') +
    ')+'
)
const POLITE_TAIL = rx(`[\\s,]*(?:please|pls|por favor|svp|stp|s['’]il (?:te|vous) pla[iî]t)\\s*$`)

const NEGATION_LEAD = rx(
  '^(?:actually[, ]+)?(?:' +
    [
      "don['’]t",
      'do not',
      'never ?mind',
      'cancel(?: that)?',
      'stop(?: that)?',
      'forget (?:it|that)',
      'scratch that',
      'abort',
      'annule(?:r)?(?: ça| cela)?',
      'laisse tomber',
      'oublie(?: ça)?',
      'ne fais pas',
      'ne le fais pas',
      'arrête',
      'cancela(?:r)?(?: isso)?',
      'deixa pra lá',
      'deixa isso',
      'esquece(?: isso)?',
      'não faça',
      'não faz',
      'cancela eso',
      'olvídalo',
      'olvidalo',
      'déjalo',
      'dejalo',
      'no lo hagas',
      'no hagas'
    ].join('|') +
    `)${END}`
)
const NEGATION_TAIL = rx(
  '(?:^|[\\s,.;])(?:actually[, ]+)?(?:' +
    [
      'never ?mind',
      "don['’]t",
      'do not',
      'scratch that',
      'cancel that',
      'forget it',
      'laisse tomber',
      'annule ça',
      'oublie ça',
      'deixa pra lá',
      'esquece isso',
      'olvídalo',
      'cancela eso'
    ].join('|') +
    ')\\s*[.!]*$'
)

const DET = `(?:(?:the|my|le|la|les|mon|ma|mes|el|los|las|mi|o|a|os|as|meu|minha)\\s+|l['’])`
const APP_NOUN = `(?:(?:app|application|aplicativo|aplicaci[oó]n)\\s+(?:de\\s+|d['’])?)`
const OPEN_VERBS =
  '(?:open(?:\\s+up)?|launch|start|ouvre|ouvrir|ouvrez|lance|lancer|d[ée]marre|abre|abrir|abra|inicia|iniciar|lan[cç]a|lan[cç]ar)'
const OPEN_RULE = rx(`^${OPEN_VERBS}\\s+${DET}?${APP_NOUN}?(.+)$`)

const NOTES_TARGETS = new Set(['notes', 'notas', 'apple notes', 'bloc notes', 'bloc-notes', 'blocnotes', 'notes app'])
const ARC_TARGETS = new Set(['arc', 'arc browser', 'navegador arc', 'navigateur arc', 'browser arc'])
const X_TARGETS = new Set(['x', 'x.com', 'x dot com', 'x com', 'twitter', 'twitter.com', 'x twitter'])
const BROWSER_SUFFIX = rx(`\\s+(?:in|on|with|using|dans|sur|avec|em|no|na|com|en|con)\\s+arc${END}$`)

const CREATE_VERBS =
  '(?:create|make|add|write|take|start|cr[ée]e|cr[ée]er|cr[ée]es|fais|faire|ajoute|ajouter|[ée]cris|[ée]crire|r[ée]dige|cria|criar|crie|faz|fazer|adiciona|adicionar|escreve|escrever|crea|crear|haz|hacer|a[ñn]ade|agrega|agregar|escribe|escribir)'
const NOTE_RULE = rx(
  `^(?:${CREATE_VERBS}\\s+(?:(?:a|an|une?|uma?|una|un|my|ma|mi)\\s+)?(?:(?:new|nouvelle|nova|nueva|novo)\\s+)?|(?:new|nouvelle|nova|nueva)\\s+)(?:note|nota)${END}(.*)$`
)
const TITLE_INTRO =
  '(?:called|titled|entitled|named|with (?:the )?title|with (?:the )?name|intitul[ée]e?|titr[ée]e?|nomm[ée]e?|appel[ée]e?|avec (?:le )?titre|chamada|chamado|intitulada|nomeada|com (?:o )?t[ií]tulo|com (?:o )?nome|llamada|titulada|con (?:el )?t[ií]tulo|con (?:el )?nombre)'
const BODY_INTRO =
  '(?:saying|that says|which says|with (?:the )?(?:text|body|content|message)|and (?:say|write)|disant|qui dit|avec (?:le )?(?:texte|contenu|message)|et (?:[ée]cris|dis)|dizendo|que diz|com (?:o )?(?:texto|conte[úu]do|mensagem)|e (?:escreve|diz)|diciendo|que dice|con (?:el )?(?:texto|contenido|mensaje)|y (?:escribe|di))'
const NOTE_WITH_TITLE = rx(`^\\s+${TITLE_INTRO}\\s+(.+)$`)
const NOTE_BODY_SPLIT = rx(`^(.*?)\\s+${BODY_INTRO}\\s+(.+)$`)
const NOTE_BODY_ONLY = rx(`^\\s+${BODY_INTRO}\\s+(.+)$`)

const PHOTO_VERBS =
  '(?:take|snap|capture|grab|shoot|prends|prendre|prenez|fais|faire|tire|tira|tirar|bate|bater|toma|tomar|saca|sacar|hazme|haz)'
const PHOTO_RULE = rx(
  `^${PHOTO_VERBS}\\s+(?:(?:a|me a|my|one|une?|ma|uma?|minha|una|mi)\\s+)?(?:photo|picture|pic|selfie|foto|fotograf[ií]a)${END}(?:\\s+(?:with|using|in|on|from|avec|dans|sur|com|no|na|em|con|en)\\s+(?:(?:the|le|o|el)\\s+)?photo\\s*booth)?$`
)

const SEARCH_VERBS = [
  'search(?:\\s+(?:google|the web|online))?(?:\\s+for)?',
  'google(?:\\s+for)?',
  'look\\s+up',
  'cherche(?:r)?(?:\\s+sur\\s+google)?(?:\\s+pour)?',
  'recherche(?:r)?(?:\\s+sur\\s+google)?',
  'googl(?:e|er)',
  'fais\\s+une\\s+recherche(?:\\s+sur(?:\\s+google)?)?',
  'pesquisa(?:r)?(?:\\s+no\\s+google)?(?:\\s+por)?',
  'pesquise(?:\\s+no\\s+google)?(?:\\s+por)?',
  'procura(?:r)?(?:\\s+no\\s+google)?(?:\\s+por)?',
  'busca(?:r)?(?:\\s+en\\s+google)?(?:\\s+por)?',
  'buscar(?:\\s+en\\s+google)?',
  'googla(?:r)?',
  'googlea(?:r)?',
  'investiga(?:r)?'
].join('|')
const SEARCH_RULE = rx(`^(${SEARCH_VERBS})\\s+(.+)$`)
const SEARCH_BARE = rx(`^(?:${SEARCH_VERBS})$`)
const GOOGLE_SUFFIX = rx(`\\s+(?:on|sur|no|en)\\s+google${END}$`)
/** Without the word Google, a search about the person's own things is not a web search. */
const LOCAL_QUERY = rx(
  `^(?:my|mon|ma|mes|meu|meus|minha|minhas|mi|mis|this|these|ce|cet|cette|ces|este|esta|estos|estas|isto|esse|essa)${END}`
)

const QUESTION_LEAD = rx(
  '^(?:' +
    [
      "what|what[’']s|how|why|who|whom|whose|when|where|which",
      "qu['’]est-ce|qu['’]est|que|quoi|comment|pourquoi|qui|quand|où|quel(?:le|s|les)?|combien",
      'o que|como|por que|porquê|quem|quando|onde|qual|quais|quanto',
      'qué|cómo|por qué|quién|cuándo|dónde|cuál|cuáles|cuánto'
    ].join('|') +
    `)${END}`
)

const ACTION_VERBS = rx(
  '^(?:' +
    [
      'open|launch|start|close|quit|exit|delete|remove|erase|send|email|e-mail|text|call|dial|type|click|press|play|pause|install|uninstall|download|upload|post|tweet|save|copy|paste|move|rename|create|make|add|take|set|schedule|book|remind|search|google',
      'ouvre|ouvrir|lance|ferme|fermer|quitte|supprime|supprimer|efface|envoie|envoyer|tape|clique|appuie|joue|mets|mettre|télécharge|appelle|programme|réserve|partage|publie|crée|ajoute|prends|fais|cherche|recherche',
      'abre|abrir|inicia|fecha|fechar|sai|apaga|exclui|envia|enviar|digita|clica|aperta|toca|coloca|baixa|liga|ligar|agenda|lembra|compartilha|publica|cria|adiciona|tira|faz|pesquisa|procura',
      'cierra|cerrar|borra|elimina|envía|escribe|reproduce|pon|descarga|llama|recuerda|comparte|crea|añade|haz|toma|busca'
    ].join('|') +
    `)${END}`
)

/** Remove trailing sentence punctuation and one pair of outer quotes; null when nothing is left. */
function cleanSlot(raw: string, max: number): { slot: string } | { missing: 'title' | 'too_long' } {
  let value = raw.trim().replace(/[\s.!?,;:…]+$/u, '')
  for (const [open, close] of [
    ['"', '"'],
    ['“', '”'],
    ['«', '»'],
    ['‘', '’'],
    ['„', '“'],
    ['„', '”']
  ] as const) {
    if (value.length >= 2 && value.startsWith(open) && value.endsWith(close)) {
      value = value.slice(open.length, value.length - close.length).trim()
      break
    }
  }
  if (!value) return { missing: 'title' }
  if (value.length > max) return { missing: 'too_long' }
  return { slot: value }
}

/** The utterance with the wake word, politeness and sentence punctuation removed; slot text untouched. */
function prepare(raw: string): { text: string; question: boolean } {
  let text = raw.normalize('NFC').trim().replace(WAKE_LEAD, '').trim()
  text = text.replace(/^[\s,.:;!\-–—]+/u, '')
  for (let i = 0; i < 4; i++) {
    const next = text.replace(POLITE_LEAD, '')
    if (next === text) break
    text = next.trim()
  }
  const question = /\?\s*$/u.test(text)
  for (let i = 0; i < 4; i++) {
    const next = text.replace(/[\s.!?…]+$/u, '').replace(POLITE_TAIL, '')
    if (next === text) break
    text = next
  }
  return { text: text.trim(), question }
}

function targetKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:app|application|aplicativo|aplicacion)$/, '')
    .trim()
}

function parseOpen(match: RegExpExecArray): VoiceUtterance {
  let target = match[1].trim()
  let browser: 'arc' | undefined
  const suffix = BROWSER_SUFFIX.exec(target)
  if (suffix) {
    browser = 'arc'
    target = target.slice(0, suffix.index).trim()
  }
  const key = targetKey(target)
  let request: unknown = null
  if (!browser && NOTES_TARGETS.has(key)) request = { id: 'desktop.open_notes', args: {} }
  else if (!browser && ARC_TARGETS.has(key)) request = { id: 'desktop.open_arc', args: {} }
  else if (X_TARGETS.has(key)) request = { id: 'desktop.open_x', args: browser ? { browser } : {} }
  const valid = validateDesktopRequest(request)
  return valid ? { kind: 'action', request: valid } : { kind: 'unsupported' }
}

function parseNote(rest: string): VoiceUtterance {
  if (!rest.trim()) return { kind: 'incomplete', missing: 'title' }
  const titled = NOTE_WITH_TITLE.exec(rest)
  if (!titled) return NOTE_BODY_ONLY.test(rest) ? { kind: 'incomplete', missing: 'title' } : { kind: 'unsupported' }
  const split = NOTE_BODY_SPLIT.exec(titled[1])
  const rawTitle = split ? split[1] : titled[1]
  const title = cleanSlot(rawTitle, NOTE_TITLE_MAX_CHARS)
  if ('missing' in title) return { kind: 'incomplete', missing: title.missing }
  const args: { title: string; body?: string } = { title: title.slot }
  if (split) {
    const body = cleanSlot(split[2], NOTE_BODY_MAX_CHARS)
    if ('missing' in body) return { kind: 'incomplete', missing: body.missing === 'title' ? 'title' : 'too_long' }
    args.body = body.slot
  }
  const valid = validateDesktopRequest({ id: 'desktop.create_note', args })
  return valid ? { kind: 'action', request: valid } : { kind: 'unsupported' }
}

function parseSearch(match: RegExpExecArray, whole: string): VoiceUtterance {
  let query = match[2].trim()
  let explicitGoogle = /google|googl|googla|googlea/iu.test(match[1])
  let browser: 'arc' | undefined
  for (let i = 0; i < 2; i++) {
    const arc = BROWSER_SUFFIX.exec(query)
    if (arc) {
      browser = 'arc'
      query = query.slice(0, arc.index).trim()
      continue
    }
    const google = GOOGLE_SUFFIX.exec(query)
    if (google) {
      explicitGoogle = true
      query = query.slice(0, google.index).trim()
    }
  }
  if (!explicitGoogle && LOCAL_QUERY.test(query)) return { kind: 'question', text: whole }
  const slot = cleanSlot(query, SEARCH_QUERY_MAX_CHARS)
  if ('missing' in slot) return { kind: 'incomplete', missing: slot.missing === 'title' ? 'query' : 'too_long' }
  const valid = validateDesktopRequest({
    id: 'desktop.google_search',
    args: browser ? { q: slot.slot, browser } : { q: slot.slot }
  })
  return valid ? { kind: 'action', request: valid } : { kind: 'unsupported' }
}

/**
 * Which catalog action an utterance seems to be about when it did not parse into a complete request (a note with
 * no title, a search with no query). Advisory only: it never becomes a request. Open commands name no hint, since
 * their target decides the action.
 */
export function provisionalIntent(raw: string): DesktopAdapterId | null {
  const { text } = prepare(raw)
  if (NOTE_RULE.test(text)) return 'desktop.create_note'
  if (SEARCH_BARE.test(text) || SEARCH_RULE.test(text)) return 'desktop.google_search'
  if (PHOTO_RULE.test(text)) return 'desktop.photo_booth_capture'
  return null
}

/** True for an interrogative opener in any of the four languages, or a trailing question mark. */
export function looksLikeQuestion(raw: string): boolean {
  const { text, question } = prepare(raw)
  return question || QUESTION_LEAD.test(text)
}

/** True when the utterance opens with a verb that asks for something to be done. */
export function startsWithActionVerb(raw: string): boolean {
  return ACTION_VERBS.test(prepare(raw).text)
}

export function parseVoiceUtterance(raw: string): VoiceUtterance {
  if (typeof raw !== 'string' || raw.length > MAX_UTTERANCE_CHARS) return { kind: 'none' }
  const { text, question } = prepare(raw)
  if (!text) return { kind: 'none' }
  if (NEGATION_LEAD.test(text) || NEGATION_TAIL.test(text)) return { kind: 'cancelled' }

  const open = OPEN_RULE.exec(text)
  if (open) return parseOpen(open)
  const note = NOTE_RULE.exec(text)
  if (note) return parseNote(note[1])
  if (PHOTO_RULE.test(text)) {
    const valid = validateDesktopRequest({ id: 'desktop.photo_booth_capture', args: {} })
    if (valid) return { kind: 'action', request: valid }
  }
  if (SEARCH_BARE.test(text)) return { kind: 'incomplete', missing: 'query' }
  const search = SEARCH_RULE.exec(text)
  if (search) return parseSearch(search, raw.normalize('NFC').trim())

  if (question || QUESTION_LEAD.test(text)) return { kind: 'question', text: raw.normalize('NFC').trim() }
  if (ACTION_VERBS.test(text)) return { kind: 'unsupported' }
  return { kind: 'none' }
}
