import { basename, join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import type { Settings, AskStart } from '@shared/ipc'
import { PROVIDERS, resolveModelTier, type ProviderId } from '@shared/providers'
import {
  BRAIN_EXTRACTION_PROMPT,
  BRAIN_SCHEMA_VERSION,
  classifyMeetingSourceUse,
  MeetingExtractionSchema,
  type MeetingExtraction,
  type MeetingRef,
  type BrainGraph,
  type BrainIndex,
  type Confidence,
  type ProvenantField
} from '@shared/brain'
import { INJECTION_GUARD } from '@shared/prompts'
import { redactSecrets } from '@shared/redact'
import { getSettings, getApiKey } from '../store'
import { createStream } from '../llm'
import { readSavedFile, resolveMeetingsFolder } from '../transcripts'
import { auditLog, mainLog } from '../logger'
import {
  slugify,
  readIndex,
  writeIndex,
  readGraph,
  writeGraph,
  writeMeetingExtraction,
  readPerson,
  writePerson,
  readAccount,
  writeAccount,
  readDeal,
  writeDeal,
  listEntities,
  listMeetingExtractions
} from './store'

/**
 * Brain ingest — turns one saved transcript into a structured extraction, then merges it into the
 * compounding entity files. One LLM call per meeting (active provider, non-streaming semantics by
 * accumulating the stream), deterministic merge code, then a cheap rule-based lint pass. Queued and
 * background: a failed ingest is recorded in index.json and retried on the next rebuild — it can never
 * block or corrupt a meeting save.
 */

// ── LLM call ─────────────────────────────────────────────────────────────────

/** Cheap "is any provider usable at all" check — reuses pickProvider's own resolution logic so the two
 *  can never drift out of sync. Used to bail out of backfill work BEFORE burning a queued job (and its
 *  one reinforcement retry) on a call that's guaranteed to reject with "No configured AI provider". */
function hasUsableProvider(s: Settings): boolean {
  return pickProvider(s) !== null
}

/** Pick the first usable text provider: the active one, then any other with credentials + a model. */
function pickProvider(s: Settings): { provider: ProviderId; model: string; key: string } | null {
  const order = [s.provider, ...(Object.keys(PROVIDERS) as ProviderId[])]
  for (const p of order) {
    const def = PROVIDERS[p]
    if (!def) continue
    const key = getApiKey(p)
    const connected = def.kind === 'cli' ? !!s.cliConnected[p] : key.length > 0
    if (!connected) continue
    if (p === 'dust' && !s.dustWorkspaceId) continue
    const model = resolveModelTier(p, s.providerModels, s.providerModelsThinking, 'deep', s.providerModelsDeep)
    if (!model) continue
    return { provider: p, model, key }
  }
  return null
}

/** Run one accumulate-the-stream completion against the picked provider. Rejects on stream error. */
function runCompletion(s: Settings, system: string, userText: string, id: string): Promise<string> {
  const picked = pickProvider(s)
  if (!picked) return Promise.reject(new Error('No configured AI provider for brain ingest.'))
  const { provider, model, key } = picked
  const def = PROVIDERS[provider]
  const req: AskStart = { id, mode: 'answer', prompt: userText, history: [] } as AskStart
  return new Promise<string>((resolve, reject) => {
    let out = ''
    createStream({
      providerId: provider,
      kind: def.kind,
      apiKey: key,
      baseURL: provider === 'custom' ? s.customBaseUrl : provider === 'dust' ? s.dustBaseUrl : def.baseUrl,
      workspaceId: s.dustWorkspaceId,
      model,
      temperature: 0, // extraction wants determinism, not creativity
      idleMs: 120_000,
      freshConversation: true, // Dust: never join/replace the live meeting's cached conversation
      system,
      req,
      handlers: {
        onDelta: (t) => {
          out += t
        },
        onDone: () => resolve(out),
        onError: (m) => reject(new Error(m))
      }
    })
  })
}

/** Strip markdown fences / stray prose around the JSON object a model may still emit. */
export function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object in model output')
  return body.slice(start, end + 1)
}

/** Lead with the injection guard, exactly like personas.ts's buildSystem does for its other untrusted-
 *  transcript modes (suggest/summary/recap/vision) — the meeting transcript is third-party data the
 *  model must never treat as instructions. Exported so the assembly itself is directly testable. */
export const buildExtractionSystem = (extra = ''): string =>
  INJECTION_GUARD.trimStart() + '\n\n' + BRAIN_EXTRACTION_PROMPT + extra

async function extractMeeting(s: Settings, transcriptMd: string, sourceFile: string): Promise<MeetingExtraction> {
  // Same redaction discipline as the live ask path (index.ts's askStart handler): the locally-saved
  // transcript file keeps the verbatim original on disk — only the copy sent to the cloud model for
  // extraction is stripped of high-confidence secrets, and only when the user has redaction enabled.
  const safeMd = s.redactSensitive ? redactSecrets(transcriptMd) : transcriptMd
  const user = `Meeting transcript (file: ${basename(sourceFile)}):\n\n"""\n${safeMd.slice(0, 24000)}\n"""`
  const attempt = async (extra: string): Promise<MeetingExtraction> => {
    const raw = await runCompletion(s, buildExtractionSystem(extra), user, `brain-${Date.now()}`)
    return MeetingExtractionSchema.parse(JSON.parse(extractJsonObject(raw)))
  }
  try {
    return await attempt('')
  } catch (e) {
    // One reinforcement retry — malformed JSON is the dominant failure mode, not content.
    mainLog.warn('[brain] first extraction attempt failed, retrying once:', e instanceof Error ? e.message : e)
    return attempt('\n\nREMINDER: your ENTIRE reply must be one valid JSON object. No fences, no prose.')
  }
}

// ── Deterministic merge ──────────────────────────────────────────────────────

const pushUnique = <T>(arr: T[], item: T, key: (t: T) => string): void => {
  if (!arr.some((x) => key(x) === key(item))) arr.push(item)
}

/** Ledger identity for a commitment is its normalized TEXT — a promise re-spoken in a later meeting
 *  ("I'll send the deck", again) is the same obligation, not a second open row. The earliest-dated
 *  row wins (pushUnique keeps the first), so aging starts from when the promise was first made.
 *  Normalizes Unicode form (NFKC, so visually-identical composed/decomposed text matches), strips
 *  trailing sentence punctuation (a re-spoken "Send the deck." vs "send the deck" is one obligation),
 *  then case-folds and collapses whitespace. */
export const commitmentKey = (text: string): string =>
  text
    .normalize('NFKC')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

// ── Provenant field merge (A1 fix: D1 "latest-INGESTED-wins" → "latest-MEETING-DATE-wins") ──────────
//
// Backfill enqueues files in readdirSync order and completes in extraction-COMPLETION order, so a
// chronologically OLD meeting processed LAST could silently overwrite a NEWER meeting's deal state
// (defect D1). This is the single implementation every provenant field (role/org, sector, stage,
// win_likelihood_band, velocity) goes through, so the rule is enforced exactly once, everywhere:
//
//   1. A value pinned/edited by a human is NEVER overwritten by merge — but the incoming (rejected)
//      value is still logged to `superseded` so the full history stays visible even though it lost.
//   2. EXTRACTED confidence never downgrades to a weaker tier (generalizes the old sector-only rule).
//   3. Otherwise, whichever of {current, incoming} has the NEWER meeting date wins and becomes/stays
//      `value`; the OLDER one is recorded into `superseded`. Ties (equal dates) let the incoming value
//      win, matching the pre-v2 "second meeting compounds" behavior when dates are both unknown ('').
//   4. A value-identical incoming (same fact re-confirmed by a later meeting) only refreshes metadata
//      (date/source/quote/confidence) — it is not a new history entry.
//
// Because step 3 always sorts `superseded` by date (most-recent-first) after every push rather than
// simply prepending, the FINAL state (current value + superseded history) is a pure function of the
// SET of {value, date, source_file} candidates ever merged for that field — independent of the order
// they were merged in. That is what makes shuffled-order ingestion converge byte-for-byte with
// chronological-order ingestion (see brain.test.ts's A1 property test).
type ProvenantIncoming<T> = { value: T; source_file: string; date: string; quote?: string; confidence: Confidence }

function pushSuperseded<T>(
  list: Array<{ value: T; date: string; source_file: string }>,
  entry: { value: T; date: string; source_file: string }
): Array<{ value: T; date: string; source_file: string }> {
  return [...list, entry].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 10)
}

function mergeProvenant<T>(
  current: ProvenantField<T> | undefined,
  incoming: ProvenantIncoming<T>,
  valuesEqual: (a: T, b: T) => boolean
): ProvenantField<T> {
  if (!current) {
    return { value: incoming.value, source_file: incoming.source_file, date: incoming.date, quote: incoming.quote, confidence: incoming.confidence, state: 'extracted', superseded: [] }
  }
  if (current.state === 'pinned' || current.state === 'edited') {
    if (valuesEqual(current.value, incoming.value)) return current
    return { ...current, superseded: pushSuperseded(current.superseded, { value: incoming.value, date: incoming.date, source_file: incoming.source_file }) }
  }
  if (current.confidence === 'EXTRACTED' && incoming.confidence !== 'EXTRACTED') return current
  if (valuesEqual(current.value, incoming.value)) {
    if (incoming.date < current.date) return current
    return { ...current, source_file: incoming.source_file, date: incoming.date, quote: incoming.quote ?? current.quote, confidence: incoming.confidence }
  }
  if (incoming.date >= current.date) {
    return {
      value: incoming.value,
      source_file: incoming.source_file,
      date: incoming.date,
      quote: incoming.quote,
      confidence: incoming.confidence,
      state: 'extracted',
      superseded: pushSuperseded(current.superseded, { value: current.value, date: current.date, source_file: current.source_file })
    }
  }
  return { ...current, superseded: pushSuperseded(current.superseded, { value: incoming.value, date: incoming.date, source_file: incoming.source_file }) }
}

const eqStrict = <T>(a: T, b: T): boolean => a === b
const eqVelocity = (a: { signal: string; evidence: string }, b: { signal: string; evidence: string }): boolean =>
  a.signal === b.signal && a.evidence === b.evidence

/** Merge one meeting's extraction into the entity + graph files. Pure data transforms — no LLM here. */
export async function mergeExtraction(
  s: Settings,
  x: MeetingExtraction,
  ref: MeetingRef
): Promise<void> {
  const graph = readGraph(s)
  const addNode = (id: string, type: 'account' | 'person' | 'deal' | 'sector' | 'meeting', label: string): void =>
    pushUnique(graph.nodes, { id, type, label }, (n) => n.id)
  const addEdge = (from: string, to: string, rel: string, confidence: MeetingExtraction['people'][number]['confidence']): void =>
    pushUnique(graph.edges, { from, to, rel, confidence }, (e) => `${e.from}|${e.to}|${e.rel}`)

  const meetingId = `meeting:${slugify(ref.file)}`
  addNode(meetingId, 'meeting', ref.title || ref.file)

  const accountSlug = x.account && x.account.name.trim() ? slugify(x.account.name) : null
  if (x.account && accountSlug) {
    const acc = readAccount(s, accountSlug) ?? {
      schema_version: BRAIN_SCHEMA_VERSION,
      id: accountSlug,
      aliases: [],
      name: x.account.name,
      sector: x.account.sector,
      sector_confidence: x.account.sector_confidence,
      strategic: false,
      people: [],
      deals: [],
      meetings: [],
      win_reasons: [],
      loss_reasons: []
    }
    // A1/B3: latest-MEETING-DATE-wins (not latest-ingested-wins), never downgrade EXTRACTED to INFERRED,
    // and a human pin/edit is never overwritten — all generalized in mergeProvenant (defect D1 for the
    // three deal fields below; sector's own "never downgrade" rule folds into the same implementation).
    acc.sector_provenance = mergeProvenant(
      acc.sector_provenance,
      { value: x.account.sector, source_file: ref.file, date: ref.date, confidence: x.account.sector_confidence },
      eqStrict
    )
    acc.sector = acc.sector_provenance.value
    acc.sector_confidence = acc.sector_provenance.confidence
    pushUnique(acc.meetings, ref, (m) => m.file)
    for (const sig of x.signals) {
      const bucket = sig.kind === 'positive' ? acc.win_reasons : sig.kind === 'objection' ? acc.loss_reasons : null
      if (bucket) pushUnique(bucket, { statement: sig.statement, quote: sig.quote, meeting: ref.file }, (r) => r.statement + r.meeting)
    }
    addNode(`account:${accountSlug}`, 'account', acc.name)
    addNode(`sector:${acc.sector}`, 'sector', acc.sector)
    addEdge(`account:${accountSlug}`, `sector:${acc.sector}`, 'in-sector', x.account.sector_confidence)
    addEdge(`account:${accountSlug}`, meetingId, 'discussed-in', x.account.confidence)
    await writeAccount(s, accountSlug, acc)
  }

  for (const p of x.people) {
    if (!p.name.trim()) continue
    const pslug = slugify(p.name)
    const person = readPerson(s, pslug) ?? {
      schema_version: BRAIN_SCHEMA_VERSION,
      id: pslug,
      aliases: [],
      name: p.name,
      role: null,
      account: null,
      meetings: [],
      quotes: [],
      stance_trail: [],
      commitments: []
    }
    // A2 fix (D8): org is now allowed to CHANGE across meetings (latest-date-wins via mergeProvenant,
    // same as the deal fields), with the full history in org_provenance.superseded — this is what makes
    // lintBrain's multi-account detection below possible at all; the old "first-write-wins, never
    // overwrite" rule meant a person's account froze at whichever meeting mentioned them first.
    const org = p.org || x.account?.name || null
    if (org) {
      person.org_provenance = mergeProvenant(
        person.org_provenance,
        { value: org, source_file: ref.file, date: ref.date, confidence: p.confidence },
        eqStrict
      )
      person.account = person.org_provenance.value
    }
    if (p.role) {
      person.role_provenance = mergeProvenant(
        person.role_provenance,
        { value: p.role, source_file: ref.file, date: ref.date, confidence: p.confidence },
        eqStrict
      )
      person.role = person.role_provenance.value
    }
    pushUnique(person.meetings, ref, (m) => m.file)
    for (const sig of x.signals) {
      if (sig.quote) pushUnique(person.stance_trail, { meeting: ref.file, kind: sig.kind, statement: sig.statement }, (t) => t.meeting + t.statement)
    }
    // Commitments spoken BY this person (matched by name) join their personal ledger — over time this
    // yields a kept-promise read per counterpart, a signal no transcript-only tool can compute.
    // Accepted design: in a deal-less meeting (x.deal is null, below) there is no ledger to also add
    // these to, so such commitments live ONLY here and stay 'open' forever (settleCommitment is
    // deal-keyed) — a known, accepted limitation, not a bug to fix.
    person.commitments ??= []
    for (const c of x.commitments) {
      if (c.by.toLowerCase() === p.name.toLowerCase()) {
        pushUnique(person.commitments, { ...c, meeting: ref.file, date: ref.date, status: 'open' as const }, (t) => commitmentKey(t.text))
      }
    }
    addNode(`person:${pslug}`, 'person', p.name)
    addEdge(`person:${pslug}`, meetingId, 'attends', p.confidence)
    if (accountSlug) {
      addEdge(`person:${pslug}`, `account:${accountSlug}`, 'works-at', p.org ? 'EXTRACTED' : 'INFERRED')
      const acc = readAccount(s, accountSlug)
      if (acc) {
        pushUnique(acc.people, p.name, (n) => n)
        await writeAccount(s, accountSlug, acc)
      }
    }
    await writePerson(s, pslug, person)
  }

  if (x.deal && (x.deal.name || accountSlug)) {
    const dslug = slugify(x.deal.name || `${x.account?.name ?? 'unknown'} deal`)
    const deal = readDeal(s, dslug) ?? {
      schema_version: BRAIN_SCHEMA_VERSION,
      id: dslug,
      aliases: [],
      name: x.deal.name || `${x.account?.name ?? 'Unknown'} deal`,
      account: x.account?.name ?? '',
      stage: '',
      outcome: 'open' as const,
      win_likelihood_band: null,
      band_evidence: '',
      velocity: { signal: 'no-hard-date-found' as const, evidence: '' },
      meetings: [],
      signals: [],
      missed_signals: [],
      commitments: [],
      feedback: []
    }
    // A1 fix (D1): latest-MEETING-DATE-wins, not latest-ingested-wins — see mergeProvenant above.
    if (x.deal.stage) {
      deal.stage_provenance = mergeProvenant(
        deal.stage_provenance,
        { value: x.deal.stage, source_file: ref.file, date: ref.date, confidence: 'EXTRACTED' },
        eqStrict
      )
      deal.stage = deal.stage_provenance.value
    }
    if (x.deal.win_likelihood_band) {
      deal.win_likelihood_band_provenance = mergeProvenant(
        deal.win_likelihood_band_provenance,
        { value: x.deal.win_likelihood_band, source_file: ref.file, date: ref.date, quote: x.deal.band_evidence, confidence: 'EXTRACTED' },
        eqStrict
      )
      deal.win_likelihood_band = deal.win_likelihood_band_provenance.value
      deal.band_evidence = deal.win_likelihood_band_provenance.quote ?? ''
    }
    // A bland "no info this meeting" report must never clobber an already-known real signal (and once
    // ANY provenance exists for velocity, a further bland report is a no-op — it carries nothing new).
    if (x.deal.velocity.signal !== 'no-hard-date-found' || !deal.velocity_provenance) {
      deal.velocity_provenance = mergeProvenant(
        deal.velocity_provenance,
        { value: x.deal.velocity, source_file: ref.file, date: ref.date, confidence: 'EXTRACTED' },
        eqVelocity
      )
      deal.velocity = deal.velocity_provenance.value
    }
    pushUnique(deal.meetings, ref, (m) => m.file)
    for (const sig of x.signals) pushUnique(deal.signals, { ...sig, meeting: ref.file }, (t) => t.meeting + t.statement)
    for (const ms of x.missed_signals) pushUnique(deal.missed_signals, { ...ms, meeting: ref.file }, (t) => t.meeting + t.statement)
    // Commitment Ledger: promises spoken in this meeting join the deal's ledger as open obligations.
    // Status stays 'open' until later evidence or a human marks it — the merge never guesses.
    for (const c of x.commitments) {
      pushUnique(
        deal.commitments,
        { ...c, meeting: ref.file, date: ref.date, status: 'open' as const },
        (t) => commitmentKey(t.text)
      )
    }
    for (const f of x.feedback) pushUnique(deal.feedback, { ...f, meeting: ref.file }, (t) => t.meeting + t.note)
    addNode(`deal:${dslug}`, 'deal', deal.name)
    addEdge(`deal:${dslug}`, meetingId, 'discussed-in', 'EXTRACTED')
    if (accountSlug) {
      addEdge(`deal:${dslug}`, `account:${accountSlug}`, 'belongs-to', x.account!.confidence)
      const acc = readAccount(s, accountSlug)
      if (acc) {
        pushUnique(acc.deals, deal.name, (n) => n)
        await writeAccount(s, accountSlug, acc)
      }
    }
    await writeDeal(s, dslug, deal)
  }

  await writeGraph(s, graph)
}

// ── Lint (Karpathy's "health check" pass — flag, never auto-fix) ─────────────

export function lintBrain(s: Settings): string[] {
  const warnings: string[] = []
  for (const slug of listEntities(s, 'person')) {
    const p = readPerson(s, slug)
    if (!p) continue
    // A2 fix (D8): the old check derived "orgs" from the single p.account field mapped once per
    // stance_trail entry, so it could never produce more than one distinct value — it never fired.
    // org_provenance's current value + its full superseded history (see mergeExtraction's org merge)
    // is the actual per-meeting account association record; dedupe by SLUG (not raw text) since two
    // spellings of the same account name must not falsely count as "multiple accounts".
    const bySlug = new Map<string, string>() // account slug -> a display value seen for it
    const consider = (v: string | null | undefined): void => {
      if (v && !bySlug.has(slugify(v))) bySlug.set(slugify(v), v)
    }
    consider(p.org_provenance?.value)
    for (const prior of p.org_provenance?.superseded ?? []) consider(prior.value)
    if (bySlug.size > 1) warnings.push(`Person "${p.name}" is linked to multiple accounts: ${[...bySlug.values()].join(', ')}`)
  }
  for (const slug of listEntities(s, 'deal')) {
    const d = readDeal(s, slug)
    if (!d) continue
    if (d.outcome !== 'open' && d.win_likelihood_band) {
      warnings.push(`Deal "${d.name}" is ${d.outcome} but still carries a live win-likelihood band`)
    }
  }
  return warnings
}

/**
 * Settle a commitment — the human closes the loop the LLM never may. Flips the matching row (by
 * normalized text) on the deal's ledger AND any person ledger holding the same promise, so the two
 * copies can't diverge. This is what makes the ledger a live count of what is actually owed, and
 * what makes a per-person kept-promise rate computable at all.
 */
export async function settleCommitment(
  s: Settings,
  dealSlug: string,
  text: string,
  status: 'open' | 'kept' | 'broken'
): Promise<{ ok: boolean; error?: string }> {
  const key = commitmentKey(text)
  const deal = readDeal(s, dealSlug)
  if (!deal) return { ok: false, error: 'Deal not found.' }
  const row = deal.commitments.find((c) => commitmentKey(c.text) === key)
  if (!row) return { ok: false, error: 'Commitment not found on this deal.' }
  row.status = status
  await writeDeal(s, dealSlug, deal)
  // Mirror onto the named person's own ledger when one holds the same promise.
  for (const pslug of listEntities(s, 'person')) {
    const person = readPerson(s, pslug)
    const match = person?.commitments?.find((c) => commitmentKey(c.text) === key)
    if (person && match) {
      match.status = status
      await writePerson(s, pslug, person)
    }
  }
  return { ok: true }
}

// ── Queue + backfill ─────────────────────────────────────────────────────────

type Job = { file: string; source: 'meetings'; origin: 'live' | 'backfill' }
const queue: Job[] = []

// The network-bound stage (extractMeeting, seconds-to-a-minute per call) is what a 100-meeting backfill
// was burning wall-clock time on serially, so up to EXTRACT_CONCURRENCY of those calls now run at once.
// The local-mutation stage (ingestExtraction, plus the error-path index write) stays on a single
// promise chain — ingestChain — so entity files (account/person/deal/graph, none of which have their own
// read-modify-write lock the way index.json has `indexLock` below) are never read-modify-written by two
// jobs at the same time. Concurrency lives entirely in "how many extractions can be in flight", not in
// "how many merges can run at once".
const EXTRACT_CONCURRENCY = 3
let backfillTotal = 0
let backfillDone = 0
// Jobs currently running extractMeeting — bounded to EXTRACT_CONCURRENCY. A job leaves this set the
// moment its extraction settles (success or failure), immediately freeing a slot for the next one,
// independent of how long that job's own serial ingest takes to reach the front of ingestChain.
const extracting = new Set<Job>()
// Every job that's been spliced out of `queue` but hasn't yet finished its FULL lifecycle (extracting,
// or sitting in/being processed by ingestChain) — a superset of `extracting`. Replaces the old single
// `currentJob`: with concurrent extraction, more than one file can be "not in queue, not yet ingested"
// at a time, so startBackfill()'s in-flight dedup guard (a file being worked on right now must not get
// queued a second time by a re-click of "Index meetings") needs a set, not a single slot.
const inFlightJobs = new Set<Job>()
// Serializes ingestExtraction + the error-path index write, in the order each job's EXTRACTION finished
// (not the order jobs started) — see the EXTRACT_CONCURRENCY comment above for why this must stay serial.
let ingestChain: Promise<void> = Promise.resolve()

// index.json has several independent writers (each job's own success/failure record, the
// queue-drained cleanup, and startBackfill's `backfillRequested` flag) that all do a
// read-whole-file → mutate one field → write-whole-file-back round trip. Without serializing
// them, two overlapping round trips — e.g. a second startBackfill() call (re-clicking "Index
// meetings", or resumeBackfillIfPending firing) landing mid-run — silently drop whichever wrote
// last with the staler snapshot. Production symptom: every extraction kept succeeding, but
// idx.ingested ended up empty because a stale rewrite kept clobbering it. Every mutation of
// index.json now goes through this single serialized lane.
let indexLock: Promise<void> = Promise.resolve()
export function updateIndex(s: Settings, mutate: (idx: BrainIndex) => void): Promise<void> {
  const run = indexLock.then(async () => {
    const idx = readIndex(s)
    mutate(idx)
    await writeIndex(s, idx)
  })
  indexLock = run.catch(() => {})
  return run
}

export function brainBackfillProgress(): { total: number; done: number; running: boolean } {
  // "running" while anything is queued, extracting, or waiting on/undergoing its serial ingest —
  // inFlightJobs alone already covers both the extracting and the ingesting stage (see its declaration).
  return { total: backfillTotal, done: backfillDone, running: queue.length > 0 || inFlightJobs.size > 0 }
}

/** Reads the app-written meeting mode from the leading YAML frontmatter only. */
export function readMeetingSourceMode(md: string): string {
  const frontmatter = md.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  if (!frontmatter) return ''

  const raw = frontmatter.match(/^mode:\s*(.*?)\s*$/m)?.[1]?.trim() ?? ''
  const quoted = raw.match(/^(['"])(.*)\1$/)
  const mode = (quoted ? quoted[2] : raw).trim()
  return mode.length <= 100 ? mode : ''
}

/**
 * The full post-extraction ingest: stamp provenance from the transcript's frontmatter (the model
 * can't know its own source file/date), persist the extraction, merge into entities/graph, mark the
 * ingest log, and refresh lint warnings. Exported so the end-to-end proof can drive fixtures through
 * the EXACT production path — the UI's headline "meetings ingested" stat reads the index this writes.
 */
export async function ingestExtraction(s: Settings, x: MeetingExtraction, md: string, file: string): Promise<void> {
  const key = basename(file)
  const sourceMode = readMeetingSourceMode(md)
  // Frontmatter dates aren't always bare tokens: hand-authored or vault-exported files commonly quote
  // the value (`date: "2024-01-15T10:00:00.000Z"`), and a naive \S+ match would keep the quote marks,
  // producing a value that fails Date.parse() downstream and later renders as an obviously broken
  // 'NaN days'. Strip optional wrapping quotes and validate before trusting either field; `start:`
  // (the meeting's actual start time) is tried when `date:` is missing or unparseable, then the file's
  // own mtime as a last resort, so a blank/garbage date never silently sorts as the oldest thing on
  // the Commitment Ledger.
  const readFrontmatterDate = (field: 'date' | 'start'): string | null => {
    const raw = md.match(new RegExp(`^${field}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm'))?.[1]
    return raw && !Number.isNaN(Date.parse(raw)) ? raw : null
  }
  let date = readFrontmatterDate('date') ?? readFrontmatterDate('start')
  if (!date) {
    try {
      date = statSync(file).mtime.toISOString()
    } catch {
      date = ''
    }
    mainLog.warn(`[brain] ${key}: no usable date/start frontmatter, falling back to ${date || 'an empty date'}`)
  }
  const ref: MeetingRef = { file: key, date, title: x.title24 || key }
  // Stamp provenance the model can't know (its own source file + meeting date) so consumers can join
  // extractions back to meetings (call-grade timelines, meeting feeds) without re-reading entity refs.
  x.source_file = key
  x.date = ref.date
  // These are trusted provenance stamps, never model-authored extraction fields.
  x.source_mode = sourceMode
  x.source_use = classifyMeetingSourceUse(sourceMode)
  await writeMeetingExtraction(s, slugify(key), x)
  await mergeExtraction(s, x, ref)
  await updateIndex(s, (idx) => {
    idx.ingested[key] = { at: Date.now(), ok: true }
  })
}

/** The network-bound half of a job: read the transcript, run the (possibly-retried) LLM extraction.
 *  Never rejects — a failure is carried as data (`ok: false`) so the caller can run up to
 *  EXTRACT_CONCURRENCY of these concurrently with Promise machinery, not try/catch across awaits. */
type JobResult =
  | { job: Job; s: Settings; ok: true; x: MeetingExtraction; md: string }
  | { job: Job; s: Settings; ok: false; error: unknown }

async function runExtractionStage(job: Job): Promise<JobResult> {
  // One Settings snapshot per job, taken at the moment its extraction starts, reused for its ingest and
  // live-lint below — matches the pre-concurrency behavior of reading Settings once per job rather than
  // re-reading (and risking a mid-job change) between the extraction and ingest stages.
  const s = getSettings()
  try {
    const md = readSavedFile(job.file)
    const x = await extractMeeting(s, md, job.file)
    return { job, s, ok: true, x, md }
  } catch (error) {
    return { job, s, ok: false, error }
  }
}

/** The local-mutation half of a job: ingest (or record the error), then a live job's own immediate lint.
 *  `origin: 'live'` = a just-saved/just-debriefed meeting ingested one at a time (enqueueIngest) — its
 *  warnings must refresh right away. `origin: 'backfill'` = a job queued by startBackfill; linting is
 *  deferred to maybeFinishDrain() so a 100+ meeting backfill re-lints the whole brain ONCE, not once per
 *  meeting (lintBrain walks every person + deal entity file — O(entities) work per call). Always called
 *  through `ingestChain` (never directly) so two of these never run concurrently. */
async function finishJob(result: JobResult): Promise<void> {
  const { job, s } = result
  try {
    if (!result.ok) throw result.error
    await ingestExtraction(s, result.x, result.md, job.file)
    auditLog('brain.ingest', { ok: true, source: job.source })
  } catch (e) {
    await updateIndex(s, (idx) => {
      idx.ingested[basename(job.file)] = { at: Date.now(), ok: false, error: e instanceof Error ? e.message : String(e) }
    })
    auditLog('brain.ingest', { ok: false, source: job.source })
  }
  if (job.origin === 'live') {
    await updateIndex(s, (idx) => {
      idx.warnings = lintBrain(s)
    })
  }
  // Only a backfill-origin job advances the backfill progress counter — a live (just-saved meeting) job
  // finishing while a backfill happens to be running must never nudge someone else's progress bar (this
  // is also what makes backfillDone/backfillTotal meaningful to reset per-run in startBackfill: they only
  // ever move in lockstep with backfill-origin work). Bumped here, inside ingestChain, so it advances in
  // the same strictly-serial order as the ingest/error-record it belongs to.
  if (job.origin === 'backfill') backfillDone = Math.min(backfillTotal, backfillDone + 1)
}

// Set true while a backfill's jobs are still queued/extracting/ingesting; cleared (with its one lint
// pass) the first time everything drains after it — so a later plain live ingest, which also drains the
// queue, doesn't re-trigger the backfill's one-time cleanup.
let backfillLintPending = false

// Logged at most once per no-provider stall, not once per bailed job — a 60+ transcript backfill with
// no provider configured would otherwise spam this warning once per queued job.
let loggedNoProviderStall = false

/** Runs after every state change (a job dequeued, an extraction settled, an ingest completed) to check
 *  for a TRUE drain: queue empty AND nothing extracting AND nothing waiting on/undergoing ingest AND the
 *  whole backfill batch has been accounted for. A stall (jobs stuck in `queue` because no provider is
 *  configured) must never trip this — inFlightJobs and queue both being empty is what makes it "true". */
function maybeFinishDrain(): void {
  if (
    queue.length === 0 &&
    inFlightJobs.size === 0 &&
    backfillLintPending &&
    backfillTotal > 0 &&
    backfillDone >= backfillTotal
  ) {
    backfillLintPending = false
    const sx = getSettings()
    void updateIndex(sx, (i) => {
      i.backfillRequested = false
      i.warnings = lintBrain(sx)
    })
  }
}

function pump(): void {
  // Keep starting extractions until EXTRACT_CONCURRENCY are in flight or nothing left qualifies. Each
  // iteration re-finds the first job pump() can actually act on: a live job always qualifies, a backfill
  // job only qualifies while a provider is configured. A provider can be removed (cleared key, CLI
  // disconnected) after startBackfill() already queued jobs — re-checking here, not just at queue time,
  // stops a mid-backfill provider loss from burning every remaining job on a guaranteed "No configured AI
  // provider" failure (each with its one reinforcement retry, i.e. 2 doomed calls per job). Backfill jobs
  // stay AT THE FRONT of the queue (never removed here) so a live job enqueued behind a stalled backfill
  // still gets picked and processed — the stall must never starve normal per-meeting ingests.
  while (extracting.size < EXTRACT_CONCURRENCY) {
    let s: Settings | null = null
    const idx = queue.findIndex((j) => {
      if (j.origin !== 'backfill') return true
      s ??= getSettings()
      return hasUsableProvider(s)
    })
    if (idx === -1) {
      // Every queued job is a backfill job and no provider is configured — nothing to do right now.
      if (queue.length > 0 && !loggedNoProviderStall) {
        loggedNoProviderStall = true
        mainLog.warn('[brain] backfill paused: no configured AI provider — will resume next time one is available')
      }
      break
    }
    loggedNoProviderStall = false
    const [job] = queue.splice(idx, 1)
    extracting.add(job)
    inFlightJobs.add(job)
    void runExtractionStage(job).then((result) => {
      extracting.delete(job)
      pump() // a slot just freed — start the next eligible extraction now, without waiting on this job's ingest
      ingestChain = ingestChain
        .then(() => finishJob(result))
        // Defensive: finishJob catches its own extraction/ingest errors internally and should never
        // reject, but if it somehow did, letting the rejection propagate unhandled would permanently wedge
        // ingestChain — every later job's `.then()` chained onto a rejected promise skips straight to
        // re-rejecting, so no further job would ever ingest. Swallowing it here (like indexLock does
        // above) keeps the chain alive for the next job.
        .catch((e) => mainLog.error('[brain] unexpected error finishing a brain ingest job:', e))
        .finally(() => {
          inFlightJobs.delete(job)
          pump() // this job's ingest just completed — re-check for a drain, and for newly-eligible backfill work
        })
    })
  }
  maybeFinishDrain()
}

/** Enqueue one just-saved meeting (fire-and-forget; called after saveMeeting completes). */
export function enqueueIngest(file: string): void {
  queue.push({ file, source: 'meetings', origin: 'live' })
  pump()
}

/**
 * Resume an interrupted backfill on app boot: the request flag persists in index.json until the queue
 * fully drains, so a quit/relaunch mid-backfill picks up the remaining transcripts automatically.
 * Never starts spontaneously — only when a backfill was explicitly requested and left unfinished.
 */
export function resumeBackfillIfPending(): void {
  try {
    const idx = readIndex(getSettings())
    if (idx.backfillRequested) {
      const r = startBackfill()
      if (r.queued > 0) mainLog.info(`[brain] resuming interrupted backfill: ${r.queued} transcripts remaining`)
    }
  } catch {
    /* brain store unreadable — a manual backfill will surface the real error */
  }
}

/** Queue every not-yet-ingested transcript from the meetings folder + the vault. Resumable via index.
 *  Safe to call again while a backfill is already running (re-clicking "Index meetings",
 *  resumeBackfillIfPending firing mid-session) — it tops up the queue instead of resetting progress,
 *  and skips files already queued or completed so nothing is double-processed. */
export function startBackfill(): { queued: number } {
  const s = getSettings()
  const idx = readIndex(s)
  if (!idx.backfillRequested) void updateIndex(s, (i) => { i.backfillRequested = true })
  // No provider configured: skip the directory scan + queueing entirely rather than queueing 60+ jobs
  // that pump() would just re-queue one at a time anyway (see its own no-provider guard above). Cheaper,
  // and the log stays a single line instead of one per bailed job. backfillRequested is left true (set
  // just above) so resumeBackfillIfPending tries again on a later boot once a provider is configured.
  if (!hasUsableProvider(s)) {
    mainLog.warn('[brain] backfill requested but no configured AI provider — deferring until one is set up')
    return { queued: 0 }
  }
  const already = new Set(Object.entries(idx.ingested).filter(([, v]) => v.ok).map(([k]) => k))
  // The ingest log is a cache of "already extracted", not the source of truth — if it's ever out of
  // sync with reality (the race above, a manual edit, a version before this log existed), a real
  // extraction file already on disk still means the work is done. Checking both means a lost/stale
  // log costs a status-count fib, never a re-burned Dust call re-processing finished meetings.
  const extractedSlugs = new Set(listMeetingExtractions(s))
  // pump() has already spliced any currently-extracting-or-ingesting job out of `queue` by the time it's
  // mid-flight — omitting those here would let a re-click of "Index meetings" queue the exact same file
  // a second time while it's still being extracted (or is sitting in ingestChain). inFlightJobs covers
  // both a backfill job and a live job (a live job can never collide with a backfill candidate by
  // content, but checking it unconditionally is simpler than branching on origin and costs nothing).
  const inFlight = new Set(queue.map((j) => basename(j.file)))
  for (const j of inFlightJobs) inFlight.add(basename(j.file))
  // A fresh run: no backfill-origin work left queued or in flight from a previous batch. Reset the
  // progress counters here rather than accumulate onto a finished run's stale total/done — otherwise a
  // live meeting save processed after backfill #1 finished (which left backfillTotal > 0 behind) would
  // still pass the old `if (backfillTotal > 0)` check and corrupt backfill #2's freshly-started progress
  // readout with counts left over from a completed, unrelated run.
  const backfillInFlight =
    queue.some((j) => j.origin === 'backfill') || [...inFlightJobs].some((j) => j.origin === 'backfill')
  if (!backfillInFlight) {
    backfillTotal = 0
    backfillDone = 0
  }
  const candidates: Job[] = []
  const folder = resolveMeetingsFolder(s)
  for (const f of existsSync(folder) ? readdirSync(folder) : []) {
    if (
      f.endsWith('.md') &&
      !f.startsWith('.') &&
      f !== 'index.md' &&
      !already.has(f) &&
      !inFlight.has(f) &&
      !extractedSlugs.has(slugify(f))
    ) {
      candidates.push({ file: join(folder, f), source: 'meetings', origin: 'backfill' })
    }
  }
  // Accumulate rather than overwrite: a re-entrant call must extend an in-flight backfill's progress
  // tracking, not reset it out from under the jobs already queued.
  if (candidates.length > 0) backfillLintPending = true
  backfillTotal += candidates.length
  queue.push(...candidates)
  pump()
  return { queued: candidates.length }
}
