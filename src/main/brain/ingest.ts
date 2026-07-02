import { basename, join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import type { Settings, AskStart } from '@shared/ipc'
import { PROVIDERS, resolveModelTier, type ProviderId } from '@shared/providers'
import {
  BRAIN_EXTRACTION_PROMPT,
  MeetingExtractionSchema,
  type MeetingExtraction,
  type MeetingRef,
  type BrainGraph
} from '@shared/brain'
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
    const model = resolveModelTier(p, s.providerModels, s.providerModelsThinking, 'base')
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

async function extractMeeting(s: Settings, transcriptMd: string, sourceFile: string): Promise<MeetingExtraction> {
  const user = `Meeting transcript (file: ${basename(sourceFile)}):\n\n"""\n${transcriptMd.slice(0, 24000)}\n"""`
  const attempt = async (extra: string): Promise<MeetingExtraction> => {
    const raw = await runCompletion(s, BRAIN_EXTRACTION_PROMPT + extra, user, `brain-${Date.now()}`)
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
    const person = readPerson(s, pslug) ?? { name: p.name, role: null, account: null, meetings: [], quotes: [], stance_trail: [] }
    if (p.role && !person.role) person.role = p.role
    if ((p.org || x.account) && !person.account) person.account = p.org || x.account?.name || null
    pushUnique(person.meetings, ref, (m) => m.file)
    for (const sig of x.signals) {
      if (sig.quote) pushUnique(person.stance_trail, { meeting: ref.file, kind: sig.kind, statement: sig.statement }, (t) => t.meeting + t.statement)
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
    for (const f of x.feedback) pushUnique(deal.feedback, { note: f, meeting: ref.file }, (t) => t.meeting + t.note)
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

// ── Queue + backfill ─────────────────────────────────────────────────────────

type Job = { file: string; source: 'meetings' | 'vault' }
const queue: Job[] = []
let running = false
let backfillTotal = 0
let backfillDone = 0

export function brainBackfillProgress(): { total: number; done: number; running: boolean } {
  return { total: backfillTotal, done: backfillDone, running }
}

async function processJob(job: Job): Promise<void> {
  const s = getSettings()
  const idx = readIndex(s)
  const key = basename(job.file)
  try {
    const md = readSavedFile(job.file)
    const x = await extractMeeting(s, md, job.file)
    const dateMatch = md.match(/^date:\s*(\S+)/m)
    const ref: MeetingRef = { file: key, date: dateMatch?.[1] ?? '', title: x.title24 || key }
    await writeMeetingExtraction(s, slugify(key), x)
    await mergeExtraction(s, x, ref)
    idx.ingested[key] = { at: Date.now(), ok: true }
    auditLog('brain.ingest', { ok: true, source: job.source })
  } catch (e) {
    idx.ingested[key] = { at: Date.now(), ok: false, error: e instanceof Error ? e.message : String(e) }
    auditLog('brain.ingest', { ok: false, source: job.source })
  }
  idx.warnings = lintBrain(s)
  await writeIndex(s, idx)
}

function pump(): void {
  if (running) return
  const job = queue.shift()
  if (!job) {
    // Queue drained — if a backfill was in flight, clear the resume flag so the next boot stays idle.
    if (backfillTotal > 0 && backfillDone >= backfillTotal) {
      const s = getSettings()
      const idx = readIndex(s)
      if (idx.backfillRequested) {
        idx.backfillRequested = false
        void writeIndex(s, idx)
      }
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

/** Queue every not-yet-ingested transcript from the meetings folder + the vault. Resumable via index. */
export function startBackfill(): { queued: number } {
  const s = getSettings()
  const idx = readIndex(s)
  idx.backfillRequested = true
  void writeIndex(s, idx)
  const already = new Set(Object.entries(idx.ingested).filter(([, v]) => v.ok).map(([k]) => k))
  const candidates: Job[] = []
  const folder = resolveMeetingsFolder(s)
  for (const f of existsSync(folder) ? readdirSync(folder) : []) {
    if (f.endsWith('.md') && !f.startsWith('.') && f !== 'index.md' && !already.has(f)) {
      candidates.push({ file: join(folder, f), source: 'meetings' })
    }
  }
  for (const f of existsSync(VAULT_TRANSCRIPTS) ? readdirSync(VAULT_TRANSCRIPTS) : []) {
    if (f.endsWith('.md') && !already.has(f)) candidates.push({ file: join(VAULT_TRANSCRIPTS, f), source: 'vault' })
  }
  backfillTotal = candidates.length
  backfillDone = 0
  queue.push(...candidates)
  pump()
  return { queued: candidates.length }
}
