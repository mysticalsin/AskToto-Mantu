import { basename, join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import type { Settings, AskStart } from '@shared/ipc'
import { PROVIDERS, resolveModelTier, type ProviderId } from '@shared/providers'
import {
  BRAIN_EXTRACTION_PROMPT,
  MeetingExtractionSchema,
  type MeetingExtraction,
  type MeetingRef,
  type BrainGraph,
  type BrainIndex
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
  listEntities
} from './store'

/**
 * Brain ingest — turns one saved transcript into a structured extraction, then merges it into the
 * compounding entity files. One LLM call per meeting (active provider, non-streaming semantics by
 * accumulating the stream), deterministic merge code, then a cheap rule-based lint pass. Queued and
 * background: a failed ingest is recorded in index.json and retried on the next rebuild — it can never
 * block or corrupt a meeting save.
 */

// ── LLM call ─────────────────────────────────────────────────────────────────

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

  const accountSlug = x.account ? slugify(x.account.name) : null
  if (x.account && accountSlug) {
    const acc = readAccount(s, accountSlug) ?? {
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
    // A firmer sector classification upgrades a weaker one; never downgrade EXTRACTED to INFERRED.
    if (acc.sector_confidence !== 'EXTRACTED' || x.account.sector_confidence === 'EXTRACTED') {
      acc.sector = x.account.sector
      acc.sector_confidence = x.account.sector_confidence
    }
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
    const pslug = slugify(p.name)
    const person = readPerson(s, pslug) ?? { name: p.name, role: null, account: null, meetings: [], quotes: [], stance_trail: [], commitments: [] }
    if (p.role && !person.role) person.role = p.role
    if ((p.org || x.account) && !person.account) person.account = p.org || x.account?.name || null
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
    if (x.deal.stage) deal.stage = x.deal.stage
    // Latest meeting's judgement wins for band + velocity (it has the freshest information).
    if (x.deal.win_likelihood_band) {
      deal.win_likelihood_band = x.deal.win_likelihood_band
      deal.band_evidence = x.deal.band_evidence
    }
    if (x.deal.velocity.signal !== 'no-hard-date-found' || deal.velocity.signal === 'no-hard-date-found') {
      deal.velocity = x.deal.velocity
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
    const orgs = new Set(p.stance_trail.map(() => p.account).filter(Boolean))
    if (orgs.size > 1) warnings.push(`Person "${p.name}" is linked to multiple accounts: ${[...orgs].join(', ')}`)
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

type Job = { file: string; source: 'meetings' | 'vault' }
const queue: Job[] = []
let running = false
let backfillTotal = 0
let backfillDone = 0

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
  return { total: backfillTotal, done: backfillDone, running }
}

/**
 * The full post-extraction ingest: stamp provenance from the transcript's frontmatter (the model
 * can't know its own source file/date), persist the extraction, merge into entities/graph, mark the
 * ingest log, and refresh lint warnings. Exported so the end-to-end proof can drive fixtures through
 * the EXACT production path — the UI's headline "meetings ingested" stat reads the index this writes.
 */
export async function ingestExtraction(s: Settings, x: MeetingExtraction, md: string, file: string): Promise<void> {
  const key = basename(file)
  const dateMatch = md.match(/^date:\s*(\S+)/m)
  const ref: MeetingRef = { file: key, date: dateMatch?.[1] ?? '', title: x.title24 || key }
  // Stamp provenance the model can't know (its own source file + meeting date) so consumers can join
  // extractions back to meetings (call-grade timelines, meeting feeds) without re-reading entity refs.
  x.source_file = key
  x.date = ref.date
  await writeMeetingExtraction(s, slugify(key), x)
  await mergeExtraction(s, x, ref)
  await updateIndex(s, (idx) => {
    idx.ingested[key] = { at: Date.now(), ok: true }
    idx.warnings = lintBrain(s)
  })
}

async function processJob(job: Job): Promise<void> {
  const s = getSettings()
  try {
    const md = readSavedFile(job.file)
    const x = await extractMeeting(s, md, job.file)
    await ingestExtraction(s, x, md, job.file)
    auditLog('brain.ingest', { ok: true, source: job.source })
  } catch (e) {
    await updateIndex(s, (idx) => {
      idx.ingested[basename(job.file)] = { at: Date.now(), ok: false, error: e instanceof Error ? e.message : String(e) }
      idx.warnings = lintBrain(s)
    })
    auditLog('brain.ingest', { ok: false, source: job.source })
  }
}

function pump(): void {
  if (running) return
  const job = queue.shift()
  if (!job) {
    // Queue drained — if a backfill was in flight, clear the resume flag so the next boot stays idle.
    if (backfillTotal > 0 && backfillDone >= backfillTotal) {
      const s = getSettings()
      void updateIndex(s, (idx) => {
        idx.backfillRequested = false
      })
    }
    return
  }
  running = true
  void processJob(job).finally(() => {
    running = false
    if (job.source === 'vault' || backfillTotal > 0) backfillDone = Math.min(backfillTotal, backfillDone + 1)
    pump()
  })
}

/** Enqueue one just-saved meeting (fire-and-forget; called after saveMeeting completes). */
export function enqueueIngest(file: string): void {
  queue.push({ file, source: 'meetings' })
  pump()
}

/** The vault's historical confidential transcripts (read-only backfill source). */
const VAULT_TRANSCRIPTS = join(
  process.env.HOME || '',
  'Library/CloudStorage/OneDrive-MantuGroup/Documents/AI Second Brain/Meetings/Confidential'
)

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
  const already = new Set(Object.entries(idx.ingested).filter(([, v]) => v.ok).map(([k]) => k))
  const inFlight = new Set(queue.map((j) => basename(j.file)))
  const candidates: Job[] = []
  const folder = resolveMeetingsFolder(s)
  for (const f of existsSync(folder) ? readdirSync(folder) : []) {
    if (f.endsWith('.md') && !f.startsWith('.') && f !== 'index.md' && !already.has(f) && !inFlight.has(f)) {
      candidates.push({ file: join(folder, f), source: 'meetings' })
    }
  }
  for (const f of existsSync(VAULT_TRANSCRIPTS) ? readdirSync(VAULT_TRANSCRIPTS) : []) {
    if (f.endsWith('.md') && !already.has(f) && !inFlight.has(f)) candidates.push({ file: join(VAULT_TRANSCRIPTS, f), source: 'vault' })
  }
  // Accumulate rather than overwrite: a re-entrant call must extend an in-flight backfill's progress
  // tracking, not reset it out from under the jobs already queued.
  backfillTotal += candidates.length
  queue.push(...candidates)
  pump()
  return { queued: candidates.length }
}
