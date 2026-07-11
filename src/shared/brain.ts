import { z } from 'zod'

/**
 * Mantu Intelligence "Brain" — the LLM-maintained knowledge store built from meeting transcripts.
 *
 * Three-layer design (Karpathy LLM-wiki pattern): raw transcripts stay immutable; the brain holds
 * per-meeting extractions plus compounding entity files (people / accounts / deals) and a relationship
 * graph; this module is the SCHEMA layer that governs what the LLM may write. Every relationship and
 * classification carries a confidence tag (graphify's EXTRACTED/INFERRED/AMBIGUOUS vocabulary) and every
 * claim must cite transcript evidence — the extraction prompt forbids fabrication outright.
 */

// v2 (Task MI-1): adds per-field provenance (ProvenantField, below) + entity-level schema_version/id/
// aliases. See the ProvenantField doc comment for why provenance is added as SIDECAR fields rather than
// replacing the plain role/org/sector/stage/win_likelihood_band/velocity fields in place.
export const BRAIN_SCHEMA_VERSION = 2

export const ConfidenceSchema = z.enum(['EXTRACTED', 'INFERRED', 'AMBIGUOUS'])
export type Confidence = z.infer<typeof ConfidenceSchema>

/** Qualitative LLM-as-judge band — never a percentage; there is no labeled outcome data to calibrate one. */
export const BandSchema = z.enum(['good', 'mixed', 'concerning'])
export type Band = z.infer<typeof BandSchema>

export const SourceUseSchema = z.enum(['eligible', 'employment', 'unknown'])
export type SourceUse = z.infer<typeof SourceUseSchema>

/** Deal velocity: a hard calendar commitment beats soft organizational intent; absence is a valid answer. */
export const VelocitySchema = z.object({
  signal: z.enum(['hard-calendar-gate', 'soft-organizational-gate', 'no-hard-date-found']),
  evidence: z.string().default('')
})

const SECTORS = [
  'retail', 'banking', 'insurance', 'pharma', 'healthcare', 'automotive', 'energy',
  'telecom', 'technology', 'public-sector', 'manufacturing', 'logistics', 'media',
  'aerospace-defense', 'consumer-goods', 'professional-services', 'other'
] as const
export const SectorSchema = z.enum(SECTORS)

export const MeetingPersonSchema = z.object({
  name: z.string(),
  role: z.string().nullable().default(null),
  org: z.string().nullable().default(null),
  confidence: ConfidenceSchema.default('EXTRACTED')
})

export const MeetingSignalSchema = z.object({
  kind: z.enum(['positive', 'objection', 'neutral']),
  statement: z.string(),
  quote: z.string().default(''), // verbatim transcript line supporting the statement ('' if paraphrase-only)
  confidence: ConfidenceSchema.default('EXTRACTED')
})

/**
 * A promise actually SPOKEN in a meeting — the atomic unit of follow-through (the Commitment Ledger).
 * `by` is 'you' (the app's user), 'them' (the other side generically), or a named person. Status only
 * moves off 'open' via later meeting evidence or explicit human action — never by LLM guesswork.
 */
export const CommitmentSchema = z.object({
  text: z.string(),
  by: z.string().default('you'),
  due_hint: z.string().default(''), // verbatim timing language ("by Friday", "after the board") or ''
  quote: z.string().default(''),
  confidence: ConfidenceSchema.default('EXTRACTED')
})
export type Commitment = z.infer<typeof CommitmentSchema>

/** A commitment as stored on an entity: carries its source meeting and a settlement status. */
export const LedgerCommitmentSchema = CommitmentSchema.extend({
  meeting: z.string(),
  date: z.string().default(''), // ISO date of the source meeting — drives aging on the dashboard
  status: z.enum(['open', 'kept', 'broken']).default('open')
})
export type LedgerCommitment = z.infer<typeof LedgerCommitmentSchema>

/** One meeting's structured extraction — the unit the ingest LLM call must return as pure JSON. */
export const MeetingExtractionSchema = z.object({
  schema_version: z.number().default(BRAIN_SCHEMA_VERSION),
  title24: z.string().default(''),
  topics: z.array(z.string()).default([]),
  sentiment: BandSchema.default('mixed'),
  account: z
    .object({
      name: z.string(),
      sector: SectorSchema.default('other'),
      sector_confidence: ConfidenceSchema.default('INFERRED'),
      confidence: ConfidenceSchema.default('EXTRACTED')
    })
    .nullable()
    .default(null),
  people: z.array(MeetingPersonSchema).default([]),
  deal: z
    .object({
      name: z.string().default(''),
      stage: z.string().default(''),
      win_likelihood_band: BandSchema.nullable().default(null),
      band_evidence: z.string().default(''),
      velocity: VelocitySchema.default({ signal: 'no-hard-date-found', evidence: '' })
    })
    .nullable()
    .default(null),
  signals: z.array(MeetingSignalSchema).default([]),
  missed_signals: z
    .array(
      z.object({
        statement: z.string(),
        why_it_matters: z.string().default(''),
        quote: z.string().default(''), // the transcript moment that shows the missed opening ('' if none)
        confidence: ConfidenceSchema.default('INFERRED')
      })
    )
    .default([]),
  commitments: z.array(CommitmentSchema).default([]),
  // Coaching notes. Accepts the legacy plain-string form (early extractions) and normalizes it: an
  // untagged note is by definition the model's inference, so it lands as INFERRED with no quote —
  // that legacy flatness is exactly why every insight once displayed an identical 60% confidence.
  feedback: z
    .array(
      z.union([
        z.string(),
        z.object({
          note: z.string(),
          quote: z.string().default(''), // verbatim moment the note is anchored to ('' if none)
          confidence: ConfidenceSchema.default('INFERRED')
        })
      ])
    )
    .transform((items) =>
      items.map((i) => (typeof i === 'string' ? { note: i, quote: '', confidence: 'INFERRED' as const } : i))
    )
    .default([]),
  // Stamped from the configured conversation mode, never inferred from transcript content.
  source_mode: z.string().default(''),
  source_use: SourceUseSchema.default('unknown'),
  // Stamped by the ingest job (not the model): source transcript basename + its ISO date, so consumers
  // (call-grade timelines, meeting feeds) can join extractions back to meetings without re-reading refs.
  source_file: z.string().default(''),
  date: z.string().default('')
})
export type MeetingExtraction = z.infer<typeof MeetingExtractionSchema>

/** A brain reference back to the source meeting — file basename keeps the store portable with the folder. */
export const MeetingRefSchema = z.object({
  file: z.string(),
  date: z.string().default(''),
  title: z.string().default('')
})
export type MeetingRef = z.infer<typeof MeetingRefSchema>

/**
 * v2 provenance (Task MI-1, brain schema foundation) — per-field "who said this, when, how sure were
 * they" for the handful of entity fields that compound across meetings (role/org, sector, stage,
 * win_likelihood_band, velocity). `superseded` is the field's history: every prior value it held,
 * most-recent-first, capped at 10 (oldest dropped) so a long-lived deal's file can't grow unbounded.
 *
 * DESIGN NOTE — why this is a SIDECAR (`<field>_provenance`), not a replacement of the plain field:
 * PersonEntity.role/.account, AccountEntity.sector, and DealEntity.stage/.win_likelihood_band/.velocity
 * are read as plain strings/enums/objects by code this task must not touch — src/main/brain/context.ts
 * (buildBrainContext), src/shared/mars.ts, and src/renderer/src/components/BrainView.tsx all do direct
 * property access (e.g. `deal.velocity.signal`, `BAND_META[deal.win_likelihood_band]`, `[p.role,
 * p.account].join(...)`) and, for the renderer, render the value as a JSX child. Replacing those fields
 * with `ProvenantField<T>` in place would break the TypeScript build (direct sub-property access like
 * `.velocity.signal` has no equivalent on the wrapper) and crash the renderer at runtime (a ProvenantField
 * object is not a valid React child). Keeping the plain field authoritative for those readers, mirrored
 * from the provenance sidecar's `.value` on every merge, satisfies every one of those call sites
 * unmodified while still giving the merge/lint/correction-engine layers full per-field history.
 */
export const ProvenanceStateSchema = z.enum(['extracted', 'verified', 'edited', 'pinned'])
export type ProvenanceState = z.infer<typeof ProvenanceStateSchema>

export function provenantFieldSchema<V extends z.ZodTypeAny>(valueSchema: V) {
  return z.object({
    value: valueSchema,
    source_file: z.string().default(''),
    date: z.string().default(''),
    quote: z.string().optional(),
    confidence: ConfidenceSchema.default('EXTRACTED'),
    state: ProvenanceStateSchema.default('extracted'),
    superseded: z
      .array(z.object({ value: valueSchema, date: z.string(), source_file: z.string() }))
      .max(10)
      .default([])
  })
}
/** Hand-written mirror of `z.infer<ReturnType<typeof provenantFieldSchema<...>>>` — kept as a plain
 *  interface (rather than derived via a generic zod call) so merge code in ingest.ts can name the shape
 *  directly regardless of which concrete value type T is. */
export interface ProvenantField<T> {
  value: T
  source_file: string
  date: string
  quote?: string
  confidence: Confidence
  state: ProvenanceState
  superseded: Array<{ value: T; date: string; source_file: string }>
}

export const PersonEntitySchema = z.object({
  schema_version: z.number().default(BRAIN_SCHEMA_VERSION),
  // The slug this entity is filed under — immutable (rename machinery is a later task). The join key
  // everywhere; `name` stays a plain, mutable display string.
  id: z.string().default(''),
  aliases: z.array(z.string()).default([]),
  name: z.string(),
  role: z.string().nullable().default(null),
  account: z.string().nullable().default(null),
  role_provenance: provenantFieldSchema(z.string()).optional(),
  // Provenance for `account` above — named "org" in the MI-1 plan (the person's organizational
  // affiliation), kept as `org_provenance` so its meaning is clear without renaming the plain field.
  org_provenance: provenantFieldSchema(z.string()).optional(),
  meetings: z.array(MeetingRefSchema).default([]),
  quotes: z.array(z.object({ quote: z.string(), meeting: z.string() })).default([]),
  stance_trail: z.array(z.object({ meeting: z.string(), kind: z.string(), statement: z.string() })).default([]),
  commitments: z.array(LedgerCommitmentSchema).default([])
})
export type PersonEntity = z.infer<typeof PersonEntitySchema>

export const AccountEntitySchema = z.object({
  schema_version: z.number().default(BRAIN_SCHEMA_VERSION),
  id: z.string().default(''),
  aliases: z.array(z.string()).default([]),
  name: z.string(),
  sector: SectorSchema.default('other'),
  sector_confidence: ConfidenceSchema.default('INFERRED'),
  sector_provenance: provenantFieldSchema(SectorSchema).optional(),
  strategic: z.boolean().default(false),
  people: z.array(z.string()).default([]),
  deals: z.array(z.string()).default([]),
  meetings: z.array(MeetingRefSchema).default([]),
  win_reasons: z.array(z.object({ statement: z.string(), quote: z.string().default(''), meeting: z.string() })).default([]),
  loss_reasons: z.array(z.object({ statement: z.string(), quote: z.string().default(''), meeting: z.string() })).default([])
})
export type AccountEntity = z.infer<typeof AccountEntitySchema>

/** DealEntity.amount's value shape — schema only in this task (B1); nothing populates it yet. */
export const AmountValueSchema = z.object({ value: z.number(), currency: z.string() })

export const DealEntitySchema = z.object({
  schema_version: z.number().default(BRAIN_SCHEMA_VERSION),
  id: z.string().default(''),
  aliases: z.array(z.string()).default([]),
  name: z.string(),
  account: z.string().default(''),
  stage: z.string().default(''),
  stage_provenance: provenantFieldSchema(z.string()).optional(),
  // Outcome is only ever set by an explicit human action (or future CRM sync) — never by the LLM.
  outcome: z.enum(['open', 'won', 'lost']).default('open'),
  win_likelihood_band: BandSchema.nullable().default(null),
  band_evidence: z.string().default(''),
  win_likelihood_band_provenance: provenantFieldSchema(BandSchema.nullable()).optional(),
  velocity: VelocitySchema.default({ signal: 'no-hard-date-found', evidence: '' }),
  velocity_provenance: provenantFieldSchema(VelocitySchema).optional(),
  // Schema only in this task (B1) — a later task wires extraction/population.
  amount: provenantFieldSchema(AmountValueSchema).optional(),
  close_date: provenantFieldSchema(z.string()).optional(),
  meetings: z.array(MeetingRefSchema).default([]),
  signals: z.array(MeetingSignalSchema.extend({ meeting: z.string() })).default([]),
  missed_signals: z
    .array(
      z.object({
        statement: z.string(),
        why_it_matters: z.string().default(''),
        quote: z.string().default(''),
        confidence: ConfidenceSchema.default('INFERRED'),
        meeting: z.string()
      })
    )
    .default([]),
  commitments: z.array(LedgerCommitmentSchema).default([]),
  feedback: z
    .array(
      z.object({
        note: z.string(),
        quote: z.string().default(''),
        confidence: ConfidenceSchema.default('INFERRED'),
        meeting: z.string()
      })
    )
    .default([])
})
export type DealEntity = z.infer<typeof DealEntitySchema>

export const GraphNodeSchema = z.object({
  id: z.string(), // "<type>:<slug>"
  type: z.enum(['account', 'person', 'deal', 'sector', 'meeting']),
  label: z.string()
})
export const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  rel: z.string(), // works-at | discussed-in | belongs-to | in-sector | attends
  confidence: ConfidenceSchema.default('EXTRACTED')
})
export const BrainGraphSchema = z.object({
  nodes: z.array(GraphNodeSchema).default([]),
  edges: z.array(GraphEdgeSchema).default([])
})
export type BrainGraph = z.infer<typeof BrainGraphSchema>

export const BrainIndexSchema = z.object({
  schema_version: z.number().default(BRAIN_SCHEMA_VERSION),
  // Ingest log keyed by source file basename — makes rebuilds/backfills resumable and idempotent.
  ingested: z.record(z.string(), z.object({ at: z.number(), ok: z.boolean(), error: z.string().optional() })).default({}),
  // Lint findings (contradictions/staleness). Surfaced in the dashboard; never auto-resolved.
  warnings: z.array(z.string()).default([]),
  // True from "user asked for a backfill" until the queue fully drains — lets a quit/relaunch resume
  // the remaining transcripts automatically instead of stalling until someone re-clicks the button.
  backfillRequested: z.boolean().default(false)
})
export type BrainIndex = z.infer<typeof BrainIndexSchema>

/** Full assembled dataset returned by IPC brain:read — everything the Intelligence dashboard renders. */
export interface BrainRead {
  index: BrainIndex
  graph: BrainGraph
  people: PersonEntity[]
  accounts: AccountEntity[]
  deals: DealEntity[]
  /** Per-meeting extractions (title/sentiment/topics + ingest-stamped source_file/date) — feeds
   *  call-grade timelines and meeting feeds without the dashboard re-deriving them from entity refs. */
  meetings: MeetingExtraction[]
}

/** Renderer/dashboard-facing status summary. */
export interface BrainStatus {
  meetings: number
  people: number
  accounts: number
  deals: number
  nodes: number
  edges: number
  warnings: number
  backfill?: { total: number; done: number; running: boolean }
}

/**
 * The extraction prompt (schema layer). Grounding rules mirror the app's existing discipline: cite or
 * stay silent, "null/empty" is a valid answer, absolutely no invented names, dates, or quotes.
 */
export const BRAIN_EXTRACTION_PROMPT = `You are the ingestion step of a meeting knowledge base. Read the meeting transcript and return ONLY a single JSON object (no markdown fences, no commentary) with exactly these fields:

{
  "title24": "2-4 words naming what was discussed",
  "topics": ["3-5 short topic tags"],
  "sentiment": "good" | "mixed" | "concerning",
  "account": {"name": "...", "sector": "retail|banking|insurance|pharma|healthcare|automotive|energy|telecom|technology|public-sector|manufacturing|logistics|media|aerospace-defense|consumer-goods|professional-services|other", "sector_confidence": "EXTRACTED|INFERRED|AMBIGUOUS", "confidence": "EXTRACTED|INFERRED|AMBIGUOUS"} or null,
  "people": [{"name": "...", "role": "..." or null, "org": "..." or null, "confidence": "EXTRACTED|INFERRED|AMBIGUOUS"}],
  "deal": {"name": "...", "stage": "...", "win_likelihood_band": "good|mixed|concerning" or null, "band_evidence": "...", "velocity": {"signal": "hard-calendar-gate|soft-organizational-gate|no-hard-date-found", "evidence": "..."}} or null,
  "signals": [{"kind": "positive|objection|neutral", "statement": "...", "quote": "verbatim transcript line or empty string", "confidence": "EXTRACTED|INFERRED|AMBIGUOUS"}],
  "missed_signals": [{"statement": "an opening or risk the seller did not pursue", "why_it_matters": "...", "quote": "the verbatim moment showing the missed opening, or empty string", "confidence": "EXTRACTED|INFERRED|AMBIGUOUS"}],
  "commitments": [{"text": "what was promised, as a short actionable sentence", "by": "you" | "them" | "Person Name", "due_hint": "verbatim timing words ('by Friday', 'after the board') or empty string", "quote": "verbatim transcript line or empty string", "confidence": "EXTRACTED|INFERRED|AMBIGUOUS"}],
  "feedback": [{"note": "one short coaching note grounded in this call", "quote": "the verbatim moment the note is anchored to, or empty string", "confidence": "EXTRACTED|INFERRED|AMBIGUOUS"}]
}

Hard rules:
- Ground everything in the transcript. A "quote" must be a verbatim line from it; if you cannot quote, use "" and mark the item INFERRED.
- null / empty arrays are correct answers when the transcript doesn't support more. NEVER invent names, companies, dates, or numbers.
- Only name an account/deal when the transcript makes it reasonably clear; personal or internal chats get account=null, deal=null.
- sector is your best classification of the ACCOUNT's industry (e.g. L'Oréal → retail/consumer-goods, a bank → banking); tag it INFERRED unless the sector is stated outright.
- win_likelihood_band is a qualitative judgement with band_evidence citing why — never output probabilities.
- velocity: "hard-calendar-gate" only for a concrete date/meeting commitment (quote it); vague intent is "soft-organizational-gate"; otherwise "no-hard-date-found".
- commitments: only promises actually SPOKEN and owned ("I'll send the deck", "we'll intro you to Claire", "you'll have the numbers Friday"). "you" = the app's user, "them" = the other side generically, a name when the speaker is clear. Aspirations ("we should...") and process talk are NOT commitments. Quote the line whenever possible.
- A "## Debrief (off the record)" section, when present, is the user's own post-meeting gut-read (what was NOT said aloud). Use it for signals, missed_signals, and sentiment — always tagged INFERRED, never quoted as if spoken, and never a source of commitments.
- feedback / missed_signals confidence: EXTRACTED only when you can quote the exact moment; a judgement without a quotable anchor is INFERRED; a stretch is AMBIGUOUS. Differentiate honestly — do not tag everything the same.
- Keep every string concise. Reply with the JSON object only.`

const ELIGIBLE_SOURCE_MODES = new Set([
  'general',
  'meeting',
  'sales',
  'negotiation',
  'presentation',
  'support'
])

/** Classifies configured built-in modes only. Transcript content never affects this result. */
export function classifyMeetingSourceUse(mode: string): SourceUse {
  if (mode === 'interview') return 'employment'
  if (ELIGIBLE_SOURCE_MODES.has(mode)) return 'eligible'
  return 'unknown'
}
