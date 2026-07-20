import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { Settings } from '@shared/ipc'
import {
  RENDERABLE_PROVENANCE_STATES,
  type PersonEntity,
  type AccountEntity,
  type DealEntity,
  type MeetingExtraction,
  type MeetingRef,
  type ProvenantField,
  type ProvenanceState,
  type Confidence,
  type EntityKind,
  type LedgerCommitment
} from '@shared/brain'
import { resolveMeetingsFolder, readSavedFile, writeSaved, parseRecapMarkdown } from '../transcripts'
import { listEntities, readPerson, readAccount, readDeal, readMeetingExtraction, listMeetingExtractions, slugify } from './store'
import { readAliasMap, resolveEntitySlug, type AliasMap } from './corrections'

/**
 * Task MI-5 — the Dust-readable markdown mirror. Renders the CRM-corrected brain (entities +
 * per-meeting note cards + an llms.txt-shaped index) as plain markdown under
 * `<resolveMeetingsFolder()>/wiki/`, gated entirely by `settings.publishBrainPages`.
 *
 * LOAD-BEARING invariant, reused verbatim from MI-4 (src/shared/brain.ts's RENDERABLE_PROVENANCE_STATES,
 * src/main/brain/context.ts's formatDeal): a field renders its value only when a human has verified it
 * (state ∈ {verified, pinned, edited}) or — for the softer, non-numeric fields only — the model's own
 * extraction was tagged EXTRACTED. amount/close_date NEVER render outside the strict verified/pinned/
 * edited set, matching the money-card gate. See fieldRenderInfo/numericRenderInfo below.
 *
 * Determinism: every render path here reads already-sorted store accessors (listEntities is alphabetical),
 * sorts everything else itself, and never touches the wall clock — `updated:`/`date:` frontmatter always
 * comes from meeting dates already stamped in the brain, never `Date.now()`. Writes go through the same
 * atomic tmp+rename `writeSaved` helper transcripts.ts/store.ts use, always with `encrypt: false` — the
 * wiki mirror's whole purpose is plaintext readability, so it is never written through the ATKENC envelope
 * regardless of `encryptTranscripts`.
 */

const KIND_DIR: Record<EntityKind, string> = { person: 'people', account: 'accounts', deal: 'deals' }

export function wikiDir(s: Settings): string {
  return join(resolveMeetingsFolder(s), 'wiki')
}

function entityPagePath(s: Settings, kind: EntityKind, id: string): string {
  return join(wikiDir(s), KIND_DIR[kind], `${id}.md`)
}

/** The stable identity key a meeting note card is filed under — the SAME slug ingestExtraction already
 *  uses for `.brain/meetings/<slug>.json` (slugify(basename(file))), so a card and its extraction always
 *  agree on where to look for each other without a second lookup table. */
function meetingSlug(file: string): string {
  return slugify(basename(file))
}

function meetingCardPath(s: Settings, file: string): string {
  return join(wikiDir(s), 'meetings', `${meetingSlug(file)}.md`)
}

function ensureWikiDirs(s: Settings): void {
  const root = wikiDir(s)
  for (const d of [root, join(root, 'accounts'), join(root, 'people'), join(root, 'deals'), join(root, 'meetings')]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}

/** Every wiki file is plaintext, always — regardless of `encryptTranscripts` — via the same atomic
 *  tmp+rename path writeSaved uses for every other saved artifact (full-file regeneration, never a
 *  read-modify-write). */
async function writeWikiFile(path: string, content: string): Promise<void> {
  await writeSaved(path, content, false)
}

function appVersion(): string {
  try {
    return app.getVersion() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// ── YAML-safe scalars (mirrors transcripts.ts's yamlSafeTitle convention) ────────────────────────────

function yamlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
}
function yamlList(items: string[]): string {
  return `[${items.map(yamlStr).join(', ')}]`
}

function buildFrontmatter(fields: Array<[string, string]>): string {
  return ['---', ...fields.map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n')
}

const AI_NOTICE = '> AI-generated summary — verify before relying.\n'

// ── Locale-independent number formatting (determinism: Number.toLocaleString() depends on the ─────────
// runtime's default locale, which can differ between machines/CI and would break byte-identical output).
function formatNumber(n: number): string {
  const sign = n < 0 ? '-' : ''
  const [intPart, frac] = Math.abs(n).toFixed(2).replace(/\.00$/, '').split('.')
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return sign + grouped + (frac ? `.${frac}` : '')
}

// ── Confidential meetings ─────────────────────────────────────────────────────────────────────────────

function listSavedMeetingFiles(s: Settings): string[] {
  const folder = resolveMeetingsFolder(s)
  if (!existsSync(folder)) return []
  return readdirSync(folder).filter((f) => f.endsWith('.md') && !f.startsWith('.') && f !== 'index.md' && f !== 'README.md')
}

/** Checks `key: true` WITHIN the leading `---`-delimited frontmatter block only — never a coincidental
 *  "confidential: true"-looking line inside the transcript/recap/debrief body (e.g. a participant
 *  literally saying those words), matching recall.ts's own frontmatter-block-scoped parsing. */
function readFrontmatterFlag(md: string, key: string): boolean {
  const block = md.match(/^---\n([\s\S]*?)\n---/)
  if (!block) return false
  const m = block[1].match(new RegExp(`^${key}:\\s*(.*)\\s*$`, 'm'))
  return !!m && /^"?true"?$/i.test(m[1].trim())
}

/** basenames of every saved meeting flagged `confidential: true` in its frontmatter. Read fresh on every
 *  publish call (no cache) — this runs once per publish/index-regen, not per keystroke, and correctness
 *  (a just-flagged meeting disappearing from the very next publish) matters far more than the cost of a
 *  handful of extra file reads at this app's single-exec scale. An unreadable/undecryptable meeting file
 *  is never treated as confidential (nor as safe — it simply can't be read at all here). */
export function readConfidentialMeetings(s: Settings): Set<string> {
  const folder = resolveMeetingsFolder(s)
  const out = new Set<string>()
  for (const f of listSavedMeetingFiles(s)) {
    try {
      const md = readSavedFile(join(folder, f))
      if (md && readFrontmatterFlag(md, 'confidential')) out.add(f)
    } catch {
      /* unreadable on this device — skip, never guess */
    }
  }
  return out
}

// ── Render gate ────────────────────────────────────────────────────────────────────────────────────────

function passesSoftGate(state: ProvenanceState, confidence: Confidence): boolean {
  return RENDERABLE_PROVENANCE_STATES.has(state) || (state === 'extracted' && confidence === 'EXTRACTED')
}

interface RenderInfo<T> {
  renders: boolean
  value?: T
  sourceFile?: string
  date?: string
}

const NOT_CONFIDENTIAL = (sf: string, confidential: Set<string>): boolean => !sf || !confidential.has(sf)

/** Non-numeric provenant fields (role/org/sector/stage/win_likelihood_band/velocity): renders when the
 *  live value passes the soft gate (verified/pinned/edited, OR extracted+EXTRACTED). When the live
 *  value's own source meeting is confidential, falls back to the newest non-confidential entry in
 *  `superseded` — filtering the provenance chain at RENDER time only, per the MI-5 brief; the brain
 *  store itself is never mutated. A superseded entry carries no `state` (see SupersededEntry in
 *  store.ts), so it is always treated as machine-extracted tier, gated by its own recorded confidence. */
function renderNonNumeric<T>(field: ProvenantField<T> | undefined, confidential: Set<string>): RenderInfo<T> {
  if (!field) return { renders: false }
  if (NOT_CONFIDENTIAL(field.source_file, confidential)) {
    return { renders: passesSoftGate(field.state, field.confidence), value: field.value, sourceFile: field.source_file, date: field.date }
  }
  for (const e of field.superseded) {
    if (!NOT_CONFIDENTIAL(e.source_file, confidential)) continue
    return { renders: passesSoftGate('extracted', e.confidence ?? 'INFERRED'), value: e.value, sourceFile: e.source_file, date: e.date }
  }
  return { renders: false }
}

/** Numeric provenant fields (deal amount/close_date) — the STRICT MI-4 gate: renders ONLY when
 *  state ∈ {verified, pinned, edited}, never merely EXTRACTED confidence. When the live value's source
 *  meeting is confidential, this NEVER falls back into `superseded` — a superseded entry carries no
 *  `state` at all (see SupersededEntry), so there is no way to know a historical sighting was ever
 *  independently verified; guessing would be exactly the silent-unverified-number leak this gate exists
 *  to prevent. A confidential-sourced current number renders "not established" instead. */
function renderNumeric<T>(field: ProvenantField<T> | undefined, confidential: Set<string>): RenderInfo<T> {
  if (!field) return { renders: false }
  if (!NOT_CONFIDENTIAL(field.source_file, confidential)) return { renders: false }
  return { renders: RENDERABLE_PROVENANCE_STATES.has(field.state), value: field.value, sourceFile: field.source_file, date: field.date }
}

function citeSource(sourceFile?: string, date?: string): string {
  if (!sourceFile) return date ? `edited by you (${date})` : 'edited by you'
  const slug = meetingSlug(sourceFile)
  return `[${sourceFile}${date ? `, ${date}` : ''}](../meetings/${slug}.md)`
}

function factRow<T>(label: string, info: RenderInfo<T>, format: (v: T) => string): string {
  if (!info.renders || info.value === undefined || info.value === null) {
    return `| ${label} | not established | — |`
  }
  return `| ${label} | ${format(info.value)} | ${citeSource(info.sourceFile, info.date)} |`
}

function plainFactRow(label: string, value: string): string {
  return `| ${label} | ${value} | — |`
}

// ── Changelog (superseded history, capped 10, confidential entries excluded) ───────────────────────────

interface ChangeRow {
  date: string
  text: string
}

function changelogEntries(
  fields: Array<{ label: string; field: ProvenantField<unknown> | undefined; format: (v: unknown) => string }>,
  confidential: Set<string>
): ChangeRow[] {
  const rows: ChangeRow[] = []
  for (const { label, field, format } of fields) {
    if (!field) continue
    for (const e of field.superseded) {
      if (!NOT_CONFIDENTIAL(e.source_file, confidential)) continue
      const src = e.source_file ? ` [${e.source_file}]` : ''
      rows.push({ date: e.date, text: `${label} was ${format(e.value)}${src}` })
    }
  }
  return rows
    .sort((a, b) => (a.date === b.date ? a.text.localeCompare(b.text) : a.date > b.date ? -1 : 1))
    .slice(0, 10)
}

// ── Timeline / commitments (confidential meetings excluded) ────────────────────────────────────────────

function timelineRows(meetings: MeetingRef[], confidential: Set<string>): MeetingRef[] {
  return [...meetings]
    .filter((m) => !confidential.has(m.file))
    .sort((a, b) => (a.date === b.date ? a.file.localeCompare(b.file) : a.date > b.date ? -1 : 1))
}

function openCommitmentRows(commitments: LedgerCommitment[], confidential: Set<string>): LedgerCommitment[] {
  return commitments
    .filter((c) => c.status === 'open' && !confidential.has(c.meeting))
    .sort((a, b) => (a.date === b.date ? a.meeting.localeCompare(b.meeting) : a.date > b.date ? -1 : 1))
}

function newestDate(meetings: MeetingRef[], confidential: Set<string>): string {
  const dates = meetings.filter((m) => !confidential.has(m.file)).map((m) => m.date).filter(Boolean).sort()
  return dates[dates.length - 1] ?? ''
}

// ── Shared page assembly ───────────────────────────────────────────────────────────────────────────────

function pageHeader(kind: EntityKind, id: string, title: string, aliases: string[], tags: string[], updated: string): string {
  const fm = buildFrontmatter([
    ['type', yamlStr(`brain-${kind}`)],
    ['title', yamlStr(title)],
    ['aliases', yamlList(aliases)],
    ['tags', yamlList(tags)],
    ['updated', yamlStr(updated)],
    ['ai_generated', 'true'],
    ['generated_by', yamlStr(`asktoto/${appVersion()}`)],
    ['resource', yamlStr(`../../.brain/entities/${kind}/${id}.json`)]
  ])
  return `${fm}\n# ${title}\n\n${AI_NOTICE}\n`
}

function timelineSection(rows: MeetingRef[]): string {
  if (rows.length === 0) return '## Timeline\n\nNo meetings on record.\n'
  const lines = rows.map((m) => `- [${m.title || m.file}](../meetings/${meetingSlug(m.file)}.md)${m.date ? ` — ${m.date}` : ''}`)
  return `## Timeline\n\n${lines.join('\n')}\n`
}

function commitmentsSection(rows: LedgerCommitment[]): string {
  if (rows.length === 0) return '## Open commitments\n\nNone open.\n'
  const lines = rows.map((c) => {
    const due = c.due_hint ? ` (${c.due_hint})` : ''
    return `- ${c.by} owes: ${c.text}${due} — [${c.meeting}](../meetings/${meetingSlug(c.meeting)}.md)`
  })
  return `## Open commitments\n\n${lines.join('\n')}\n`
}

function changelogSection(rows: ChangeRow[]): string {
  if (rows.length === 0) return '## Changelog\n\nNo prior values on record.\n'
  return `## Changelog\n\n${rows.map((r) => `- ${r.date}: ${r.text}`).join('\n')}\n`
}

// ── Person page ────────────────────────────────────────────────────────────────────────────────────────

function renderPersonPage(p: PersonEntity, confidential: Set<string>): string {
  const id = p.id || slugify(p.name)
  const role = renderNonNumeric(p.role_provenance, confidential)
  const org = renderNonNumeric(p.org_provenance, confidential)
  const rows = timelineRows(p.meetings, confidential)
  const header = pageHeader('person', id, p.name, p.aliases, ['person'], newestDate(p.meetings, confidential))
  const facts = [
    '## Current facts',
    '',
    '| Field | Value | Source |',
    '|---|---|---|',
    factRow('Role', role, (v) => v as string),
    factRow('Organization', org, (v) => v as string)
  ].join('\n')
  const changelog = changelogSection(
    changelogEntries(
      [
        { label: 'Role', field: p.role_provenance, format: (v) => String(v) },
        { label: 'Organization', field: p.org_provenance, format: (v) => String(v) }
      ],
      confidential
    )
  )
  return [
    header,
    facts,
    '',
    timelineSection(rows),
    '',
    commitmentsSection(openCommitmentRows(p.commitments ?? [], confidential)),
    '',
    changelog
  ].join('\n')
}

// ── Account page ───────────────────────────────────────────────────────────────────────────────────────

function renderAccountPage(a: AccountEntity, confidential: Set<string>): string {
  const id = a.id || slugify(a.name)
  const sector = renderNonNumeric(a.sector_provenance, confidential)
  const rows = timelineRows(a.meetings, confidential)
  const header = pageHeader('account', id, a.name, a.aliases, ['account'], newestDate(a.meetings, confidential))
  const facts = [
    '## Current facts',
    '',
    '| Field | Value | Source |',
    '|---|---|---|',
    factRow('Sector', sector, (v) => v as string),
    plainFactRow('Strategic', a.strategic ? 'Yes' : 'No')
  ].join('\n')
  const changelog = changelogSection(
    changelogEntries([{ label: 'Sector', field: a.sector_provenance, format: (v) => String(v) }], confidential)
  )
  return [header, facts, '', timelineSection(rows), '', changelog].join('\n')
}

// ── Deal page ──────────────────────────────────────────────────────────────────────────────────────────

function formatBand(v: unknown): string {
  return v ? String(v) : 'unrated'
}
function formatVelocity(v: unknown): string {
  const vv = v as { signal: string; evidence: string }
  return vv.evidence ? `${vv.signal} — ${vv.evidence}` : vv.signal
}
function formatAmount(v: unknown): string {
  const vv = v as { value: number; currency: string }
  return `${formatNumber(vv.value)} ${vv.currency}`
}

function renderDealPage(d: DealEntity, confidential: Set<string>): string {
  const id = d.id || slugify(d.name)
  const stage = renderNonNumeric(d.stage_provenance, confidential)
  const band = renderNonNumeric(d.win_likelihood_band_provenance, confidential)
  const velocity = renderNonNumeric(d.velocity_provenance, confidential)
  const amount = renderNumeric(d.amount, confidential)
  const closeDate = renderNumeric(d.close_date, confidential)
  const rows = timelineRows(d.meetings, confidential)
  const header = pageHeader('deal', id, d.name, d.aliases, ['deal'], newestDate(d.meetings, confidential))
  const facts = [
    '## Current facts',
    '',
    '| Field | Value | Source |',
    '|---|---|---|',
    plainFactRow('Outcome', d.outcome),
    factRow('Stage', stage, (v) => v as string),
    factRow('Win likelihood', band, formatBand),
    factRow('Velocity', velocity, formatVelocity),
    factRow('Amount', amount, formatAmount),
    factRow('Close date', closeDate, (v) => v as string)
  ].join('\n')
  const changelog = changelogSection(
    changelogEntries(
      [
        { label: 'Stage', field: d.stage_provenance, format: (v) => String(v) },
        { label: 'Win likelihood', field: d.win_likelihood_band_provenance, format: formatBand },
        { label: 'Velocity', field: d.velocity_provenance, format: formatVelocity },
        { label: 'Amount', field: d.amount, format: formatAmount },
        { label: 'Close date', field: d.close_date, format: (v) => String(v) }
      ],
      confidential
    )
  )
  return [
    header,
    facts,
    '',
    timelineSection(rows),
    '',
    commitmentsSection(openCommitmentRows(d.commitments, confidential)),
    '',
    changelog
  ].join('\n')
}

// ── Public entity publish/remove ──────────────────────────────────────────────────────────────────────

/** Regenerate one entity's wiki page (full-file, idempotent). No-ops when publishing is off, or when the
 *  entity no longer exists (tombstoned/merged away) — in the latter case any stale page is removed. */
export async function publishEntity(s: Settings, kind: EntityKind, id: string): Promise<void> {
  if (!s.publishBrainPages || !id) return
  ensureWikiDirs(s)
  const confidential = readConfidentialMeetings(s)
  let md: string | null = null
  let meetings: MeetingRef[] = []
  if (kind === 'person') {
    const p = readPerson(s, id)
    if (p) { meetings = p.meetings; md = renderPersonPage(p, confidential) }
  } else if (kind === 'account') {
    const a = readAccount(s, id)
    if (a) { meetings = a.meetings; md = renderAccountPage(a, confidential) }
  } else {
    const d = readDeal(s, id)
    if (d) { meetings = d.meetings; md = renderDealPage(d, confidential) }
  }
  // QA #11: an entity whose EVERY meeting is confidential must get NO page. The rendered body is already
  // fully redacted (timeline/fact/changelog rows all gate on `confidential`), but the page HEADER still
  // prints the entity's real name + aliases, and the index would list it — leaking the identity of an
  // entity that appears only in confidential meetings. Skip ONLY that case: a zero-meeting entity carries
  // no confidential provenance to leak and publishes as before.
  const confidentialOnly = meetings.length > 0 && !meetings.some((m) => !confidential.has(m.file))
  if (md === null || confidentialOnly) {
    await removeFromWiki(s, kind, id)
    return
  }
  await writeWikiFile(entityPagePath(s, kind, id), md)
}

/** Delete one entity's stale wiki page (a merge-tombstoned or otherwise vanished entity). Never throws —
 *  best-effort, mirroring every other derived-artifact cleanup in this codebase. */
export async function removeFromWiki(s: Settings, kind: EntityKind, id: string): Promise<void> {
  const p = entityPagePath(s, kind, id)
  try {
    if (existsSync(p)) unlinkSync(p)
  } catch {
    /* best-effort */
  }
}

async function removeMeetingCard(s: Settings, file: string): Promise<void> {
  const p = meetingCardPath(s, file)
  try {
    if (existsSync(p)) unlinkSync(p)
  } catch {
    /* best-effort */
  }
}

// ── Meeting note card ──────────────────────────────────────────────────────────────────────────────────

/** Minimal key:value frontmatter parse — duplicated from recall.ts's own `frontmatter()` (not exported
 *  there) rather than imported, matching this codebase's established convention for small cross-file
 *  parsing helpers (see recall.ts's own doc comments on sanitizeRenameTitle/yamlSafeRenameTitle). */
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return out
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i)
    if (kv) out[kv[1]] = kv[2].replace(/^["[]|["\]]$/g, '').trim()
  }
  return out
}

/** Extracts the "## Notes & follow-ups" … "## Full transcript" span — the exact recap section
 *  recall.ts's recallRead parses, duplicated here for the same reason as parseFrontmatter above. NEVER
 *  reads past "## Full transcript": the note card is recap-derived only, transcript lines must never
 *  reach it. */
function extractRecapSection(text: string): string {
  const startMatch = text.match(/^## Notes & follow-ups[\r\n]+/m)
  if (!startMatch) return ''
  const afterStart = text.slice(startMatch.index! + startMatch[0].length)
  const endIdx = afterStart.search(/^## Full transcript/m)
  return (endIdx === -1 ? afterStart : afterStart.slice(0, endIdx)).trim()
}

/** A quote-shaped fragment longer than 15 words is trimmed to the first 15 (+ ellipsis) — the note
 *  card's own hard cap, independent of whatever length limit (if any) the source recap section used. */
function capQuote(s: string): string {
  const words = s.trim().split(/\s+/)
  return words.length <= 15 ? s.trim() : words.slice(0, 15).join(' ') + '…'
}

function mdLink(label: string, relPath: string): string {
  return `[${label}](${relPath})`
}

/** Regenerate one meeting's note card (full-file, idempotent). No-ops when publishing is off. A
 *  confidential-flagged meeting gets NO card — any stale one from before the flag was set is removed. */
export async function publishMeetingCard(s: Settings, meetingFile: string): Promise<void> {
  if (!s.publishBrainPages) return
  const base = basename(meetingFile)
  if (!base.endsWith('.md')) return
  ensureWikiDirs(s)
  const confidential = readConfidentialMeetings(s)
  if (confidential.has(base)) {
    await removeMeetingCard(s, base)
    return
  }
  const folder = resolveMeetingsFolder(s)
  const path = join(folder, base)
  if (!existsSync(path)) {
    await removeMeetingCard(s, base)
    return
  }
  let raw: string
  try {
    raw = readSavedFile(path)
  } catch {
    return
  }
  if (!raw) return // undecryptable on this device — leave any existing card alone rather than guess

  const fm = parseFrontmatter(raw)
  if (fm.type && fm.type !== 'meeting-transcript') return

  const recapMd = extractRecapSection(raw)
  const parsed = parseRecapMarkdown(recapMd)
  const title = fm.title || parsed.title24 || base.replace(/\.md$/, '')
  const date = fm.date || ''

  const aliasMap: AliasMap = readAliasMap(s)
  const extraction = readMeetingExtraction(s, meetingSlug(base))

  const attendeeLinks: string[] = []
  if (extraction) {
    for (const p of extraction.people) {
      if (!p.name.trim()) continue
      const pid = resolveEntitySlug(aliasMap, 'person', p.name)
      attendeeLinks.push(mdLink(p.name, `../people/${pid}.md`))
    }
  }
  const accountLink =
    extraction?.account && extraction.account.name.trim()
      ? mdLink(extraction.account.name, `../accounts/${resolveEntitySlug(aliasMap, 'account', extraction.account.name)}.md`)
      : ''
  let dealLink = ''
  if (extraction?.deal && (extraction.deal.name || accountLink)) {
    const fallbackName = `${extraction.account?.name ?? 'Unknown'} deal`
    const dealName = extraction.deal.name || fallbackName
    const dealId = resolveEntitySlug(aliasMap, 'deal', dealName)
    dealLink = mdLink(dealName, `../deals/${dealId}.md`)
  }

  const fmFields: Array<[string, string]> = [
    ['type', yamlStr('brain-meeting')],
    ['title', yamlStr(title)],
    ['aliases', yamlList([])],
    ['tags', yamlList(parsed.tags)],
    ['date', yamlStr(date)],
    ['attendees', yamlList(attendeeLinks)],
    ['account', yamlStr(accountLink)],
    ['deal', yamlStr(dealLink)],
    ['ai_generated', 'true'],
    ['generated_by', yamlStr(`asktoto/${appVersion()}`)]
  ]

  const decisions = parsed.decisions.length ? parsed.decisions.map((d) => `- ${capQuote(d)}`).join('\n') : 'None recorded.'
  const actionItems = parsed.actionItems.length
    ? parsed.actionItems.map((a) => `- ${capQuote(a.text)}${a.owner ? ` (${a.owner})` : ''}`).join('\n')
    : 'None recorded.'
  const entityLines = [
    ...attendeeLinks.map((l) => `- ${l}`),
    ...(accountLink ? [`- ${accountLink}`] : []),
    ...(dealLink ? [`- ${dealLink}`] : [])
  ]

  const body = [
    buildFrontmatter(fmFields),
    `# ${title}`,
    '',
    AI_NOTICE,
    '## TL;DR',
    '',
    parsed.overview ? capQuote(parsed.overview) : 'No summary recorded.',
    '',
    '## Decisions',
    '',
    decisions,
    '',
    '## Action items',
    '',
    actionItems,
    '',
    '## Entities',
    '',
    entityLines.length ? entityLines.join('\n') : 'None recognized.',
    '',
    `Original meeting: [${base}](../../${base})`,
    ''
  ].join('\n')

  await writeWikiFile(meetingCardPath(s, base), body)
}

// ── Indexes: index.md / AGENTS.md / README.md ────────────────────────────────────────────────────────

const AGENTS_MD = `---
type: brain-agents-contract
title: "AGENTS.md — how to read this corpus"
aliases: []
tags: [agents-contract]
updated: ""
ai_generated: true
generated_by: "asktoto"
---

# AGENTS.md — how to read this corpus

${AI_NOTICE}
This folder (\`wiki/\`) is a plaintext, machine-generated mirror of Métis's meeting-intelligence brain:
CRM-corrected accounts, people, deals, and per-meeting note cards. Nothing here is a raw transcript —
every fact is derived, and every value carries its source.

## File schema

- \`accounts/<id>.md\`, \`people/<id>.md\`, \`deals/<id>.md\` — one page per entity: current facts, a
  meeting timeline, open commitments, and a changelog of prior values.
- \`meetings/<slug>.md\` — one recap-derived note card per meeting: TL;DR, decisions, action items,
  linked entities. Never contains verbatim transcript lines.
- \`index.md\` — the corpus entrypoint: recent meetings + top entities by activity.

## Frontmatter fields

Every page carries \`type\`, \`title\`, \`aliases\`, \`tags\`, \`updated\` (or \`date\` for a meeting card),
\`ai_generated: true\`, and \`generated_by\` (the asktoto app version that wrote it) — an EU AI Act
Article 50 marking. Entity pages also carry \`resource\`, a relative path to the underlying JSON record.

## Navigation rules

Follow the relative markdown links between pages (never \`[[wikilinks]]\`). Start from \`index.md\` for
an overview, or jump straight to an entity/meeting page if you already have its id.

## Human vs. AI provenance

A "Current facts" row shows a value only once it is human-verified/-pinned/-edited, or the extraction was
tagged EXTRACTED; anything weaker reads "not established" — never a guessed figure. A row's Source column
either cites the meeting it came from, or reads "edited by you" for a human-entered value. Treat every
page here as a derived summary to verify, not a source of record — the linked \`resource\` JSON and the
original meeting are the ground truth.
`

const README_MD = `# wiki/ — Métis meeting intelligence (plaintext mirror)

${AI_NOTICE}
This folder is a machine-generated, plaintext mirror of Métis's meeting-intelligence brain, published
here so Dust and other agents can read the CRM-corrected truth even while the raw transcripts stay
encrypted. See \`AGENTS.md\` for the full file schema and navigation rules, or start at \`index.md\`.

Nothing in this folder is a verbatim transcript. Meetings flagged confidential in Métis are excluded
from every page here.
`

// The "handshake" a user hands to Claude (or any assistant): a single, self-contained entry doc addressed
// to the assistant that says what this folder is, how it is organized, and how to USE it as the user's
// second brain — including proactively surfacing next steps. Point Claude at this folder (a Claude Project,
// Claude Desktop, or a synced-folder connector) and this file orients it in one read.
const CLAUDE_MD = `# CLAUDE.md — read this folder as my second brain

${AI_NOTICE}
Hi Claude. This folder is my **Métis second brain**: a plaintext, always-current mirror of my meeting
intelligence — the people I meet, the accounts and deals I am working, the commitments made, and a note
card for every meeting. It is published here so you can read it directly and act as my second brain.

## Start here
- \`index.md\` — the entrypoint: recent meetings plus the most active people, accounts, and deals.
- \`AGENTS.md\` — the full file schema, provenance rules, and navigation rules. Read it once.
- \`meetings/<slug>.md\` — one note card per meeting (TL;DR, decisions, action items, linked entities).
- \`people/<id>.md\`, \`accounts/<id>.md\`, \`deals/<id>.md\` — one page per entity, with a timeline, open
  commitments, and a changelog of prior values.

## How to help me
Use this corpus to answer questions about my meetings, relationships, and deals, and — proactively — to
surface **next steps**: open commitments that are aging, deals that have gone quiet, follow-ups I promised,
and the single most useful thing to do next. Ground every claim in the specific meeting or entity page it
came from (cite the file). Anything marked "not established" is not yet a fact — flag it, never guess a
number. Nothing here is a raw transcript; every value is derived and carries its source, so treat these
pages as summaries to verify against the linked records, not the source of record. Meetings I flagged
confidential are already excluded from this folder.
`

function topByActivity<T extends { id?: string; name: string; meetings: MeetingRef[] }>(
  entities: T[],
  confidential: Set<string>,
  limit: number
): T[] {
  return [...entities]
    // QA #11: never list an entity whose every meeting is confidential — it has no page (see
    // publishEntity) and listing it here would leak its name/identity through the index. (A zero-meeting
    // entity carries no confidential provenance, so it is still listed, matching publishEntity.)
    .filter((e) => e.meetings.length === 0 || e.meetings.some((m) => !confidential.has(m.file)))
    .map((e) => ({ e, date: newestDate(e.meetings, confidential) }))
    .sort((a, b) => (a.date === b.date ? a.e.name.localeCompare(b.e.name) : a.date > b.date ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.e)
}

function readAllMeetingRefs(s: Settings): MeetingRef[] {
  const seen = new Map<string, MeetingRef>()
  for (const kind of ['person', 'account', 'deal'] as const) {
    for (const id of listEntities(s, kind)) {
      const e = kind === 'person' ? readPerson(s, id) : kind === 'account' ? readAccount(s, id) : readDeal(s, id)
      for (const m of e?.meetings ?? []) if (!seen.has(m.file)) seen.set(m.file, m)
    }
  }
  return [...seen.values()]
}

/** Regenerate index.md + AGENTS.md + README.md (full-file, idempotent). No-op when publishing is off. */
export async function publishIndexes(s: Settings): Promise<void> {
  if (!s.publishBrainPages) return
  ensureWikiDirs(s)
  const confidential = readConfidentialMeetings(s)

  const accounts = listEntities(s, 'account').map((id) => readAccount(s, id)).filter((a): a is AccountEntity => !!a)
  const people = listEntities(s, 'person').map((id) => readPerson(s, id)).filter((p): p is PersonEntity => !!p)
  const deals = listEntities(s, 'deal').map((id) => readDeal(s, id)).filter((d): d is DealEntity => !!d)

  const recentMeetings = timelineRows(readAllMeetingRefs(s), confidential).slice(0, 20)
  const topAccounts = topByActivity(accounts, confidential, 10)
  const topPeople = topByActivity(people, confidential, 10)
  const topDeals = topByActivity(deals, confidential, 10)

  const updated = recentMeetings[0]?.date ?? ''
  const fm = buildFrontmatter([
    ['type', yamlStr('brain-index')],
    ['title', yamlStr('Meeting Intelligence — Métis')],
    ['aliases', yamlList([])],
    ['tags', yamlList(['index'])],
    ['updated', yamlStr(updated)],
    ['ai_generated', 'true'],
    ['generated_by', yamlStr(`asktoto/${appVersion()}`)]
  ])

  const section = (title: string, lines: string[]): string =>
    `## ${title}\n\n${lines.length ? lines.join('\n') : '_None yet._'}\n`

  const body = [
    fm,
    '# Meeting Intelligence — Métis',
    '',
    AI_NOTICE,
    '> This is the CRM-corrected knowledge built from every meeting Métis has captured — plain markdown,',
    '> Dust- and agent-readable, with every fact traceable to a meeting or a human edit.',
    '',
    section(
      'Recent meetings',
      recentMeetings.map((m) => `- [${m.title || m.file}](meetings/${meetingSlug(m.file)}.md)${m.date ? ` — ${m.date}` : ''}`)
    ),
    section('Accounts', topAccounts.map((a) => `- [${a.name}](accounts/${a.id || slugify(a.name)}.md)`)),
    section('People', topPeople.map((p) => `- [${p.name}](people/${p.id || slugify(p.name)}.md)`)),
    section('Deals', topDeals.map((d) => `- [${d.name}](deals/${d.id || slugify(d.name)}.md)`)),
    '## How to query',
    '',
    'Ask about an account, person, or deal by name — its page lists current facts (each sourced or marked',
    '"not established"), a meeting timeline, open commitments, and a changelog. See AGENTS.md for the full contract.'
  ].join('\n')

  await writeWikiFile(join(wikiDir(s), 'index.md'), body)
  await writeWikiFile(join(wikiDir(s), 'AGENTS.md'), AGENTS_MD)
  await writeWikiFile(join(wikiDir(s), 'README.md'), README_MD)
  await writeWikiFile(join(wikiDir(s), 'CLAUDE.md'), CLAUDE_MD)
}

// ── Hooks: per-merge entity+card publish, full rebuild ───────────────────────────────────────────────

/** Resolves the entities touched by one meeting's merge (mirrors mergeExtraction's own slug resolution
 *  in ingest.ts) and republishes their pages plus that meeting's note card. Called from
 *  ingestExtraction after every merge (live AND backfill) — index regeneration is deliberately NOT done
 *  here; it is throttled separately (see ingest.ts's finishJob/maybeFinishDrain), matching how lintBrain
 *  batches. No-ops when publishing is off. */
export async function publishForExtraction(
  s: Settings,
  x: MeetingExtraction,
  ref: MeetingRef,
  aliasMap?: AliasMap
): Promise<void> {
  if (!s.publishBrainPages) return
  const accountSlug = x.account && x.account.name.trim() ? resolveEntitySlug(aliasMap, 'account', x.account.name) : null
  if (accountSlug) await publishEntity(s, 'account', accountSlug)
  for (const p of x.people) {
    if (!p.name.trim()) continue
    await publishEntity(s, 'person', resolveEntitySlug(aliasMap, 'person', p.name))
  }
  if (x.deal && (x.deal.name || accountSlug)) {
    const dslug = resolveEntitySlug(aliasMap, 'deal', x.deal.name || `${x.account?.name ?? 'unknown'} deal`)
    await publishEntity(s, 'deal', dslug)
  }
  await publishMeetingCard(s, ref.file)
}

/** Full regeneration of every wiki page from the current brain state — the rebuildAll completion hook,
 *  and the "just turned publishing on" / "confidential flag changed" entry point. Idempotent: running it
 *  twice over the same brain state produces byte-identical files. No-op when publishing is off. */
export async function publishAll(s: Settings): Promise<void> {
  if (!s.publishBrainPages) return
  ensureWikiDirs(s)
  for (const kind of ['person', 'account', 'deal'] as const) {
    for (const id of listEntities(s, kind)) await publishEntity(s, kind, id)
  }
  for (const slug of listMeetingExtractions(s)) {
    const x = readMeetingExtraction(s, slug)
    if (x?.source_file) await publishMeetingCard(s, x.source_file)
  }
  await publishIndexes(s)
}

/** Delete the entire wiki/ mirror — called when publishBrainPages is turned off (audit-logged by the
 *  caller). Best-effort, mirrors purgeBrain's own "never throw out of a wipe" convention. */
export function removeWiki(s: Settings): { ok: boolean } {
  const root = wikiDir(s)
  try {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    return { ok: !existsSync(root) }
  } catch {
    return { ok: !existsSync(root) }
  }
}
