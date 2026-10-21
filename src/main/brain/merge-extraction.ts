import type { Settings } from '@shared/ipc'
import {
  BRAIN_SCHEMA_VERSION,
  type MeetingExtraction,
  type MeetingRef,
  type Confidence,
  type ProvenanceState,
  type ProvenantField,
  type EntityKind
} from '@shared/brain'
import {
  slugify,
  commitmentKey,
  pushUnique,
  pushSuperseded,
  outranks,
  eqStrict,
  eqVelocity,
  eqAmount,
  readGraph,
  writeGraph,
  readPerson,
  writePerson,
  readAccount,
  writeAccount,
  readDeal,
  writeDeal,
  cloneEntity
} from './store'
import { resolveEntitySlug } from './corrections'
import { verifyBandEvidence, verifyDealAmount, verifyDealCloseDate } from './extraction-normalization'

/** The user's own ledger (MQA-244). Deliberately one of the role labels extraction filters out, so it can never
 *  mint a competing person entity with this slug — those names are filtered out before they reach the
 *  merge. Commitments no other ledger claimed land here. */
export const SELF_PERSON_SLUG = 'you'
export const SELF_PERSON_NAME = 'You'

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
        {
          value: incoming.value,
          date: incoming.date,
          source_file: incoming.source_file,
          confidence: incoming.confidence
        },
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
      {
        value: incoming.value,
        date: incoming.date,
        source_file: incoming.source_file,
        confidence: incoming.confidence
      },
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
  // Every read below clones before it mutates (see cloneEntity): readJson hands back the cached instance
  // for an unchanged file, so mutating it in place would leave the cache serving this meeting's facts to
  // every other reader even when one of the awaited writes here fails and the merge aborts unpersisted.
  const graph = cloneEntity(readGraph(s))
  const addNode = (id: string, type: 'account' | 'person' | 'deal' | 'sector' | 'meeting', label: string): void =>
    pushUnique(graph.nodes, { id, type, label }, (n) => n.id)
  const addEdge = (
    from: string,
    to: string,
    rel: string,
    confidence: MeetingExtraction['people'][number]['confidence']
  ): void => pushUnique(graph.edges, { from, to, rel, confidence }, (e) => `${e.from}|${e.to}|${e.rel}`)

  const meetingId = `meeting:${slugify(ref.file)}`
  addNode(meetingId, 'meeting', ref.title || ref.file)

  const accountSlug = x.account && x.account.name.trim() ? resolveEntitySlug(aliasMap, 'account', x.account.name) : null
  if (x.account && accountSlug) {
    const acc = cloneEntity(readAccount(s, accountSlug)) ?? {
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
      if (bucket)
        pushUnique(
          bucket,
          { statement: sig.statement, quote: sig.quote, meeting: ref.file },
          (r) => r.statement + r.meeting
        )
    }
    addNode(`account:${accountSlug}`, 'account', acc.name)
    addNode(`sector:${acc.sector}`, 'sector', acc.sector)
    addEdge(`account:${accountSlug}`, `sector:${acc.sector}`, 'in-sector', x.account.sector_confidence)
    addEdge(`account:${accountSlug}`, meetingId, 'discussed-in', x.account.confidence)
    await writeAccount(s, accountSlug, acc)
  }

  // MQA-244: every commitment must reach a ledger that is actually rendered, or it is silently lost.
  // Keys of the ones that did — the person loop matches on `by` == a person's name, the deal branch
  // takes all of them, and whatever neither claimed is routed to the user's own ledger below.
  const routedCommitments = new Set<string>()

  for (const p of x.people) {
    if (!p.name.trim()) continue
    const pslug = resolveEntitySlug(aliasMap, 'person', p.name)
    const person = cloneEntity(readPerson(s, pslug)) ?? {
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
      if (sig.quote)
        pushUnique(
          person.stance_trail,
          { meeting: ref.file, kind: sig.kind, statement: sig.statement },
          (t) => t.meeting + t.statement
        )
    }
    // Commitments spoken BY this person (matched by name) join their personal ledger — over time this
    // yields a kept-promise read per counterpart, a signal no transcript-only tool can compute.
    // A commitment routed here stays 'open' until a later meeting settles it (settleCommitment is
    // deal-keyed, so in a deal-less meeting that only happens once a deal appears) — a real limitation,
    // but the row EXISTS and is rendered, which is the part that matters.
    person.commitments ??= []
    for (const c of x.commitments) {
      if (c.by.toLowerCase() === p.name.toLowerCase()) {
        routedCommitments.add(commitmentKey(c.text))
        pushUnique(person.commitments, { ...c, meeting: ref.file, date: ref.date, status: 'open' as const }, (t) =>
          commitmentKey(t.text)
        )
      }
    }
    addNode(`person:${pslug}`, 'person', p.name)
    addEdge(`person:${pslug}`, meetingId, 'attends', p.confidence)
    if (accountSlug) {
      addEdge(`person:${pslug}`, `account:${accountSlug}`, 'works-at', p.org ? 'EXTRACTED' : 'INFERRED')
      const acc = cloneEntity(readAccount(s, accountSlug))
      if (acc) {
        pushUnique(acc.people, p.name, (n) => n)
        await writeAccount(s, accountSlug, acc)
      }
    }
    await writePerson(s, pslug, person)
  }

  if (x.deal && (x.deal.name || accountSlug)) {
    const dslug = resolveEntitySlug(aliasMap, 'deal', x.deal.name || `${x.account?.name ?? 'unknown'} deal`)
    const deal = cloneEntity(readDeal(s, dslug)) ?? {
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
        preparedText === undefined
          ? 'EXTRACTED'
          : verifyBandEvidence(x.deal.band_evidence, preparedText)
            ? 'EXTRACTED'
            : 'AMBIGUOUS'
      deal.win_likelihood_band_provenance = mergeProvenant(
        deal.win_likelihood_band_provenance,
        {
          value: x.deal.win_likelihood_band,
          source_file: ref.file,
          date: ref.date,
          quote: x.deal.band_evidence,
          confidence: bandConfidence
        },
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
    for (const ms of x.missed_signals)
      pushUnique(deal.missed_signals, { ...ms, meeting: ref.file }, (t) => t.meeting + t.statement)
    // Commitment Ledger: promises spoken in this meeting join the deal's ledger as open obligations.
    // Status stays 'open' until later evidence or a human marks it — the merge never guesses.
    for (const c of x.commitments) {
      routedCommitments.add(commitmentKey(c.text))
      pushUnique(deal.commitments, { ...c, meeting: ref.file, date: ref.date, status: 'open' as const }, (t) =>
        commitmentKey(t.text)
      )
    }
    for (const f of x.feedback) pushUnique(deal.feedback, { ...f, meeting: ref.file }, (t) => t.meeting + t.note)
    addNode(`deal:${dslug}`, 'deal', deal.name)
    addEdge(`deal:${dslug}`, meetingId, 'discussed-in', 'EXTRACTED')
    if (accountSlug) {
      addEdge(`deal:${dslug}`, `account:${accountSlug}`, 'belongs-to', x.account!.confidence)
      const acc = cloneEntity(readAccount(s, accountSlug))
      if (acc) {
        pushUnique(acc.deals, deal.name, (n) => n)
        await writeAccount(s, accountSlug, acc)
      }
    }
    await writeDeal(s, dslug, deal)
  }

  // MQA-244: the commitments no ledger claimed.
  //
  // `by` is one of "you" | "them" | a person's name (src/shared/brain.ts's extraction contract), and
  // Métis's own transcription labels speakers exactly that way — so "you"/"them" is the COMMON case,
  // not an edge one. Those labels are stripped from people[] on the way in (MQA-116: they were becoming
  // fake person entities flagged as "linked to multiple accounts"), which left the person loop above
  // with nothing to match `by` against. The deal branch takes every commitment, so a meeting attached to
  // a deal was fine and this went unnoticed. A meeting with no deal — an internal sync, a 1:1, a
  // standup — had neither route, and every promise spoken in it was dropped with the ingest still
  // reporting success. An empty next-steps list was indistinguishable from a meeting with no actions.
  //
  // They are routed to the user's own ledger rather than guessed onto a participant. That is not a
  // fallback bucket, it is the correct owner: "I'll send the deck by Tuesday" is the user's to do, and
  // "they'll come back with numbers" is the user's to chase. `by` is preserved verbatim on the row, so
  // the rendered page still says who promised. No guessing — which is the same rule the deal merge
  // above states for itself.
  const unrouted = x.commitments.filter((c) => !routedCommitments.has(commitmentKey(c.text)))
  if (unrouted.length) {
    const self = cloneEntity(readPerson(s, SELF_PERSON_SLUG)) ?? {
      schema_version: BRAIN_SCHEMA_VERSION,
      id: SELF_PERSON_SLUG,
      aliases: [],
      name: SELF_PERSON_NAME,
      role: null,
      account: null,
      meetings: [],
      quotes: [],
      stance_trail: [],
      commitments: []
    }
    pushUnique(self.meetings, ref, (m) => m.file)
    self.commitments ??= []
    for (const c of unrouted) {
      pushUnique(self.commitments, { ...c, meeting: ref.file, date: ref.date, status: 'open' as const }, (t) =>
        commitmentKey(t.text)
      )
    }
    await writePerson(s, SELF_PERSON_SLUG, self)
    addNode(`person:${SELF_PERSON_SLUG}`, 'person', SELF_PERSON_NAME)
    addEdge(`person:${SELF_PERSON_SLUG}`, meetingId, 'attends', 'EXTRACTED')
  }

  await writeGraph(s, graph)
}
