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
  type ProvenanceState,
  type ProvenantField,
  type EntityKind
} from '@shared/brain'
import { INJECTION_GUARD } from '@shared/prompts'
import { redactSecrets } from '@shared/redact'
import { fnv1a } from '@shared/hash'
import { alignQuote, verifyNumericFact, extractNumerals, numeralDerivable } from '@shared/grounding'
import { getSettings, getApiKey, getAllowedProviders } from '../store'
import { createStream } from '../llm'
import { isTransient } from '../llm/retry'
import { localBaseReady } from '../llm/local-routing'
import { readSavedFile, resolveMeetingsFolder } from '../transcripts'
import { auditLog, mainLog } from '../logger'
import {
  slugify,
  commitmentKey,
  pushUnique,
  pushSuperseded,
  outranks,
  eqStrict,
  eqVelocity,
  eqAmount,
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
  listMeetingExtractions,
  readMeetingExtraction,
  withEntityLock,
  purgeBrain
} from './store'
import { applyCorrections, readAliasMap, resolveEntitySlug, replayCorrections, readCorrectionsJournalSafe } from './corrections'
import { publishForExtraction, publishIndexes, publishAll } from './publish'

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

/** Ordered eligible candidates for brain extraction — the SAME eligibility checks pickProvider always
 *  ran (org allowedProviders, local-summary opt-in, connected/keyed, model resolved), but returns the
 *  full waterfall instead of stopping at the first hit, so a transport failure on one provider can fail
 *  over to the next WITHOUT ever reaching a provider these gates would have excluded. An enabled Métis
 *  Local summary setting is an explicit privacy choice: it is the ONLY candidate whenever active — never
 *  waterfalls into a cloud provider, since that would silently upload a transcript the user chose to
 *  keep on-device. Otherwise, when localLlm.fallback is on and local is ready, local is appended as
 *  the LAST candidate after the whole cloud waterfall — so a meeting still gets indexed when every cloud
 *  provider is down or none is configured, instead of never being indexed at all. */
function pickProviderCandidates(s: Settings): { provider: ProviderId; model: string; key: string }[] {
  if (s.localLlm.useFor.summary && localBaseReady(s, getAllowedProviders())) {
    return [{ provider: 'local', model: s.localLlm.modelId, key: '' }]
  }

  // Honor the org's allowedProviders policy — this background pipeline streams the full meeting
  // transcript to the provider, so an org that pinned e.g. ["dust"] for data residency must not have
  // it silently sent to any other keyed provider (the interactive ask path already filters the same way).
  const allowed = getAllowedProviders()
  const order = [s.provider, ...(Object.keys(PROVIDERS) as ProviderId[])]
  const seen = new Set<ProviderId>()
  const candidates: { provider: ProviderId; model: string; key: string }[] = []
  for (const p of order) {
    // Local is handled above because it has no API key and follows a different opt-in policy.
    if (p === 'local' || seen.has(p)) continue
    seen.add(p)
    if (allowed && !allowed.includes(p)) continue
    const def = PROVIDERS[p]
    if (!def) continue
    const key = getApiKey(p)
    const connected = def.kind === 'cli' ? !!s.cliConnected[p] : key.length > 0
    if (!connected) continue
    if (p === 'dust' && !s.dustWorkspaceId) continue
    const model = resolveModelTier(p, s.providerModels, s.providerModelsThinking, 'deep', s.providerModelsDeep)
    if (!model) continue
    candidates.push({ provider: p, model, key })
  }
  // Last-resort local fallback: appended AFTER every cloud candidate, never ahead of one, so a
  // meeting still gets indexed when every configured cloud provider has failed or none is configured
  // at all — instead of throwing 'No configured AI provider' and never indexing it. Distinct from the
  // useFor.summary exclusive-local branch above (which returns early and never reaches this line):
  // that's an explicit privacy choice ("local only, never cloud"), this is the opposite direction
  // ("cloud first, local only once cloud is exhausted"). Gated on the same localBaseReady() eligibility
  // (enabled, runtime+model provisioned, org allowlist permits 'local') so it can never silently start
  // local processing for a user/org that hasn't opted in.
  if (s.localLlm.fallback && localBaseReady(s, allowed)) {
    candidates.push({ provider: 'local', model: s.localLlm.modelId, key: '' })
  }
  return candidates
}

/** Pick the first usable text provider — kept for callers that only need a yes/no or a single candidate
 *  (hasUsableProvider); the extraction path itself now walks pickProviderCandidates. */
function pickProvider(s: Settings): { provider: ProviderId; model: string; key: string } | null {
  return pickProviderCandidates(s)[0] ?? null
}

/** Transport-failure gate for the extraction failover walk (network/4xx/5xx/timeout). Deliberately
 *  BROADER than the interactive ask path's isTransient: that gate treats a non-429 4xx (bad model, dead
 *  endpoint) and an idle-stream timeout as PERMANENT because its fix is "stop hammering the SAME
 *  provider, surface the error" — but this pipeline's known failure mode (a provider consistently
 *  returning e.g. HTTP 404 for a misconfigured/retired model) is exactly that kind of permanent-looking
 *  4xx, and a DIFFERENT eligible provider can still serve the request. Anything that isn't a deliberate
 *  cancel is worth one hop to the next candidate; MAX_INGEST_ATTEMPTS is what stops a transcript with
 *  every provider down from retrying forever, not this gate. */
function isIngestTransportFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (/\babort(ed)?\b/i.test(message)) return false
  if (isTransient(err)) return true
  return /timed out|\b4\d\d\b/i.test(message)
}

/** Run one accumulate-the-stream completion against a SPECIFIC candidate. Rejects on stream error. */
function runCompletionOnce(
  s: Settings,
  picked: { provider: ProviderId; model: string; key: string },
  system: string,
  userText: string,
  id: string
): Promise<string> {
  const { provider, model, key } = picked
  const def = PROVIDERS[provider]
  const isLocal = provider === 'local'
  const req: AskStart = isLocal
    ? ({ id, mode: 'summary', prompt: '', transcript: userText, history: [] } as AskStart)
    : ({ id, mode: 'answer', prompt: userText, history: [] } as AskStart)
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
      maxOutputTokens: isLocal ? 1536 : undefined,
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

/** Run one extraction completion, walking the ordered eligible candidates (pickProviderCandidates) on a
 *  transport failure (isIngestTransportFailure) so one dead provider can never stall the whole backfill
 *  queue. Eligibility is fixed once by pickProviderCandidates — a failover can never reach a provider
 *  the org allowlist / local opt-in gates would have excluded. `onlyProvider`, when given, restricts the
 *  attempt to that ONE already-eligible candidate — used to pin the JSON-reminder retry (see
 *  extractMeeting) to the SAME provider that produced the malformed output, rather than restarting the
 *  waterfall. Returns the provider that actually served the completion. */
async function runCompletion(
  s: Settings,
  system: string,
  userText: string,
  id: string,
  onlyProvider?: ProviderId
): Promise<{ text: string; provider: ProviderId }> {
  const candidates = pickProviderCandidates(s)
  const pool = onlyProvider ? candidates.filter((c) => c.provider === onlyProvider) : candidates
  if (pool.length === 0) throw new Error('No configured AI provider for brain ingest.')
  for (let i = 0; i < pool.length; i++) {
    const picked = pool[i]
    try {
      const text = await runCompletionOnce(s, picked, system, userText, id)
      return { text, provider: picked.provider }
    } catch (e) {
      const hasNext = i < pool.length - 1
      if (!hasNext || !isIngestTransportFailure(e)) throw e
      mainLog.warn(`[brain] ${picked.provider} transport failure during extraction, failing over:`, e instanceof Error ? e.message : e)
    }
  }
  // Unreachable — the loop above always either returns or throws — but keeps the function's return type
  // honest for TypeScript's control-flow analysis.
  throw new Error('No configured AI provider for brain ingest.')
}

/** Strip markdown fences / stray prose around the JSON object a model may still emit. */
export function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  if (start === -1) throw new Error('No JSON object in model output')

  // Small on-device models occasionally append a second JSON fragment or a prose note after the
  // requested object. `lastIndexOf('}')` made the whole concatenation invalid JSON; scan for the first
  // balanced object instead, respecting braces and escapes inside JSON strings.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return body.slice(start, i + 1)
    }
  }
  throw new Error('No complete JSON object in model output')
}

/** Lead with the injection guard, exactly like personas.ts's buildSystem does for its other untrusted-
 *  transcript modes (suggest/summary/recap/vision) — the meeting transcript is third-party data the
 *  model must never treat as instructions. Exported so the assembly itself is directly testable. */
export const buildExtractionSystem = (extra = ''): string =>
  INJECTION_GUARD.trimStart() + '\n\n' + BRAIN_EXTRACTION_PROMPT + extra

// ── Windowed extraction (Task MI-4, kills D2 — the old hard 24k truncation) ──────────────────────────

// Same size as the old hardcoded `.slice(0, 24000)` — a transcript at or under this length takes the
// EXACT single-completion-call path it always has (see splitIntoWindows's own byte-identity guarantee).
const WINDOW_SIZE = 24000
// ~1k of trailing context carried into the next window so a fact split across a window boundary (a
// number stated in one line, its supporting clause in the next) still has a chance to align in EITHER
// window — small relative to WINDOW_SIZE, so it never meaningfully multiplies completion-call volume.
const WINDOW_OVERLAP = 1000

/** Split `text` into sequential windows of at most `size` chars, cut at line boundaries so a window
 *  never splits a transcript line, with `overlap` chars of trailing context carried into the next
 *  window. Returns `[text]` UNCHANGED when `text.length <= size` — the single-window path every
 *  transcript at or under the threshold takes, byte-identical to pre-MI-4 behavior (a 1-element array's
 *  `.join()` below reproduces `text` exactly, so no downstream branching is needed for that case). */
export function splitIntoWindows(text: string, size = WINDOW_SIZE, overlap = WINDOW_OVERLAP): string[] {
  if (text.length <= size) return [text]
  const lines = text.split('\n')
  const windows: string[] = []
  let cur: string[] = []
  let curLen = 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const lineLen = line.length + 1 // +1 for the '\n' this line will rejoin with
    if (curLen + lineLen > size && cur.length > 0) {
      windows.push(cur.join('\n'))
      // Seed the next window with the last `overlap` chars' worth of lines from the one just closed.
      const ov: string[] = []
      let ovLen = 0
      for (let j = cur.length - 1; j >= 0 && ovLen < overlap; j--) {
        ov.unshift(cur[j])
        ovLen += cur[j].length + 1
      }
      cur = ov
      curLen = ovLen
      continue // re-evaluate this same line against the freshly-seeded (overlap-only) window
    }
    cur.push(line)
    curLen += lineLen
    i++
  }
  if (cur.length > 0) windows.push(cur.join('\n'))
  return windows
}

type Deal = NonNullable<MeetingExtraction['deal']>
type Account = NonNullable<MeetingExtraction['account']>

/** The window whose title/topics/sentiment/account should anchor the combined extraction — these are
 *  meeting-level descriptive fields that must read as ONE coherent view, not a patchwork of windows. */
function pickAnchorWindow(windows: MeetingExtraction[]): number {
  const extractedIdx = windows.findIndex((w) => w.account?.confidence === 'EXTRACTED')
  if (extractedIdx !== -1) return extractedIdx
  const nonNullIdx = windows.findIndex((w) => w.account !== null)
  return nonNullIdx !== -1 ? nonNullIdx : 0
}

/** Deal combiner: stage/win_likelihood_band(+evidence)/velocity each take the LAST window with a
 *  non-null value — the meeting's final state on that field, positionally deterministic regardless of
 *  how many windows actually mention it. `name`/`account` come from the first window that names them
 *  (identity shouldn't flip mid-combine just because a later window's extraction omitted it). */
function combineDeal(windows: MeetingExtraction[]): Deal | null {
  const withDeal = windows.filter((w): w is MeetingExtraction & { deal: Deal } => w.deal !== null)
  if (withDeal.length === 0) return null
  const name = withDeal.find((w) => w.deal.name)?.deal.name ?? ''
  let stage = ''
  let win_likelihood_band: Deal['win_likelihood_band'] = null
  let band_evidence = ''
  let velocity: Deal['velocity'] = { signal: 'no-hard-date-found', evidence: '' }
  let amount: Deal['amount']
  let close_date: Deal['close_date']
  for (const w of withDeal) {
    if (w.deal.stage) stage = w.deal.stage
    if (w.deal.win_likelihood_band) {
      win_likelihood_band = w.deal.win_likelihood_band
      band_evidence = w.deal.band_evidence
    }
    if (w.deal.velocity.signal !== 'no-hard-date-found') velocity = w.deal.velocity
    if (w.deal.amount) amount = w.deal.amount
    if (w.deal.close_date) close_date = w.deal.close_date
  }
  return { name, stage, win_likelihood_band, band_evidence, velocity, amount, close_date }
}

/** Deterministically combine one meeting's per-window extractions into a single MeetingExtraction.
 *  Called only when a transcript needed more than one window — the caller keeps the single-window
 *  result untouched otherwise, so this function's own quirks can never affect a ≤24k transcript. */
export function combineWindowExtractions(windows: MeetingExtraction[]): MeetingExtraction {
  if (windows.length <= 1) return windows[0]
  const anchor = windows[pickAnchorWindow(windows)]

  const people: MeetingExtraction['people'] = []
  for (const w of windows) for (const p of w.people) pushUnique(people, p, (x) => slugify(x.name))

  const commitments: MeetingExtraction['commitments'] = []
  for (const w of windows) for (const c of w.commitments) pushUnique(commitments, c, (x) => commitmentKey(x.text))

  const signals: MeetingExtraction['signals'] = []
  for (const w of windows) for (const sig of w.signals) pushUnique(signals, sig, (x) => `${x.kind}|${x.statement}`)

  const missed_signals: MeetingExtraction['missed_signals'] = []
  for (const w of windows) for (const m of w.missed_signals) pushUnique(missed_signals, m, (x) => x.statement)

  const feedback: MeetingExtraction['feedback'] = []
  for (const w of windows) for (const f of w.feedback) pushUnique(feedback, f, (x) => x.note)

  const numeric_facts: MeetingExtraction['numeric_facts'] = []
  for (const w of windows) {
    for (const n of w.numeric_facts) pushUnique(numeric_facts, n, (x) => `${x.kind}|${x.value}|${x.unit ?? ''}|${x.quote}`)
  }

  return {
    ...anchor,
    title24: anchor.title24,
    topics: anchor.topics,
    sentiment: anchor.sentiment,
    account: anchor.account as Account | null,
    people,
    deal: combineDeal(windows),
    signals,
    missed_signals,
    commitments,
    feedback,
    numeric_facts
  }
}

// ── Verification (Task MI-4 — "no unverified figure ever shown") ────────────────────────────────────

/** Every numeric_fact + every commitment quote checked against the EXACT prepared text sent to the
 *  model (post-redaction, post-window-concatenation) — never the raw transcript (defect D10): a
 *  redacted-away or fabricated quote must fail verification even if it happens to appear in the
 *  original file. Demotes confidence to AMBIGUOUS on failure; never strips the item (quarantined, not
 *  dropped, so a human can still review and pin it). Pure and exported so it is directly unit-testable
 *  without going through the full createStream/runCompletion machinery. */
/** Language-switch markers ("_[conversation switches to X]_", written by transcripts.ts's
 *  formatTranscript) are renderer-injected prose, not speech — a quote must never VERIFY against one.
 *  Applied to the grounding reference in EVERY alignment check in this module (verifyExtraction,
 *  verifyDealAmount, verifyDealCloseDate, verifyBandEvidence), never to the text sent to the model.
 *  D10 note: for alignQuote's exact-substring path this is strictly conservative (whatever aligns
 *  post-strip aligned pre-strip); the fuzzy/LCS path's slack window can in principle shift by the few
 *  removed marker tokens, but a quote exploiting that would need ~23+ verbatim tokens stitched across
 *  a switch boundary — accepted as out of threat model, same as fuzzy matching's other tolerances. */
function stripLanguageMarkers(text: string): string {
  return text.replace(/^_?\[conversation switches to [^\]]+\]_?$/gm, '')
}

export function verifyExtraction(x: MeetingExtraction, preparedText: string): MeetingExtraction {
  const grounding = stripLanguageMarkers(preparedText)
  const numeric_facts = x.numeric_facts.map((f) => {
    const outcome = verifyNumericFact({ value: f.value, quote: f.quote, unit: f.unit ?? undefined }, grounding)
    return outcome === 'verified' ? f : { ...f, confidence: 'AMBIGUOUS' as const }
  })
  const commitments = x.commitments.map((c) => {
    if (!c.quote) return c // '' is the documented "paraphrase-only" case — nothing to verify
    return alignQuote(c.quote, grounding) ? c : { ...c, confidence: 'AMBIGUOUS' as const }
  })
  return { ...x, numeric_facts, commitments }
}

/** Deal amount verification: the full three-rule verifyNumericFact guarantee (quote aligns + value
 *  derivable from the quote + from the aligned span), currency treated as the unit. */
function verifyDealAmount(amount: Deal['amount'], transcript: string): boolean {
  if (!amount) return false
  return (
    verifyNumericFact(
      { value: amount.value, quote: amount.quote, unit: amount.currency },
      stripLanguageMarkers(transcript)
    ) === 'verified'
  )
}

/** Deal close_date verification: `value` is a free-form date string (not a single scalar+unit), so the
 *  full verifyNumericFact rule doesn't fit — instead, alignQuote the quote, then require every numeral
 *  ACTUALLY STATED IN the date value (extractNumerals — e.g. "2026-06-15" -> 2026, 6, 15; "Q3 2026" ->
 *  3, 2026) to be independently derivable from the quote itself (numeralDerivable, matching
 *  verifyNumericFact's own rule (b): the value must be claimed by the quote, not just co-located with
 *  it). Deterministic; fails closed when the date carries no numeral to check at all. */
function verifyDealCloseDate(closeDate: Deal['close_date'], transcript: string): boolean {
  if (!closeDate || !closeDate.quote) return false
  if (!alignQuote(closeDate.quote, stripLanguageMarkers(transcript))) return false
  const nums = extractNumerals(closeDate.value)
  if (nums.length === 0) return false
  return nums.every((n) => numeralDerivable(n.value, closeDate.quote))
}

/** Deal band_evidence verification: just alignment (band is a qualitative judgement, not a number) —
 *  an evidence string that doesn't verbatim appear in the transcript is not real evidence. */
function verifyBandEvidence(bandEvidence: string, transcript: string): boolean {
  return !!bandEvidence && !!alignQuote(bandEvidence, stripLanguageMarkers(transcript))
}

/**
 * Local models occasionally emit `null` for an optional numeric fact instead of omitting the fact.
 * A numeric fact without a numeric value cannot be verified or safely shown, but it must not reject
 * the rest of a valid meeting extraction. Preserve the strict persisted schema by removing only those
 * malformed optional entries before validation.
 */
function parseExtractionPayload(raw: string): MeetingExtraction {
  const payload: unknown = JSON.parse(extractJsonObject(raw))
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const extraction = payload as Record<string, unknown>
    if ('numeric_facts' in extraction) {
      const numericFacts = extraction.numeric_facts
      extraction.numeric_facts = Array.isArray(numericFacts)
        ? numericFacts.filter((fact) => {
            if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return false
            const value = (fact as Record<string, unknown>).value
            return typeof value === 'number' && Number.isFinite(value)
          })
        : []
    }
  }
  return MeetingExtractionSchema.parse(payload)
}

async function extractMeeting(
  s: Settings,
  transcriptMd: string,
  sourceFile: string
): Promise<{ extraction: MeetingExtraction; preparedText: string }> {
  // Same redaction discipline as the live ask path (index.ts's askStart handler): the locally-saved
  // transcript file keeps the verbatim original on disk — only the copy sent to the cloud model for
  // extraction is stripped of high-confidence secrets, and only when the user has redaction enabled.
  const windows = prepareMeetingWindows(s, transcriptMd)

  const runWindow = async (window: string): Promise<MeetingExtraction> => {
    const user = `Meeting transcript (file: ${basename(sourceFile)}):\n\n"""\n${window}\n"""`
    // Set by attempt() the moment runCompletion returns text, independent of whether that text then
    // parses — so a parse failure's reinforcement retry (below) can pin itself to the SAME provider that
    // produced the bad output. Stays undefined only when runCompletion itself never got any text back
    // (every eligible candidate failed on transport), in which case the retry falls through to a fresh
    // failover walk instead — same as a first attempt.
    let servedBy: ProviderId | undefined
    const attempt = async (extra: string, pin?: ProviderId): Promise<MeetingExtraction> => {
      const { text, provider } = await runCompletion(s, buildExtractionSystem(extra), user, `brain-${Date.now()}`, pin)
      servedBy = provider
      return parseExtractionPayload(text)
    }
    try {
      return await attempt('')
    } catch (e) {
      // One reinforcement retry — malformed JSON is the dominant failure mode, not content. Cross-
      // provider failover for TRANSPORT failures already happened inside runCompletion; this retry is
      // deliberately same-provider (servedBy) so a parse-failure reminder never turns into an accidental
      // provider switch — that's the failover walk's job, not this one's.
      mainLog.warn('[brain] first extraction attempt failed, retrying once:', e instanceof Error ? e.message : e)
      return attempt('\n\nREMINDER: your ENTIRE reply must be one valid JSON object. No fences, no prose.', servedBy)
    }
  }

  // Sequential, not concurrent — see the module doc / windowing comments: EXTRACT_CONCURRENCY governs
  // how many DIFFERENT FILES extract at once, never how many windows of the SAME file run at once.
  const results: MeetingExtraction[] = []
  for (const w of windows) results.push(await runWindow(w))

  const combined = combineWindowExtractions(results)
  // For a single window this is `windows[0]` unchanged (Array.prototype.join on a 1-element array
  // returns that element verbatim, no separator inserted) — the exact text the (sole) completion call
  // saw, preserving byte-identical single-window verification behavior.
  const preparedText = windows.join('\n')
  return { extraction: verifyExtraction(combined, preparedText), preparedText }
}

/** The exact redacted/windowed transcript representation used for extraction-grounding checks. */
function prepareMeetingWindows(s: Settings, transcriptMd: string): string[] {
  return splitIntoWindows(s.redactSensitive ? redactSecrets(transcriptMd) : transcriptMd)
}

/** Exported for checkpoint repair: it must verify against the same text a normal extraction receives. */
export function prepareMeetingText(s: Settings, transcriptMd: string): string {
  return prepareMeetingWindows(s, transcriptMd).join('\n')
}

// ── Deterministic merge ──────────────────────────────────────────────────────

// commitmentKey/pushUnique now live in store.ts (beside slugify) so the correction engine
// (corrections.ts) can reuse the exact same normalization/de-dup semantics without a corrections.ts
// <-> ingest.ts import cycle; re-exported here unchanged for every existing caller/test of this module.
export { commitmentKey }

// ── Provenant field merge (A1 fix: D1 "latest-INGESTED-wins" → "latest-MEETING-DATE-wins") ──────────
//
// Backfill enqueues files in readdirSync order and completes in extraction-COMPLETION order, so a
// chronologically OLD meeting processed LAST could silently overwrite a NEWER meeting's deal state
// (defect D1). This is the single implementation every provenant field (role/org, sector, stage,
// win_likelihood_band, velocity) goes through, so the rule is enforced exactly once, everywhere.
//
// THE ORDER-INDEPENDENCE GUARANTEE: the final field state (value + provenance + superseded history)
// is a pure function of the SET of {value, date, source_file, confidence} candidates ever merged —
// never of their arrival order. Every rule below exists to keep that true:
//   1. A value pinned/edited by a human is NEVER overwritten by merge — but the incoming (rejected)
//      value is still logged to `superseded` so the full history stays visible even though it lost.
//   2. Winner selection is the deterministic TOTAL order `outranks`: EXTRACTED-grade evidence beats
//      weaker tiers in BOTH directions (the old sector-only "never downgrade" rule, generalized —
//      a one-directional guard would let the winner depend on arrival order in mixed-confidence
//      sets), then meeting date, then source_file as the final tiebreak. Without the source_file
//      tiebreak, two same-day meetings with bare `date:` frontmatter (common) or two blank-date
//      meetings (the statSync-failure fallback) would resolve by arrival order — and backfill's
//      completion order is nondeterministic.
//   3. A value-identical incoming (same fact re-confirmed) refreshes the field's metadata only when
//      it OUTRANKS the evidence already held; it is never a superseded push.
//   4. `superseded` is deduped per value (keeping the max-(confidence tier, date, source_file)
//      sighting under the SAME `outranks` order winner selection uses — MI-4 review fix; a stray
//      superseded entry can no longer disagree with which candidate actually outranks the other),
//      never contains the current value, and stays sorted by that same key desc, capped at 10 — so
//      the history array converges byte-for-byte too, even across mixed-confidence same-value sets.
type ProvenantIncoming<T> = {
  value: T
  source_file: string
  date: string
  quote?: string
  confidence: Confidence
  // MI-4: lets a caller (the amount/close_date merge below) stamp 'verified' directly instead of the
  // default 'extracted' every other provenant field goes through — omitted, every existing call site
  // (role/org/sector/stage/band/velocity) is byte-identical to before this field existed.
  state?: ProvenanceState
}

// `outranks` (the deterministic total-order winner selection every rule above refers to) now lives in
// store.ts beside laterEntry/pushSuperseded: corrections.ts's merge-time provenance fold ranks
// machine-extracted candidates by the same order and cannot import from this module. Its
// date-comparison caveat and totality note moved with it.

function mergeProvenant<T>(
  current: ProvenantField<T> | undefined,
  incoming: ProvenantIncoming<T>,
  valuesEqual: (a: T, b: T) => boolean
): ProvenantField<T> {
  if (!current) {
    return {
      value: incoming.value,
      source_file: incoming.source_file,
      date: incoming.date,
      quote: incoming.quote,
      confidence: incoming.confidence,
      state: incoming.state ?? 'extracted',
      superseded: []
    }
  }
  if (current.state === 'pinned' || current.state === 'edited') {
    if (valuesEqual(current.value, incoming.value)) return current
    return {
      ...current,
      superseded: pushSuperseded(
        current.superseded,
        { value: incoming.value, date: incoming.date, source_file: incoming.source_file, confidence: incoming.confidence },
        current.value,
        valuesEqual
      )
    }
  }
  if (valuesEqual(current.value, incoming.value)) {
    // Re-confirmation refreshes metadata only when the incoming evidence outranks what we already
    // hold. Deliberately NO refresh from a weaker-confidence (or older, or tied-but-lower-file)
    // sighting of the same value: provenance keeps citing the strongest, then most recent, evidence.
    if (!outranks(incoming, current)) return current
    return {
      ...current,
      source_file: incoming.source_file,
      date: incoming.date,
      quote: incoming.quote,
      confidence: incoming.confidence,
      state: incoming.state ?? current.state
    }
  }
  if (outranks(incoming, current)) {
    return {
      value: incoming.value,
      source_file: incoming.source_file,
      date: incoming.date,
      quote: incoming.quote,
      confidence: incoming.confidence,
      state: incoming.state ?? 'extracted',
      superseded: pushSuperseded(
        current.superseded,
        { value: current.value, date: current.date, source_file: current.source_file, confidence: current.confidence },
        incoming.value,
        valuesEqual
      )
    }
  }
  return {
    ...current,
    superseded: pushSuperseded(
      current.superseded,
      { value: incoming.value, date: incoming.date, source_file: incoming.source_file, confidence: incoming.confidence },
      current.value,
      valuesEqual
    )
  }
}

/** Merge one meeting's extraction into the entity + graph files. Pure data transforms — no LLM here. */
export async function mergeExtraction(
  s: Settings,
  x: MeetingExtraction,
  ref: MeetingRef,
  // Optional (Task MI-2): when supplied, entity file routing resolves through it FIRST (an old alias
  // OR the entity's own current name — see readAliasMap's doc comment for why the current name is
  // registered too), falling back to slugify(name) exactly as before when there's no hit. Omitted
  // entirely, behavior is byte-identical to pre-MI-2 — every existing direct caller/test of this
  // function is unaffected. ingestExtraction (the production path) always passes the same aliasMap it
  // already computed for applyCorrections, so a renamed entity's immutable `id` (which can differ from
  // slugify(its current display name)) still resolves to the right file instead of silently forking a
  // second one.
  aliasMap?: Map<string, { kind: EntityKind; id: string; displayName: string }>,
  // MI-4: the exact prepared text extractMeeting sent the model (post-redaction, post-window-
  // concatenation) — needed to compute the deal's band/amount/close_date merge confidence below.
  // Omitted, this function's behavior for every OTHER field is byte-identical to pre-MI-4 (every
  // existing direct caller/test omits it); band_evidence's confidence keeps its old hardcoded
  // 'EXTRACTED' default in that case, and amount/close_date simply never populate (their raw
  // extraction fields don't exist on any pre-MI-4 test fixture either).
  preparedText?: string
): Promise<void> {
  const graph = readGraph(s)
  const addNode = (id: string, type: 'account' | 'person' | 'deal' | 'sector' | 'meeting', label: string): void =>
    pushUnique(graph.nodes, { id, type, label }, (n) => n.id)
  const addEdge = (from: string, to: string, rel: string, confidence: MeetingExtraction['people'][number]['confidence']): void =>
    pushUnique(graph.edges, { from, to, rel, confidence }, (e) => `${e.from}|${e.to}|${e.rel}`)

  const meetingId = `meeting:${slugify(ref.file)}`
  addNode(meetingId, 'meeting', ref.title || ref.file)

  const accountSlug = x.account && x.account.name.trim() ? resolveEntitySlug(aliasMap, 'account', x.account.name) : null
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
    const pslug = resolveEntitySlug(aliasMap, 'person', p.name)
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
    const dslug = resolveEntitySlug(aliasMap, 'deal', x.deal.name || `${x.account?.name ?? 'unknown'} deal`)
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
      // MI-4: band_evidence is only ever real evidence when it verbatim aligns to the transcript the
      // model actually saw — a caller that supplies preparedText gets this checked (confidence AMBIGUOUS
      // on a fabricated/unaligned quote); every pre-MI-4 caller (preparedText omitted) keeps the old
      // hardcoded EXTRACTED, unchanged.
      const bandConfidence: Confidence =
        preparedText === undefined ? 'EXTRACTED' : verifyBandEvidence(x.deal.band_evidence, preparedText) ? 'EXTRACTED' : 'AMBIGUOUS'
      deal.win_likelihood_band_provenance = mergeProvenant(
        deal.win_likelihood_band_provenance,
        { value: x.deal.win_likelihood_band, source_file: ref.file, date: ref.date, quote: x.deal.band_evidence, confidence: bandConfidence },
        eqStrict
      )
      deal.win_likelihood_band = deal.win_likelihood_band_provenance.value
      deal.band_evidence = deal.win_likelihood_band_provenance.quote ?? ''
    }
    // 'no-hard-date-found' is the ABSENCE of information, not a competing fact: it never enters the
    // provenance merge at all. Merging it would let a bland report clobber a real calendar signal
    // (it can carry a newer date), and even just SEEDING provenance with it would leave a bland
    // "superseded" history entry only in the ingestion orders where it happened to arrive first —
    // breaking the order-independence guarantee. Deals whose meetings never surface a real signal
    // simply keep the bland default `velocity` with no provenance, exactly like a v1 file.
    if (x.deal.velocity.signal !== 'no-hard-date-found') {
      deal.velocity_provenance = mergeProvenant(
        deal.velocity_provenance,
        { value: x.deal.velocity, source_file: ref.file, date: ref.date, confidence: 'EXTRACTED' },
        eqVelocity
      )
      deal.velocity = deal.velocity_provenance.value
    }
    // MI-4 — the verified numbers lane. Only ever merged when the raw extraction actually carries an
    // amount/close_date (the model is instructed to omit rather than guess); verified against
    // `preparedText ?? ''` — an omitted preparedText fails closed to AMBIGUOUS/'extracted' rather than
    // silently trusting an unverified figure. state 'verified' + confidence EXTRACTED only when the
    // grounding check actually passes; otherwise state stays 'extracted' + confidence AMBIGUOUS — the
    // money-card render gate (BrainRecordPage's moneyFieldMode / Mars's pipeline-value line /
    // context.ts's formatDeal) never shows a bare figure for that latter case.
    if (x.deal.amount) {
      const verified = verifyDealAmount(x.deal.amount, preparedText ?? '')
      deal.amount = mergeProvenant(
        deal.amount,
        {
          value: { value: x.deal.amount.value, currency: x.deal.amount.currency },
          source_file: ref.file,
          date: ref.date,
          quote: x.deal.amount.quote,
          confidence: verified ? 'EXTRACTED' : 'AMBIGUOUS',
          state: verified ? 'verified' : 'extracted'
        },
        eqAmount
      )
    }
    if (x.deal.close_date) {
      const verified = verifyDealCloseDate(x.deal.close_date, preparedText ?? '')
      deal.close_date = mergeProvenant(
        deal.close_date,
        {
          value: x.deal.close_date.value,
          source_file: ref.file,
          date: ref.date,
          quote: x.deal.close_date.quote,
          confidence: verified ? 'EXTRACTED' : 'AMBIGUOUS',
          state: verified ? 'verified' : 'extracted'
        },
        eqStrict
      )
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

/** One lintBrainDetailed finding, entity-linked so a consumer (brain:attention, Task MI-3) can offer a
 *  jump action straight to the record page — `lintBrain`'s plain string[] (idx.warnings, unchanged since
 *  before MI-3) throws that linkage away, keeping only `detail`. */
export interface LintFinding {
  entityKind: 'person' | 'deal'
  id: string
  label: string
  detail: string
}

export function lintBrainDetailed(s: Settings): LintFinding[] {
  const findings: LintFinding[] = []
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
    if (bySlug.size > 1) {
      findings.push({
        entityKind: 'person',
        id: slug,
        label: p.name,
        detail: `Person "${p.name}" is linked to multiple accounts: ${[...bySlug.values()].join(', ')}`
      })
    }
  }
  for (const slug of listEntities(s, 'deal')) {
    const d = readDeal(s, slug)
    if (!d) continue
    if (d.outcome !== 'open' && d.win_likelihood_band) {
      findings.push({
        entityKind: 'deal',
        id: slug,
        label: d.name,
        detail: `Deal "${d.name}" is ${d.outcome} but still carries a live win-likelihood band`
      })
    }
  }
  return findings
}

/** Plain-string lint warnings (idx.warnings — the shape the dashboard and index.json have always used).
 *  A thin projection over lintBrainDetailed so there is exactly one implementation of the checks
 *  themselves; behavior/wording is unchanged from before Task MI-3. */
export function lintBrain(s: Settings): string[] {
  return lintBrainDetailed(s).map((f) => f.detail)
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

type Job = {
  file: string
  source: 'meetings' | 'team'
  origin: 'live' | 'backfill'
  /** Ingest-index identity. Undefined for the user's own meetings → basename(file), UNCHANGED. A team job
   *  (source: 'team') sets a folder-namespaced key ("team/<owner>/<file>") so a shared-folder transcript
   *  never collides in idx.ingested with an own meeting — or another member's file — of the same basename. */
  key?: string
  /** Attribution for a team transcript: the shared folder's own name, stamped onto the extraction as
   *  source_team so team-contributed knowledge stays distinguishable. Undefined for the user's own meetings. */
  label?: string
  /** mtime/size snapshot at queue time; a later edit must not be merged incrementally. */
  sourceVersion?: string
  /** Re-merge a durable extraction left behind by a crash after extraction but before index success. */
  strategy?: 'reconcile'
}
const queue: Job[] = []

/** Ingest-index identity for a job: the user's own meetings key by basename (unchanged); team jobs carry
 *  an explicit folder-namespaced key so they never collide with a same-named own meeting or member file. */
const jobKey = (j: Job): string => j.key ?? basename(j.file)

/** Storage slug for a meeting's extraction file (.brain/meetings/<slug>.json) — the on-disk identity that
 *  writeMeetingExtraction/readMeetingExtraction and the reconcile-strategy detection all key on. Own
 *  meetings keep slugify(basename), UNCHANGED. A namespaced team key ("team/<owner>/<file>") appends a
 *  short content hash of the full key, because slugify() collapses every "/" to "-" — without the hash a
 *  team key would slugify to the same string as an own file literally named "team-<owner>-<file>.md" and
 *  the two extractions would overwrite each other on disk (silent cross-meeting misattribution). */
export const extractionSlug = (key: string): string =>
  key.includes('/') ? `${slugify(key)}-${fnv1a(key).toString(16)}` : slugify(key)

// The network-bound stage (extractMeeting, seconds-to-a-minute per call) is what a 100-meeting backfill
// was burning wall-clock time on serially, so up to EXTRACT_CONCURRENCY of those calls now run at once.
// The local-mutation stage (ingestExtraction, plus the error-path index write) stays on a single
// serialization lane — store.ts's withEntityLock (MI-2.5 Fix C) — so entity files (account/person/deal/
// graph, none of which have their own read-modify-write lock the way index.json has `indexLock` below)
// are never read-modify-written by two jobs (or a job and a human correction) at the same time.
// Concurrency lives entirely in "how many extractions can be in flight", not in "how many merges can run
// at once".
const EXTRACT_CONCURRENCY = 3
let backfillTotal = 0
let backfillDone = 0
// A renderer-originated Index request defers the potentially slow OneDrive folder scan to the next main
// process turn. This lets the renderer immediately show an honest preparation state instead of appearing
// frozen until readdirSync returns.
let backfillPreparing = false
// A source refresh is a clean rebuild scheduled by the durable index marker. Keep it distinct from a
// normal backfill so a later periodic scan cannot start a second rebuild while corrections replay.
let sourceRefreshRunning = false
// `done` is a terminal queue count, not a successful-ingest count. Keep failures separately so the
// renderer can show honest progress instead of saying every settled job was mapped successfully.
let backfillFailed = 0
// Jobs currently running extractMeeting — bounded to EXTRACT_CONCURRENCY. A job leaves this set the
// moment its extraction settles (success or failure), immediately freeing a slot for the next one,
// independent of how long that job's own serial ingest takes to reach the front of the withEntityLock lane.
const extracting = new Set<Job>()
// Every job that's been spliced out of `queue` but hasn't yet finished its FULL lifecycle (extracting,
// or sitting in/being processed by the withEntityLock lane). A superset of `extracting`. Replaces the old single
// `currentJob`: with concurrent extraction, more than one file can be "not in queue, not yet ingested"
// at a time, so startBackfill()'s in-flight dedup guard (a file being worked on right now must not get
// queued a second time by a re-click of "Index meetings") needs a set, not a single slot.
const inFlightJobs = new Set<Job>()
// Serializes ingestExtraction + the error-path index write, in the order each job's EXTRACTION finished
// (not the order jobs started) — see the EXTRACT_CONCURRENCY comment above for why this must stay serial.
// MI-2.5 Fix C: this lane is store.ts's shared `withEntityLock` (not a private variable here anymore) —
// corrections.ts's five human-correction mutations serialize through the exact same lane, so a rename/
// merge/field-pin/commitment-reject can never race an in-flight backfill's read-modify-write of the same
// entity file (the pre-fix gap: a correction running concurrently with a backfill job could lose an
// update or resurrect a tombstoned entity).

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

/**
 * Fire-and-forget index mutation for callers that have already returned their result to the user.
 *
 * `updateIndexDetached(...)` reads as "deliberately not awaited", but `void` does NOT attach a rejection
 * handler — only the internal `indexLock` chain above is caught, and the promise handed back to the
 * caller still rejects. A profile folder deleted mid-write (test teardown) or any transient fs error
 * therefore surfaced as an UnhandledPromiseRejection: it fails an entire vitest run while every test
 * still reports green, and Node's default for unhandled rejections is to terminate the process — which
 * in main would take the app down long after the operation stopped mattering. Log and swallow instead.
 */
function updateIndexDetached(s: Settings, mutate: (idx: BrainIndex) => void): void {
  updateIndex(s, mutate).catch((e) => mainLog.warn('[brain] detached index update failed:', e))
}

/**
 * Resolve once every queued index.json mutation has settled, successfully or not.
 *
 * `brainBackfillProgress().running` going false is NOT the same as "all writes are done": the last
 * job's own index record is still queued on the serialized lane above at that moment. Anything that
 * tears down or moves the profile — app shutdown, a test's teardown — needs this instead, or it deletes
 * the directory out from under an in-flight tmp+rename.
 */
export function whenIndexWritesSettle(): Promise<void> {
  return indexLock.then(
    () => {},
    () => {}
  )
}

/** Record any derived-brain mutation so both Intelligence surfaces can refresh same-count changes. */
export function markBrainChanged(s: Settings = getSettings()): Promise<void> {
  return updateIndex(s, (idx) => {
    idx.revision += 1
  })
}

/** True only while a user-requested historical index batch still has work to do.
 * Live ingestion shares the worker queue, but it must never make the Index meetings control look busy. */
function hasActiveBackfill(): boolean {
  return queue.some((job) => job.origin === 'backfill') || [...inFlightJobs].some((job) => job.origin === 'backfill')
}

/** Live saves/imports are separate from a historical Index batch, but still need visible status. */
function hasActiveLiveIngest(): boolean {
  return queue.some((job) => job.origin === 'live') || [...inFlightJobs].some((job) => job.origin === 'live')
}

export function brainLiveIngestProgress(): { pending: number; running: boolean } {
  const pending = queue.filter((job) => job.origin === 'live').length + [...inFlightJobs].filter((job) => job.origin === 'live').length
  return { pending, running: pending > 0 }
}

export function brainBackfillProgress(): { total: number; done: number; failed?: number; preparing?: boolean; running: boolean } {
  // A background ingest for a newly saved/imported meeting is intentionally excluded. It has its own
  // meeting-level status; presenting it as an Index batch leaves the historical-index control stuck at
  // “Mapping meetings…” when that batch actually has zero candidates.
  return {
    total: backfillTotal,
    done: backfillDone,
    ...(backfillFailed > 0 ? { failed: backfillFailed } : {}),
    ...(backfillPreparing ? { preparing: true } : {}),
    running: backfillPreparing || sourceRefreshRunning || hasActiveBackfill() || backfillLintPending
  }
}

/**
 * Durable failure counts computed fresh from idx.ingested — unlike brainBackfillProgress's `failed`
 * above (an EPHEMERAL per-run counter that resets to 0 the moment a new backfill starts), a record with
 * ok:false stays that way until it either succeeds or is deleted, so this never under-reports a failure
 * just because no batch happens to be running right now. No separate storage: every ok:false record IS a
 * currently live, unresolved failure (a fixed source overwrites its record with ok:true), so there is
 * nothing stale to filter by a time window. `failed` and `exhausted` are DISJOINT (a record is one or the
 * other, never both) — `failed + exhausted` is the total count of currently-failing sources. `topError`
 * names the most common error string across BOTH, but only once it is shared by at least
 * `minTopErrorCount` records — a one-off error naming itself as "the" provider problem would be
 * misleading noise, not signal.
 */
export function ingestFailureCounts(idx: BrainIndex, minTopErrorCount = 3): { failed: number; exhausted: number; topError?: string } {
  let failed = 0
  let exhausted = 0
  const byError = new Map<string, number>()
  for (const record of Object.values(idx.ingested)) {
    if (record.ok) continue
    if (record.exhausted) exhausted++
    else failed++
    if (record.error) byError.set(record.error, (byError.get(record.error) ?? 0) + 1)
  }
  let topError: string | undefined
  let topCount = 0
  for (const [error, count] of byError) {
    if (count > topCount) {
      topError = error
      topCount = count
    }
  }
  return { failed, exhausted, ...(topError && topCount >= minTopErrorCount ? { topError } : {}) }
}

/** Raw exception messages can embed full absolute paths (fs errors like ENOENT quote the whole path,
 *  Windows username included). The ledger key next to the message already identifies the file, so the
 *  path inside the error text is pure disclosure with no diagnostic value once it reaches the renderer —
 *  a tooltip screenshot pasted into a support channel would leak the local directory layout. Collapse
 *  any drive-rooted or home-rooted path down to its basename before the string leaves the main process. */
function redactPathsInError(error: string): string {
  return error.replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home)\/)[^\s'"`)\]}]+/g, (p) => {
    const base = p.split(/[\\/]/).filter(Boolean).pop() ?? ''
    return base ? `…${base}` : '…'
  })
}

/** Per-file failure detail for up to `limit` currently-failing sources — the file-and-reason counterpart
 *  to ingestFailureCounts' aggregate numbers above. Most-recently-failed first (record.at descending) so
 *  the newest, most actionable failures surface when the ledger holds more than `limit`. Deliberately
 *  bounded: brainStatus is polled every few seconds and must never ship the whole ledger over IPC. */
export function ingestFailureDetails(
  idx: BrainIndex,
  limit = 20
): { file: string; error: string; exhausted: boolean }[] {
  return Object.entries(idx.ingested)
    .filter(([, record]) => !record.ok)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, limit)
    .map(([file, record]) => ({
      file,
      error: redactPathsInError(record.error ?? 'Unknown error'),
      exhausted: !!record.exhausted
    }))
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
 * Cheap source identity for OneDrive-backed folders. mtime plus size detects normal edits without
 * re-reading every transcript on each background scan; a missing snapshot is treated as stale.
 */
function meetingSourceVersion(file: string): string | undefined {
  try {
    const stat = statSync(file)
    return `${Math.round(stat.mtimeMs)}:${stat.size}`
  } catch {
    return undefined
  }
}

const retryDelayMs = (attempts: number): number => Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1))

/** Consecutive-failure ceiling per source. Crossing it marks the record `exhausted` (finishJob) — a
 *  terminal state the automatic reconcile tick (startBackfill's respectRetryBackoff scans) stops
 *  requeuing, so a permanently dead provider/model can't spin the queue on the same doomed transcript
 *  forever. Any OTHER caller (Index/Retry button, dashboard-open check, boot resume, rebuild) already
 *  ignores retryAfter backoff the same way it ignores this cap — see the two scan loops below. */
export const MAX_INGEST_ATTEMPTS = 6

/**
 * The full post-extraction ingest: stamp provenance from the transcript's frontmatter (the model
 * can't know its own source file/date), persist the extraction, merge into entities/graph, mark the
 * ingest log, and refresh lint warnings. Exported so the end-to-end proof can drive fixtures through
 * the EXACT production path — the UI's headline "meetings ingested" stat reads the index this writes.
 */
export async function ingestExtraction(
  s: Settings,
  x: MeetingExtraction,
  md: string,
  file: string,
  // MI-4: the exact prepared text extractMeeting sent the model — threaded straight through to
  // mergeExtraction for the deal band/amount/close_date verification-driven merge. Optional so every
  // existing direct caller (tests driving fixtures without going through extractMeeting) is unaffected.
  preparedText?: string,
  sourceVersion?: string,
  // Ingest-index identity + team attribution for a shared-folder transcript. Both undefined for the user's
  // own meetings (key → basename, source_team → ''), so every existing direct caller (incl. tests) is unaffected.
  indexKey?: string,
  sourceTeam?: string
): Promise<void> {
  // A persisted checkpoint can predate verification plumbing. Re-run deterministic verification before
  // its merge so every recovered amount, date, commitment, and band uses the same grounding rules.
  x = preparedText === undefined ? x : verifyExtraction(x, preparedText)
  const key = indexKey ?? basename(file)
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
  // Team attribution: the shared folder's owner label for a transcript ingested from a team folder, '' for
  // the user's own meetings. source_mode/source_use still come from the transcript's OWN frontmatter, so a
  // teammate's meeting keeps its real mode — source_team only records WHOSE folder it arrived from.
  x.source_team = sourceTeam ?? ''
  // Correction-engine wiring: BOTH display rewrite (applyCorrections) and file routing
  // (mergeExtraction) share the SAME union alias map (readAliasMap — entity-file aliases ∪
  // journal-derived aliases: rename chains resolved transitively, merges mapped from → into).
  //
  // Before the MI-2 review fix, display rewrite used the entity-file map ALONE: during a rebuild's
  // re-ingest (which runs BEFORE replayCorrections), entity files carry no aliases yet, so nothing got
  // rewritten — matching the live path's OWN pre-correction ingests, which also had nothing to rewrite
  // at that point in real time. That equivalence broke the moment a POST-correction meeting reused an
  // old surface form (e.g. "Acme Corp" after a rename to "Acme"): live already had the alias by then
  // (applyCorrections caught it), but a rebuild's re-ingest didn't yet (replay hadn't run) — a
  // live-vs-rebuilt divergence in deal.account, person.account/org, etc.
  //
  // The fix has two halves that only converge TOGETHER:
  //   1. applyRename (corrections.ts) now retroactively rewrites every already-baked dependent display
  //      string (deal.account, person.account + org_provenance.value/superseded, account.people, graph
  //      node labels) the moment a rename runs — live AND replay, since it's the same function. A
  //      PRE-correction meeting's baked strings get fixed up right then, regardless of which path baked
  //      them first.
  //   2. Display rewrite here switches to the UNION map, so a POST-correction meeting's strings are
  //      correct from the moment of ingest even during a rebuild's re-ingest (before replay reaches the
  //      correction) — matching what the live path already had by the time that same meeting was
  //      originally ingested for real.
  // Together: pre-correction meetings are fixed up retroactively (by 1), post-correction meetings are
  // fixed up immediately (by 2) — so live and rebuilt ENTITY files converge regardless of ingest order.
  // The raw STORED meeting-extraction files under `.brain/meetings/` are a deliberate exception: they
  // are the as-extracted historical record and are never retroactively rewritten by applyRename's sweep
  // (only entity files are) — see the MI-2 review report for the convergence check on those files.
  //
  // Persisting the (possibly rewritten) extraction rather than the raw one keeps the stored meeting
  // file and the merged entities in agreement.
  const aliasMap = readAliasMap(s)
  applyCorrections(x, aliasMap)
  await writeMeetingExtraction(s, extractionSlug(key), x)
  await mergeExtraction(s, x, ref, aliasMap, preparedText)
  // Task MI-5: regenerate the touched entity pages + this meeting's note card right after every merge —
  // live AND backfill alike (index regeneration is throttled separately; see finishJob/maybeFinishDrain
  // below, which mirrors exactly how lintBrain itself batches). No-ops entirely when publishBrainPages
  // is off, so this costs nothing when the mirror isn't in use.
  await publishForExtraction(s, x, ref, aliasMap)
  await updateIndex(s, (idx) => {
    const version = sourceVersion ?? meetingSourceVersion(file)
    idx.ingested[key] = { at: Date.now(), ok: true, ...(version ? { sourceVersion: version } : {}), attempts: 0 }
    idx.revision += 1
  })
}

/** The network-bound half of a job: read the transcript, run the (possibly-retried) LLM extraction.
 *  Never rejects — a failure is carried as data (`ok: false`) so the caller can run up to
 *  EXTRACT_CONCURRENCY of these concurrently with Promise machinery, not try/catch across awaits. */
type JobResult =
  | { job: Job; s: Settings; ok: true; x: MeetingExtraction; md: string; preparedText?: string }
  | { job: Job; s: Settings; ok: false; error: unknown }

async function runExtractionStage(job: Job): Promise<JobResult> {
  // One Settings snapshot per job, taken at the moment its extraction starts, reused for its ingest and
  // live-lint below — matches the pre-concurrency behavior of reading Settings once per job rather than
  // re-reading (and risking a mid-job change) between the extraction and ingest stages.
  const s = getSettings()
  try {
    const md = readSavedFile(job.file)
    if (job.strategy === 'reconcile') {
      // Extraction persistence happens before entity/graph merge so a crash can leave a valid meeting
      // JSON alongside an `ok:false` (or absent) index entry. Re-use that exact deterministic result:
      // no second LLM call, no cloud cost, and mergeExtraction's per-meeting de-dup makes the repair
      // safe even if a previous attempt wrote some entities before it was interrupted.
      const savedExtraction = readMeetingExtraction(s, extractionSlug(jobKey(job)))
      if (savedExtraction) return { job, s, ok: true, x: savedExtraction, md, preparedText: prepareMeetingText(s, md) }
    }
    const { extraction, preparedText } = await extractMeeting(s, md, job.file)
    return { job, s, ok: true, x: extraction, md, preparedText }
  } catch (error) {
    return { job, s, ok: false, error }
  }
}

/** The local-mutation half of a job: ingest (or record the error), then a live job's own immediate lint.
 *  `origin: 'live'` = a just-saved/just-debriefed meeting ingested one at a time (enqueueIngest) — its
 *  warnings must refresh right away. `origin: 'backfill'` = a job queued by startBackfill; linting is
 *  deferred to maybeFinishDrain() so a 100+ meeting backfill re-lints the whole brain ONCE, not once per
 *  meeting (lintBrain walks every person + deal entity file — O(entities) work per call). Always called
 *  through store.ts's withEntityLock (never directly) so two of these never run concurrently. */
async function finishJob(result: JobResult): Promise<void> {
  const { job, s } = result
  let failed = false
  try {
    if (!result.ok) throw result.error
    await ingestExtraction(s, result.x, result.md, job.file, result.preparedText, job.sourceVersion, job.key, job.label)
    auditLog('brain.ingest', { ok: true, source: job.source })
  } catch (e) {
    failed = true
    await updateIndex(s, (idx) => {
      const key = jobKey(job)
      const attempts = (idx.ingested[key]?.attempts ?? 0) + 1
      const version = job.sourceVersion ?? meetingSourceVersion(job.file)
      idx.ingested[key] = {
        at: Date.now(),
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        ...(version ? { sourceVersion: version } : {}),
        attempts,
        retryAfter: Date.now() + retryDelayMs(attempts),
        ...(attempts >= MAX_INGEST_ATTEMPTS ? { exhausted: true } : {})
      }
      idx.revision += 1
    })
    auditLog('brain.ingest', { ok: false, source: job.source })
  }
  if (job.origin === 'live') {
    await updateIndex(s, (idx) => {
      idx.warnings = lintBrain(s)
    })
    // Task MI-5: index regen throttled exactly like lintBrain above — one regen per live ingest, one per
    // whole backfill drain (see maybeFinishDrain below), never once per meeting during a backfill.
    await publishIndexes(s)
  }
  // Only a backfill-origin job advances the backfill progress counter — a live (just-saved meeting) job
  // finishing while a backfill happens to be running must never nudge someone else's progress bar (this
  // is also what makes backfillDone/backfillTotal meaningful to reset per-run in startBackfill: they only
  // ever move in lockstep with backfill-origin work). Bumped here, inside the withEntityLock lane, so it
  // advances in the same strictly-serial order as the ingest/error-record it belongs to.
  if (job.origin === 'backfill') {
    backfillDone = Math.min(backfillTotal, backfillDone + 1)
    if (failed) backfillFailed = Math.min(backfillDone, backfillFailed + 1)
  }
}

// Set true while a backfill's jobs are still queued/extracting/ingesting; cleared (with its one lint
// pass) the first time everything drains after it — so a later plain live ingest, which also drains the
// queue, doesn't re-trigger the backfill's one-time cleanup.
let backfillLintPending = false

// Logged at most once per no-provider stall, not once per bailed job — a 60+ transcript backfill with
// no provider configured would otherwise spam this warning once per queued job.
let loggedNoProviderStall = false

// brain:rebuildAll needs to run replayCorrections() only once its purge-then-startBackfill re-extraction
// has FULLY drained — startBackfill() itself only synchronously queues work; completion happens later,
// across pump()'s async extraction/ingest chain. Callbacks registered here fire the next time the whole
// queue (not just this one caller's jobs — see registerDrainCallback's doc comment) goes idle.
const pendingDrainCallbacks: Array<() => void | Promise<void>> = []

/** Registers `cb` to run the next time the queue is fully idle, firing immediately (still async, via
 *  the idle check below) if it already is. `startBackfill`'s only caller today (brain:rebuildAll) always
 *  pushes its own candidates onto `queue` before calling this, so "queue idle" can never mean "before my
 *  jobs were even queued" — by construction the check only ever fires once THIS batch (and anything
 *  else in flight) has actually finished. */
function registerDrainCallback(cb?: () => void | Promise<void>): void {
  if (!cb) return
  pendingDrainCallbacks.push(cb)
  maybeFinishDrain()
}

/** Finishes historical indexing once its own work has drained, independent of live meeting ingestion. */
function maybeFinishBackfill(): void {
  if (!hasActiveBackfill() && backfillLintPending && backfillTotal > 0 && backfillDone >= backfillTotal) {
    backfillLintPending = false
    const sx = getSettings()
    updateIndexDetached(sx, (i) => {
      // A batch can contain local checkpoint repairs while other sources still await their first
      // provider-backed extraction. Do not let completion of the repair subset erase that durable
      // pending state, or those meetings would never be retried after the provider returns.
      if (!hasIncompleteMeetingSource(sx, i)) i.backfillRequested = false
      i.warnings = lintBrain(sx)
    })
    // Task MI-5: one index regen for the whole drained batch, matching the lintBrain call right above.
    void publishIndexes(sx)
  }
}

/** The meeting files that are source material for Intelligence. Keeping this predicate in one place is
 * important: the durable-request cleanup below must inspect the exact same set that Index meetings scans. */
function isMeetingTranscriptFile(file: string): boolean {
  return file.endsWith('.md') && !file.startsWith('.') && file !== 'index.md' && file !== 'README.md'
}

/** Returns null when OneDrive/the filesystem cannot be inspected safely; never infer a deletion then. */
function currentMeetingSourceVersions(s: Settings): Map<string, string> | null {
  const folder = resolveMeetingsFolder(s)
  try {
    if (!existsSync(folder)) return null
    const versions = new Map<string, string>()
    for (const file of readdirSync(folder)) {
      if (!isMeetingTranscriptFile(file)) continue
      const version = meetingSourceVersion(join(folder, file))
      if (!version) return null
      versions.set(file, version)
    }
    return versions
  } catch (error) {
    mainLog.warn(`[brain] could not inspect meeting source versions: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * An existing successful source changed or disappeared. Incremental merge cannot remove stale facts,
 * so retain the source and request a clean derived-store rebuild instead.
 */
function hasMeetingSourceDrift(s: Settings, idx: BrainIndex): boolean {
  const current = currentMeetingSourceVersions(s)
  if (!current) return false
  for (const [file, record] of Object.entries(idx.ingested)) {
    if (!record.ok) continue
    // Skip namespaced team-transcript keys ("team/<owner>/<file>"): they don't live in the meetings folder,
    // so currentMeetingSourceVersions (keyed by basename) never has them — treating that absence as a
    // deletion would falsely trip a full rebuild on every reconcile. Own-meeting keys are bare basenames and
    // never contain '/'. A changed team file re-ingests via its own sourceVersion check in the team scan.
    if (file.includes('/')) continue
    const version = current.get(file)
    if (!version || !record.sourceVersion || record.sourceVersion !== version) return true
  }
  return false
}

/**
 * A request flag is a durability promise, not merely a UI hint. Never clear it while a meeting source
 * still lacks a successful index record. Treat an unavailable folder conservatively too: OneDrive
 * Files On-Demand can make it disappear briefly, and clearing the flag then would strand the work.
 */
function hasIncompleteMeetingSource(s: Settings, idx: BrainIndex): boolean {
  const folder = resolveMeetingsFolder(s)
  try {
    if (!existsSync(folder)) return true
    if (readdirSync(folder).some((file) => isMeetingTranscriptFile(file) && !idx.ingested[file]?.ok)) return true
    // Team transcripts count too: a team file that was deferred (no provider) gets no idx.ingested entry
    // at all, so without this the durable backfillRequested flag could be cleared before it's ever ingested,
    // losing the resume-on-next-boot guarantee (recovery would fall solely to the periodic reconcile timer).
    for (const teamFolder of s.teamTranscriptFolders ?? []) {
      if (!teamFolder) continue
      if (!existsSync(teamFolder)) return true // unavailable (OneDrive blip): treat conservatively
      const owner = basename(teamFolder) || 'team'
      if (readdirSync(teamFolder).some((f) => isMeetingTranscriptFile(f) && !idx.ingested[`team/${owner}/${f}`]?.ok)) return true
    }
    return false
  } catch (error) {
    mainLog.warn(`[brain] could not inspect meeting sources while preserving reconciliation state: ${error instanceof Error ? error.message : String(error)}`)
    return true
  }
}

/**
 * A persisted extraction is already local, deterministic work. It must be eligible for background
 * repair even if a provider/keychain is temporarily unavailable, because no model call is involved.
 */
function hasSavedReconciliationCandidate(s: Settings): boolean {
  const folder = resolveMeetingsFolder(s)
  if (!existsSync(folder)) return false
  const idx = readIndex(s)
  const extractedSlugs = new Set(listMeetingExtractions(s))
  return readdirSync(folder).some((file) =>
    isMeetingTranscriptFile(file) && !idx.ingested[file]?.ok && extractedSlugs.has(extractionSlug(file))
  )
}

/** Runs after every state change (a job dequeued, an extraction settled, an ingest completed) to check
 *  for a TRUE worker drain. A stall (jobs stuck in `queue` because no provider is configured) must never
 *  trip this — inFlightJobs and queue both being empty is what makes it "true". */
function maybeFinishDrain(): void {
  maybeFinishBackfill()
  if (queue.length === 0 && inFlightJobs.size === 0) {
    // A just-saved meeting persists `backfillRequested` before its background job starts so a quit or
    // crash cannot strand it. Once every job truly drains, clear that durable marker only when none of
    // the persisted records remain failed/pending. A failed job therefore survives restart and the next
    // automatic reconciliation retries it instead of silently disappearing.
    const s = getSettings()
    updateIndexDetached(s, (idx) => {
      if (!idx.backfillRequested || Object.values(idx.ingested).some((entry) => !entry.ok) || hasIncompleteMeetingSource(s, idx)) return
      idx.backfillRequested = false
    })
    if (pendingDrainCallbacks.length > 0) {
      const cbs = pendingDrainCallbacks.splice(0, pendingDrainCallbacks.length)
      for (const cb of cbs) {
        try {
          void Promise.resolve(cb()).catch((e) => mainLog.error('[brain] onDrained callback failed:', e))
        } catch (e) {
          mainLog.error('[brain] onDrained callback threw:', e)
        }
      }
    }
    maybeStartSourceRefresh()
  }
}

function pump(): void {
  // Keep starting extractions until EXTRACT_CONCURRENCY are in flight or nothing left qualifies. Each
  // iteration re-finds the first job pump() can actually act on: a live job and a local reconcile job
  // always qualify, while a model-backed backfill job only qualifies while a provider is configured. A provider can be removed (cleared key, CLI
  // disconnected) after startBackfill() already queued jobs — re-checking here, not just at queue time,
  // stops a mid-backfill provider loss from burning every remaining job on a guaranteed "No configured AI
  // provider" failure (each with its one reinforcement retry, i.e. 2 doomed calls per job). Backfill jobs
  // stay AT THE FRONT of the queue (never removed here) so a live job enqueued behind a stalled backfill
  // still gets picked and processed — the stall must never starve normal per-meeting ingests.
  while (extracting.size < EXTRACT_CONCURRENCY) {
    let s: Settings | null = null
    const idx = queue.findIndex((j) => {
      if (j.origin !== 'backfill' || j.strategy === 'reconcile') return true
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
      void withEntityLock(() => finishJob(result))
        // Defensive: finishJob catches its own extraction/ingest errors internally and should never
        // reject, but if it somehow did, letting the rejection propagate unhandled would permanently wedge
        // the lane — every later caller's `.then()` chained onto a rejected promise skips straight to
        // re-rejecting, so no further job would ever ingest. Swallowing it here (like indexLock does
        // above) keeps the lane alive for the next job — withEntityLock itself also guards against this,
        // this is belt-and-suspenders.
        .catch((e) => mainLog.error('[brain] unexpected error finishing a brain ingest job:', e))
        .finally(() => {
          inFlightJobs.delete(job)
          pump() // this job's ingest just completed — re-check for a drain, and for newly-eligible backfill work
        })
    })
  }
  maybeFinishDrain()
}

/**
 * Durable enqueue for a just-saved meeting. The lightweight index write happens before a network-bound
 * extraction is allowed to start, so a quit/restart replays the meeting instead of losing it in RAM.
 * `force` is for an edited existing note such as a debrief: its prior successful extraction is no longer
 * current and must be replaced.
 */
export async function enqueueIngest(file: string, { force = false }: { force?: boolean } = {}): Promise<void> {
  const s = getSettings()
  const key = basename(file)
  const sourceVersion = meetingSourceVersion(file)
  const previous = readIndex(s).ingested[key]
  // Match by the namespaced jobKey, not bare basename: enqueueIngest only ever runs for own-meeting paths
  // (key = basename), but queue/inFlightJobs now also hold team jobs (jobKey "team/<owner>/<file>"). A
  // basename match would let an own meeting collide with a same-named team job (e.g. both "standup.md"),
  // wrongly treating them as the same source and triggering a spurious full rebuild while the own meeting
  // never queues. jobKey(ownJob) === basename, so this still matches a genuine same-file own job.
  const tracked = [...queue, ...inFlightJobs].find((job) => jobKey(job) === key)
  if (tracked) {
    // A write that lands while the prior extraction is active cannot be safely folded into that job.
    // Keep the old job's result from clobbering the newer source by rebuilding from durable sources.
    if (force || (sourceVersion && tracked.sourceVersion && sourceVersion !== tracked.sourceVersion)) {
      await requestSourceRefresh(s)
    }
    return
  }
  if (previous?.ok) {
    if (!force && sourceVersion && previous.sourceVersion === sourceVersion) return
    await requestSourceRefresh(s)
    return
  }
  try {
    await updateIndex(s, (idx) => {
      idx.backfillRequested = true
      // A retry must clear the previous error while leaving an honest durable pending record. The write
      // itself is tiny and local; extraction remains fully backgrounded after this point.
      idx.ingested[key] = { at: Date.now(), ok: false, ...(sourceVersion ? { sourceVersion } : {}), attempts: 0 }
    })
  } catch (error) {
    // The transcript is already durable. Keep the in-memory attempt alive, but log that a sudden quit
    // cannot be recovered until the index store becomes writable again.
    mainLog.warn(`[brain] could not persist live ingest intent for ${key}: ${error instanceof Error ? error.message : String(error)}`)
  }
  queue.push({ file, source: 'meetings', origin: 'live', ...(sourceVersion ? { sourceVersion } : {}) })
  pump()
}

// MI-2.5 review Fix 2: a stable prefix for the human-visible warning finishRebuildReplay pushes into
// idx.warnings when a rebuild's replay could not run — surfaced by BrainView's "Needs a human read" list.
// A dedicated prefix lets a later successful replay find and remove exactly its own warning.
const REPLAY_FAILED_WARNING_PREFIX = 'Rebuild could not re-apply your saved corrections: '

/**
 * Runs the journal replay a rebuild depends on, then clears the `replayPending` flag that survives a
 * quit/crash mid-rebuild (MI-2.5 Fix E) — shared by brain:rebuildAll's own onDrained callback (index.ts)
 * and resumeBackfillIfPending below, so a replay interrupted by a quit still completes exactly the same
 * way a same-session rebuild would. replayCorrections is idempotent (Fix D), so re-running it here even
 * when it partially ran before the crash converges to the same fully-corrected state.
 *
 * MI-2.5 review Fix 2: when the replay could not run (a corrupt/blocked journal, or an exception),
 * `replayPending` is DELIBERATELY left set — a rebuild that replayed zero corrections must never look
 * finished. The reason is recorded durably (`idx.replayError`) and surfaced to the user (a warning in
 * the "Needs a human read" list). A later clean replay clears both. A brand-new AttentionItem kind was
 * intentionally NOT added: the renderer's exhaustive `Record<AttentionItem['kind'], number>` (a file this
 * task must not touch) would fail typecheck — the warnings list is the existing, renderer-safe surface.
 */
export async function finishRebuildReplay(s: Settings): Promise<void> {
  const r = await replayCorrections(s)
  if (r.error) {
    mainLog.error(`[brain] rebuild replay could not run: ${r.error}`)
    await updateIndex(s, (i) => {
      i.replayError = r.error
      // Leave replayPending TRUE — do not report a rebuild that replayed nothing as finished.
      if (!i.warnings.some((w) => w.startsWith(REPLAY_FAILED_WARNING_PREFIX))) {
        i.warnings = [...i.warnings, `${REPLAY_FAILED_WARNING_PREFIX}${r.error}`]
      }
    })
    return
  }
  await updateIndex(s, (i) => {
    i.replayPending = false
    i.replayError = undefined
    i.warnings = i.warnings.filter((w) => !w.startsWith(REPLAY_FAILED_WARNING_PREFIX))
    // Only a rebuild begun for source freshness owns this marker. A normal correction-replay resume can
    // legitimately contain synthetic/legacy index entries without a source file; periodic source scans
    // still discover real drift, but must not turn that replay into an unrelated purge.
    if (i.sourceRefreshRequested) i.sourceRefreshRequested = hasMeetingSourceDrift(s, i)
  })
  // Task MI-5: rebuildAll's completion is publishAll's entry point — a full, deterministic regeneration
  // of every wiki page from the now-fully-corrected brain state, catching anything the per-merge/
  // per-correction hooks above didn't (e.g. a merge tombstone's stale page). No-ops when publishing is off.
  await publishAll(s)
  queueMicrotask(maybeStartSourceRefresh)
}

/**
 * The full brain:rebuildAll orchestration, extracted here (out of the IPC handler) so it is unit-testable
 * and so index.ts stays thin. Wipes the DERIVED store and re-extracts everything, then replays the
 * correction journal onto the fresh entities. Refuses up front — WITHOUT purging — when:
 *   - the correction journal is corrupt/blocked (MI-2.5 review Fix 2): replaying nothing onto a freshly
 *     wiped store while reporting success is exactly the silent-revert this guards against; and
 *   - the purge itself cannot fully reset the store (MI-2.5 Fix F): proceeding over a half-wiped store
 *     would re-ingest atop stale data.
 * Both return a typed `error` (queued: 0) the handler surfaces to the renderer.
 */
type StartRebuildOptions = {
  sourceRefresh?: boolean
  onFinished?: () => void | Promise<void>
}

export async function startRebuild(s: Settings, options: StartRebuildOptions = {}): Promise<{ queued: number; error?: string }> {
  // Do not wipe usable derived data just to discover that no configured provider can recreate it.
  if (!hasUsableProvider(s)) {
    return { queued: 0, error: 'Connect an AI provider in Settings → AI, or enable Métis Local summaries before rebuilding Mantu Intelligence.' }
  }
  const before = readIndex(s)
  const preserveSourceRefresh = options.sourceRefresh || before.sourceRefreshRequested
  // Fix 2 (sync guard): a corrupt/blocked journal fails the gate — refuse before touching the store.
  const gate = await readCorrectionsJournalSafe(s)
  if (!gate.ok) return { queued: 0, error: gate.error }
  // Fix F: preserveCorrections copies the journal to escrow and restores it even if the wipe fails —
  // check the result and abort (nothing re-extracted, corrections safe) rather than rebuild atop a
  // half-deleted store.
  const purge = purgeBrain(s, { preserveCorrections: true })
  if (!purge.ok) {
    return {
      queued: 0,
      error:
        'Could not fully reset the brain store before rebuilding — nothing was re-extracted, and your corrections are safe. Try again, or check for files OneDrive/antivirus may be holding open.'
    }
  }
  // Fix E: replayPending survives a crash independently of backfillRequested; clear any stale replayError.
  await updateIndex(s, (i) => {
    i.replayPending = true
    i.replayError = undefined
    i.revision = before.revision + 1
    i.sourceRefreshRequested = preserveSourceRefresh
  })
  const r = startBackfill(async () => {
    await finishRebuildReplay(s)
    await options.onFinished?.()
  }, { allowSourceRefresh: true })
  return { queued: r.queued }
}

/** Persisted source edits/deletions are replayed as a clean rebuild when a provider is ready. */
export async function requestSourceRefresh(s: Settings = getSettings()): Promise<void> {
  await updateIndex(s, (idx) => {
    idx.sourceRefreshRequested = true
    idx.backfillRequested = true
  })
  maybeStartSourceRefresh()
}

function maybeStartSourceRefresh(): void {
  if (sourceRefreshRunning || queue.length > 0 || inFlightJobs.size > 0 || backfillPreparing) return
  const s = getSettings()
  const idx = readIndex(s)
  if (!idx.sourceRefreshRequested || idx.replayPending || !hasUsableProvider(s)) return
  sourceRefreshRunning = true
  void startRebuild(s, {
    sourceRefresh: true,
    onFinished: () => {
      sourceRefreshRunning = false
      maybeStartSourceRefresh()
    }
  })
    .then((result) => {
      if (!result.error) return
      sourceRefreshRunning = false
      mainLog.warn(`[brain] source refresh is waiting: ${result.error}`)
    })
    .catch((error) => {
      sourceRefreshRunning = false
      mainLog.error('[brain] source refresh could not start:', error)
    })
}

/**
 * Resume an interrupted backfill on app boot: the request flag persists in index.json until the queue
 * fully drains, so a quit/relaunch mid-backfill picks up the remaining transcripts automatically.
 * Never starts spontaneously — only when a backfill was explicitly requested and left unfinished.
 *
 * MI-2.5 Fix E: also resumes an interrupted brain:rebuildAll's journal replay. `replayPending` survives
 * independently of `backfillRequested` — the re-extraction backfill portion of a rebuild can finish (and
 * clear backfillRequested) BEFORE a crash interrupts the replay step itself, so checking backfillRequested
 * alone would miss that window entirely.
 */
export function resumeBackfillIfPending(): void {
  try {
    const s = getSettings()
    const idx = readIndex(s)
    if (idx.sourceRefreshRequested) {
      maybeStartSourceRefresh()
      return
    }
    if (idx.backfillRequested) {
      const onDrained = idx.replayPending ? () => finishRebuildReplay(s) : undefined
      const r = startBackfill(onDrained)
      if (r.queued > 0) mainLog.info(`[brain] resuming interrupted backfill: ${r.queued} transcripts remaining`)
    } else if (idx.replayPending) {
      // The backfill portion of an interrupted rebuild already finished (or never had any work) before
      // the crash, but the journal replay step itself never completed — nothing left to queue, just run
      // the replay now.
      void finishRebuildReplay(s)
    }
  } catch {
    /* brain store unreadable — a manual backfill will surface the real error */
  }
}

/** Queue every not-yet-ingested transcript from the meetings folder + the vault. Resumable via index.
 *  Safe to call again while a backfill is already running (re-clicking "Index meetings",
 *  resumeBackfillIfPending firing mid-session) — it tops up the queue instead of resetting progress,
 *  and skips files already queued or completed so nothing is double-processed.
 *
 *  `onDrained` (Task MI-2, brain:rebuildAll only): fires once every job this call queues — plus
 *  anything else already in flight — has fully finished (see registerDrainCallback's doc comment).
 *  Every other caller (the plain "Index meetings" button, resumeBackfillIfPending) omits it. */
export type BackfillStartResult = { queued: number; deferred?: 'no-provider'; preparing?: boolean }
export type BackfillStartOptions = { respectRetryBackoff?: boolean; allowSourceRefresh?: boolean }

export function startBackfill(onDrained?: () => void | Promise<void>, options: BackfillStartOptions = {}): BackfillStartResult {
  const s = getSettings()
  const idx = readIndex(s)
  const providerAvailable = hasUsableProvider(s)
  if (!options.allowSourceRefresh && (idx.sourceRefreshRequested || hasMeetingSourceDrift(s, idx))) {
    void requestSourceRefresh(s)
    return providerAvailable ? { queued: 0 } : { queued: 0, deferred: 'no-provider' }
  }
  if (!idx.backfillRequested) updateIndexDetached(s, (i) => { i.backfillRequested = true })
  const already = new Set(Object.entries(idx.ingested).filter(([, v]) => v.ok).map(([k]) => k))
  // An extraction file is a resumable checkpoint, not proof of a successful ingest: a crash can land
  // between writeMeetingExtraction and the entity merge/index update. Those entries are re-merged from
  // disk below without another LLM call.
  const extractedSlugs = new Set(listMeetingExtractions(s))
  // pump() has already spliced any currently-extracting-or-ingesting job out of `queue` by the time it's
  // mid-flight — omitting those here would let a re-click of "Index meetings" queue the exact same file
  // a second time while it's still being extracted (or is sitting in the withEntityLock lane). inFlightJobs covers
  // both a backfill job and a live job (a live job can never collide with a backfill candidate by
  // content, but checking it unconditionally is simpler than branching on origin and costs nothing).
  const inFlight = new Set(queue.map(jobKey))
  for (const j of inFlightJobs) inFlight.add(jobKey(j))
  // A fresh run: no backfill-origin work left queued or in flight from a previous batch. Reset the
  // progress counters here rather than accumulate onto a finished run's stale total/done — otherwise a
  // live meeting save processed after backfill #1 finished (which left backfillTotal > 0 behind) would
  // still pass the old `if (backfillTotal > 0)` check and corrupt backfill #2's freshly-started progress
  // readout with counts left over from a completed, unrelated run.
  const backfillInFlight = hasActiveBackfill()
  if (!backfillInFlight) {
    backfillTotal = 0
    backfillDone = 0
    backfillFailed = 0
  }
  const candidates: Job[] = []
  let deferredByProvider = false
  const folder = resolveMeetingsFolder(s)
  const now = Date.now()
  // MAX_INGEST_ATTEMPTS: keys whose exhausted record is being requeued this call — only ever populated
  // when respectRetryBackoff is FALSE (i.e. every caller other than the automatic reconcile tick: the
  // Index/Retry button, the dashboard-open check, boot resume, a rebuild). Cleared durably below so a
  // later automatic tick doesn't immediately re-skip a source this call just gave a fresh attempts budget.
  const toUnexhaust: string[] = []
  for (const f of existsSync(folder) ? readdirSync(folder) : []) {
    if (isMeetingTranscriptFile(f) && !already.has(f) && !inFlight.has(f)) {
      const file = join(folder, f)
      const record = idx.ingested[f]
      const sourceVersion = meetingSourceVersion(file)
      if (
        options.respectRetryBackoff &&
        record &&
        !record.ok &&
        sourceVersion &&
        record.sourceVersion === sourceVersion &&
        (record.retryAfter ?? 0) > now
      ) {
        continue
      }
      // A record that hit MAX_INGEST_ATTEMPTS stops the automatic reconcile tick from ever requeuing it
      // again (a dead provider/model must not spin the queue on the same doomed transcript forever).
      // Every other caller already ignores the retryAfter backoff above the same way — that's the
      // deliberate "try again" path, so give it back a fresh attempts budget instead of re-exhausting
      // after a single extra try.
      if (record?.exhausted) {
        if (options.respectRetryBackoff) continue
        toUnexhaust.push(f)
      }
      // A saved extraction proves the LLM phase completed, not that the entity merge and durable
      // `ingested[file].ok` write completed. Requeue it through the deterministic merge path rather
      // than treating Index meetings as a no-op forever, while avoiding another provider call.
      const strategy = extractedSlugs.has(extractionSlug(f)) ? 'reconcile' as const : undefined
      if (providerAvailable || strategy === 'reconcile') {
        candidates.push({
          file,
          source: 'meetings',
          origin: 'backfill',
          ...(sourceVersion ? { sourceVersion } : {}),
          ...(strategy ? { strategy } : {})
        })
      } else {
        // Leave the durable request flag in place. The source still needs a first extraction, but
        // queueing it now would only generate a guaranteed provider error (and its retry).
        deferredByProvider = true
      }
    }
  }
  // Team transcripts (settings.teamTranscriptFolders): the same OneDrive-friendly scan, extended to each
  // configured shared folder. Deliberately PARALLELS the own-meetings loop above rather than refactoring it,
  // so the own path stays byte-identical. Team files are namespaced in the index ("team/<owner>/<file>") so
  // they never collide with the user's own meetings — or another member's same-named file — and carry the
  // folder's name as source_team attribution. `already`/`inFlight` already hold namespaced keys, so a team
  // file is deduped independently of any own meeting.
  for (const teamFolder of s.teamTranscriptFolders ?? []) {
    if (!teamFolder) continue
    const owner = basename(teamFolder) || 'team'
    for (const f of existsSync(teamFolder) ? readdirSync(teamFolder) : []) {
      if (!isMeetingTranscriptFile(f)) continue
      const key = `team/${owner}/${f}`
      if (already.has(key) || inFlight.has(key)) continue
      const file = join(teamFolder, f)
      const record = idx.ingested[key]
      const sourceVersion = meetingSourceVersion(file)
      if (
        options.respectRetryBackoff &&
        record &&
        !record.ok &&
        sourceVersion &&
        record.sourceVersion === sourceVersion &&
        (record.retryAfter ?? 0) > now
      ) {
        continue
      }
      // Same MAX_INGEST_ATTEMPTS gate as the own-meetings loop above — see its comment.
      if (record?.exhausted) {
        if (options.respectRetryBackoff) continue
        toUnexhaust.push(key)
      }
      const strategy = extractedSlugs.has(extractionSlug(key)) ? ('reconcile' as const) : undefined
      if (providerAvailable || strategy === 'reconcile') {
        candidates.push({
          file,
          source: 'team',
          origin: 'backfill',
          key,
          label: owner,
          ...(sourceVersion ? { sourceVersion } : {}),
          ...(strategy ? { strategy } : {})
        })
      } else {
        deferredByProvider = true
      }
    }
  }
  if (deferredByProvider) {
    mainLog.warn('[brain] backfill has meetings awaiting a configured AI provider; locally saved extractions will still be repaired')
  }
  // Durably clear the exhausted state for everything toUnexhaust just gave back a fresh attempts budget
  // to — same serialized index lane as every other index.json write (see updateIndex's doc comment).
  if (toUnexhaust.length > 0) {
    updateIndexDetached(s, (i) => {
      for (const k of toUnexhaust) {
        if (i.ingested[k]) {
          i.ingested[k].exhausted = false
          i.ingested[k].attempts = 0
        }
      }
      i.revision += 1
    })
  }
  // Accumulate rather than overwrite: a re-entrant call must extend an in-flight backfill's progress
  // tracking, not reset it out from under the jobs already queued.
  if (candidates.length > 0) backfillLintPending = true
  backfillTotal += candidates.length
  queue.push(...candidates)
  pump()
  // There is nothing to resume when every historical meeting was already indexed, or when the only
  // matching meeting is currently being handled by automatic live ingestion. The request flag was set
  // above before scanning, so clear it again through the same serialized index lane.
  if (providerAvailable && candidates.length === 0 && !backfillInFlight && !hasActiveLiveIngest()) {
    updateIndexDetached(s, (i) => {
      if (!hasIncompleteMeetingSource(s, i)) i.backfillRequested = false
    })
  }
  registerDrainCallback(onDrained)
  return deferredByProvider ? { queued: candidates.length, deferred: 'no-provider' } : { queued: candidates.length }
}

/**
 * Schedules the historical-meeting scan after the current IPC turn so an Index click renders its
 * preparation feedback immediately, even when OneDrive takes time to enumerate a large folder.
 * Rebuild/resume paths keep using startBackfill() directly because they need the actual queued count
 * synchronously for their durable journal semantics.
 */
export function requestBackfill(options: BackfillStartOptions = {}): BackfillStartResult {
  const s = getSettings()
  // Preserve the existing synchronous no-provider contract so the renderer can show the actionable
  // setup guidance immediately, while retaining the durable resume flag.
  if (!hasUsableProvider(s)) return startBackfill(undefined, options)
  if (backfillPreparing || sourceRefreshRunning) return { queued: 0, preparing: true }
  // A control cannot normally be clicked during an active run, but keep this guard authoritative for
  // re-entrant IPC callers too. There is already a real batch whose progress will be reported.
  if (hasActiveBackfill() || backfillLintPending) return { queued: 0 }

  backfillPreparing = true
  const idx = readIndex(s)
  if (!idx.backfillRequested) updateIndexDetached(s, (i) => { i.backfillRequested = true })
  setImmediate(() => {
    try {
      startBackfill(undefined, options)
    } catch (error) {
      // Keep the durable request flag intact so a temporary OneDrive/filesystem failure can resume on
      // the next app launch. The source error is still logged rather than silently discarded.
      mainLog.error('[brain] deferred backfill scan failed:', error)
    } finally {
      backfillPreparing = false
    }
  })
  return { queued: 0, preparing: true }
}

/**
 * Low-cost periodic reconciliation for folders synced by OneDrive or another device. Filesystem watchers
 * are not a correctness primitive here: files-on-demand and Windows sync routinely coalesce or omit
 * events. A configured provider enables normal extraction; without one, the loop still repairs any
 * previously-saved extraction because that path is entirely local and never sends meeting content away.
 */
export function reconcileMeetingsInBackground(): void {
  try {
    const s = getSettings()
    if (backfillPreparing || sourceRefreshRunning || hasActiveBackfill()) return
    const idx = readIndex(s)
    if (idx.sourceRefreshRequested || hasMeetingSourceDrift(s, idx)) {
      void requestSourceRefresh(s)
      return
    }
    if (!hasUsableProvider(s) && !hasSavedReconciliationCandidate(s)) return
    requestBackfill({ respectRetryBackoff: true })
  } catch (error) {
    mainLog.warn(`[brain] background meeting reconciliation skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}
