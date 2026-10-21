/**
 * brain-ipc.ts — the Mantu Intelligence brain IPC surface (status, backfill, rebuild, preserved
 * indexes, and the human-correction write channels).
 *
 * Moved verbatim from the main entry point: every handler keeps its channel, sender gate, auth gate,
 * validation, audit event and return shape. Reads that the Mantu Intelligence window may also call use
 * assertBrainReader; every privileged write stays main-window-only through assertMainWindow.
 */
import { basename } from 'node:path'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, MessageBoxOptions } from 'electron'
import {
  IPC,
  SetDealOutcomePayloadSchema,
  EntityRenamePayloadSchema,
  EntityMergePayloadSchema,
  EntityUnmergePayloadSchema,
  EntityUpdateFieldPayloadSchema,
  FieldDecisionPayloadSchema,
  CommitmentRejectPayloadSchema,
  MeetingExtractionQuerySchema,
  appendAsrCorrection
} from '@shared/ipc'
import { getSettings, setSettings } from '../store'
import { mainLog, auditLog } from '../logger'
import {
  markBrainChanged,
  requestBackfill,
  brainBackfillProgress,
  brainLiveIngestProgress,
  ingestFailureCounts,
  ingestFailureDetails,
  isPendingIngestRecord,
  settleCommitment,
  startRebuild
} from '../brain/ingest'
import { startIntelligencePass } from '../brain/intelligence-pass'
import {
  renameEntity,
  mergeEntities,
  unmergeEntities,
  updateEntityField,
  readFieldProvenance,
  rejectCommitment,
  isJournalCorruptionBlockedAsync,
  clearJournalCorruptionLock,
  readCorrectionsJournal,
  readAliasMap,
  resolveEntitySlug
} from '../brain/corrections'
import { publishEntity, removeFromWiki } from '../brain/publish'
import { computeAttention } from '../brain/attention'
import { openIntelligenceWindow } from '../intelligence'
import {
  loadIndexForStatus as loadBrainIndexForStatus,
  indexUnavailableAsync,
  indexUnavailableMessage,
  readPerson as readBrainPerson,
  readAccount as readBrainAccount,
  readDeal as readBrainDeal,
  loadEntityDisplayNames as loadBrainEntityDisplayNames,
  loadMeetingExtraction as loadBrainMeetingExtraction,
  listPreservedBrainIndexes,
  currentBrainIndexIsReadable,
  restorePreservedBrainIndex,
  deletePreservedBrainIndex,
  setDealOutcome,
  slugify as brainSlugify
} from '../brain/store'
import { brainStatusCounts, readBrainDashboard } from '../brain/dashboard-read'
import {
  runIntelligenceIndex,
  lastIndexedAtAsync,
  intelligenceIndexStatusAsync,
  SIGN_IN_INDEX_COPY
} from '../brain/intelligence-index'

export interface BrainIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Main-window top frame only. */
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  /** Main window, or the Mantu Intelligence window's top frame. */
  assertBrainReader: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  getWindow: () => BrowserWindow | null
  /** Native confirm dialog, attached to the overlay window when it exists. */
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>
  /** Height cap for the avoid-rectangle handed to the dashboard window (the idle bar, never the live one). */
  barCollapsedMaxHeight: number
}

export function registerBrainIpc(deps: BrainIpcDependencies): void {
  const { ipcMain, assertMainWindow, assertBrainReader, requireAuth, showMessageBox } = deps
  const BAR_COLLAPSED_MAX_HEIGHT = deps.barCollapsedMaxHeight
  // --- Mantu Intelligence brain (see src/main/brain/) ---
  ipcMain.handle(IPC.brainOpenDashboard, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    // Hand the overlay's live bounds over so the dashboard opens clear of it. The bar is always-on-top,
    // so anywhere the two intersect the dashboard is the one that gets covered (measured: the bar hid its
    // top 23px across the full width). Undefined when the overlay is gone — placement then just centres.
    // Height is capped deliberately, NOT taken live. The renderer collapses the panel only
    // after this IPC resolves (RecallView/BrainView call onDashboardOpen in the .then), so sampling the
    // live bounds here measured the still-EXPANDED bar — up to ~992px tall — and placed the dashboard
    // below that, i.e. off the bottom of the screen. Placing against the idle rectangle the bar is about
    // to return to is deterministic and does not depend on a React render landing first.
    const win = deps.getWindow()
    const avoid =
      win && !win.isDestroyed() && win.isVisible()
        ? (() => {
            const b = win.getBounds()
            return { ...b, height: Math.min(b.height, BAR_COLLAPSED_MAX_HEIGHT) }
          })()
        : undefined
    const result = openIntelligenceWindow(avoid)
    // Opening the full dashboard is an explicit request for current meeting knowledge. Kick off one
    // backlog pass for saved transcripts that predate the brain; new saves already call enqueueIngest.
    // This is deliberately fire-and-forget so a slow OneDrive listing never delays the window itself.
    void (async () => {
      try {
        // Source versions, not only a count of successful filenames, decide whether Intelligence is
        // current. requestBackfill detects changed/deleted sources and schedules the clean rebuild.
        const r = await requestBackfill()
        auditLog('brain.backfill.start', { queued: r.queued, deferred: r.deferred, automatic: true })
      } catch (err) {
        mainLog.warn('[brain] automatic dashboard backfill check failed:', err)
      }
    })()
    return result
  })
  ipcMain.handle(IPC.brainStatus, async (e) => {
    assertBrainReader(e)
    if (!requireAuth()) {
      return {
        meetings: 0,
        ingestedFiles: [],
        people: 0,
        accounts: 0,
        deals: 0,
        nodes: 0,
        edges: 0,
        warnings: 0,
        revision: 0,
        error: 'Sign in with your Mantu account first.'
      }
    }
    const s = getSettings()
    const idx = await loadBrainIndexForStatus(s)
    // M2-0003: non-null while an existing index.json exists but cannot be used on this device — idx
    // above is then only the empty stand-in, so this must be read before deciding what "no data" means.
    const unavailable = await indexUnavailableAsync(s)
    const counts = await brainStatusCounts(s, idx.revision)
    // T6 6c: durable failure counts read straight from the index — unlike backfill.failed below (an
    // ephemeral per-run counter), these stay visible for as long as a source has ok:false, independent
    // of whether a backfill run happens to be active right now.
    const failure = ingestFailureCounts(idx)
    // Per-file error text for the same failing sources, bounded to 20 — powers the failed-row tooltip
    // (RecallView) and the expandable failure detail (BrainView) without shipping the whole ledger.
    const failureDetails = ingestFailureDetails(idx)
    return {
      meetings: Object.values(idx.ingested).filter((v) => v.ok).length,
      ingestedFiles: Object.entries(idx.ingested)
        .filter(([, v]) => v.ok)
        .map(([file]) => file),
      // 6d: failing-source filenames, the failed-side counterpart to ingestedFiles above — lets a
      // per-meeting indicator (indexed/pending/failed) be derived without a second, heavier IPC call.
      // Pending (deferred for consolidation) is NOT a failure — same discriminator ingestFailureCounts
      // already uses. Listing pending here painted every just-saved meeting as a red "failed" History dot.
      failedFiles: Object.entries(idx.ingested)
        .filter(([, v]) => !v.ok && !isPendingIngestRecord(v))
        .map(([file]) => file),
      ...(failureDetails.length ? { failedDetails: failureDetails } : {}),
      backfillRequested: idx.backfillRequested,
      ...counts,
      warnings: idx.warnings.length,
      revision: idx.revision,
      backfill: brainBackfillProgress(),
      live: brainLiveIngestProgress(),
      failed: failure.failed,
      exhausted: failure.exhausted,
      ...(failure.topError ? { topError: failure.topError } : {}),
      // MI-2.5 review round 3: computed fresh from the on-disk sentinel each poll — lets BrainView offer
      // the in-app "Reset corrections lock" recovery instead of a hand-deleted hidden .brain file.
      corruptionBlocked: await isJournalCorruptionBlockedAsync(s),
      // MQA-230: entity files can still hold items attributed to an already-deleted meeting until the
      // deferred source refresh runs (it needs a usable provider). Surfaced so the UI can say the
      // cleanup is pending instead of silently claiming the delete was complete.
      cleanupPending: idx.sourceRefreshRequested === true,
      lastIndexedAt: await lastIndexedAtAsync(s),
      intelligenceIndex: await intelligenceIndexStatusAsync(s),
      // M2-0003: surfaces the degraded read-only state instead of silently reporting an empty brain.
      ...(unavailable ? { indexUnavailable: unavailable, error: indexUnavailableMessage(unavailable) } : {})
    }
  })
  ipcMain.handle(IPC.brainBackfill, async (e) => {
    assertBrainReader(e)
    if (!requireAuth()) return { ran: false, queued: 0, error: SIGN_IN_INDEX_COPY }
    const r = await runIntelligenceIndex('click')
    auditLog('brain.backfill.start', { queued: r.queued, recapped: r.recapped, reason: 'click' })
    return r
  })
  // Update Intelligence: explicit click only. Local first, configured API once. Never auto-send.
  ipcMain.handle(IPC.brainIntelligencePass, (e) => {
    assertBrainReader(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    return startIntelligencePass()
  })
  // Full rebuild: wipe the DERIVED store (entities/graph/extractions — never the source transcripts)
  // and re-extract everything with the current schema/prompt. This is the upgrade path for legacy
  // extractions (e.g. untagged feedback that rendered as a flat confidence wall in the dashboard).
  ipcMain.handle(IPC.brainRebuildAll, async (e) => {
    // Privileged write (purges the derived brain store) — main-window only, like brainCommitmentSettle,
    // never the Mantu Intelligence window's assertBrainReader (used by its read channels and narrow,
    // guarded backfill request only).
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    // The full orchestration lives in ingest.ts's startRebuild (unit-testable, keeps this handler thin):
    //  - preserveCorrections purge whose result is CHECKED (MI-2.5 Fix F — abort on a partial wipe);
    //  - a corrupt/blocked-journal guard (MI-2.5 review Fix 2 — refuse rather than rebuild atop a store
    //    onto which zero corrections could be replayed, which would silently revert every human fix);
    //  - the replayPending flag (Fix E) + the onDrained replay that clears it only on a clean replay.
    const r = await startRebuild(getSettings(), { trigger: 'user' })
    if (r.error) {
      auditLog('brain.rebuild.aborted', {})
      return r
    }
    auditLog('brain.backfill.start', { queued: r.queued, rebuild: true })
    return r
  })
  ipcMain.handle(IPC.brainPreservedIndexesList, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { copies: [] }
    return { copies: listPreservedBrainIndexes(getSettings()) }
  })
  ipcMain.handle(IPC.brainPreservedIndexRestore, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const id = String((raw as { id?: unknown } | null)?.id ?? '')
    if (!id) return { ok: false, error: 'Missing preserved copy.' }
    let allowReplaceReadable = false
    if (currentBrainIndexIsReadable(getSettings())) {
      const dialogOpts = {
        type: 'warning' as const,
        title: 'Restore preserved brain index',
        message: 'Replace the current Mantu Intelligence index?',
        detail:
          'Métis will verify the preserved copy can be decrypted, keep the current index as a preserved copy, then restore the selected index.',
        buttons: ['Restore', 'Cancel'],
        defaultId: 1,
        cancelId: 1
      }
      const { response } = await showMessageBox(dialogOpts)
      if (response !== 0) return { ok: false, error: 'cancelled' }
      allowReplaceReadable = true
    }
    const r = restorePreservedBrainIndex(getSettings(), id, { allowReplaceReadable })
    auditLog('brain.index.preserved_restore', { ok: r.ok, error: r.error })
    return r.ok ? { ok: true } : { ok: false, error: r.error || 'Restore failed.' }
  })
  ipcMain.handle(IPC.brainPreservedIndexDelete, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const id = String((raw as { id?: unknown } | null)?.id ?? '')
    if (!id) return { ok: false, error: 'Missing preserved copy.' }
    const dialogOpts = {
      type: 'warning' as const,
      title: 'Delete preserved brain index',
      message: 'Delete this preserved Mantu Intelligence index copy?',
      detail: 'This removes only the selected preserved copy. Saved meetings and the current index are not changed.',
      buttons: ['Delete copy', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = await showMessageBox(dialogOpts)
    if (response !== 0) return { ok: false, error: 'cancelled' }
    const r = deletePreservedBrainIndex(getSettings(), id)
    auditLog('brain.index.preserved_delete', { ok: r.ok, error: r.error })
    return r.ok ? { ok: true } : { ok: false, error: r.error || 'Delete failed.' }
  })
  // MI-2.5 review round 3: user-invoked recovery from a durable correction-journal corruption lock —
  // clears the sentinel so corrections resume (the quarantined corrections.corrupt-*.json copy is left
  // for inspection). Privileged (mutates correction-engine state) — main-window only + requireAuth, same
  // guards as brainSetDealOutcome. Takes no payload, so there is nothing to zod-validate beyond the guards.
  ipcMain.handle(IPC.brainClearJournalCorruption, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const cleared = clearJournalCorruptionLock(getSettings())
    auditLog('brain.corrections.lock_cleared', { cleared })
    return { ok: true, cleared }
  })
  // Full assembled dataset for the Mantu Intelligence dashboard (decrypted in main when needed).
  ipcMain.handle(IPC.brainRead, async (e) => {
    assertBrainReader(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    return readBrainDashboard(getSettings())
  })
  // Canonical people/account NAMES ONLY (never quotes, roles, deals, or any other entity field) — feeds
  // the renderer's ASR entity-casing bias (lib/entity-casing.ts) so a live transcript can spell a known
  // name correctly. Read-only, best-effort: an unsigned-in/empty brain just yields no names, never throws,
  // since this runs opportunistically (mount + after a meeting saves), not in response to a user action.
  ipcMain.handle(IPC.brainEntityNames, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { names: [] }
    return loadBrainEntityDisplayNames(getSettings())
  })
  // Deal outcome — the human closes the loop the LLM never may (see DealEntitySchema.outcome). Main-window
  // only: it's a brain WRITE, like brainCommitmentSettle. Same slug convention too: the renderer sends the
  // deal's display name in `dealSlug`, resolved to the entity's stable id here before it reaches the store
  // — through the alias map, not slugify, or a renamed deal could never be closed (MQA-013).
  ipcMain.handle(IPC.brainSetDealOutcome, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = SetDealOutcomePayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    const s = getSettings()
    const updated = await setDealOutcome(
      s,
      resolveEntitySlug(readAliasMap(s), 'deal', parsed.data.dealSlug),
      parsed.data.outcome
    )
    if (!updated) return { ok: false, error: 'Deal not found.' }
    await markBrainChanged(getSettings())
    auditLog('brain.deal.outcome', { outcome: parsed.data.outcome })
    return { ok: true }
  })

  // Correction engine (Task MI-2): five human-correction channels, each cloned from
  // brain:setDealOutcome's pattern above — zod safeParse + main-window-only + requireAuth + audit. Every
  // mutation goes through src/main/brain/corrections.ts so brain:rebuildAll's journal replay (which
  // calls the exact same functions) can reproduce it deterministically — see corrections.ts's module
  // doc comment for the single-mutation-implementation invariant.
  ipcMain.handle(IPC.brainEntityRename, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = EntityRenamePayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid rename request.' }
    const { kind, id, newName, alsoFixAsr } = parsed.data
    // Captured BEFORE the rename so alsoFixAsr can pair the OLD display name with the new one.
    const oldName =
      kind === 'person'
        ? readBrainPerson(getSettings(), id)?.name
        : kind === 'account'
          ? readBrainAccount(getSettings(), id)?.name
          : readBrainDeal(getSettings(), id)?.name
    const r = await renameEntity(getSettings(), { kind, id, newName })
    if (!r.ok) return r
    await markBrainChanged(getSettings())
    await publishEntity(getSettings(), kind, id) // Task MI-5: keep the wiki page in sync with the live rename
    // alsoFixAsr composition lives here, not in corrections.ts (that module owns brain-entity
    // mutations only) — appends the {from, to} pair to settings.asrCorrections in the exact shape
    // commitLine's correctionsRef consumer expects (see lib/listen.ts), so the live transcript stops
    // mishearing the old name going forward. appendAsrCorrection validates the PAIR before it ever
    // reaches setSettings: store.ts's validKeysOnly drops the whole asrCorrections array when one
    // element fails validation (e.g. a name over the 80-char cap), which would silently wipe every
    // correction the user already had. A skipped pair never blocks the rename itself — the caller
    // gets { ok: true, asrSkipped: true, reason } and the skip is audit-logged.
    if (alsoFixAsr && oldName && oldName !== newName) {
      const composed = appendAsrCorrection(getSettings().asrCorrections, oldName, newName)
      if (composed.kind === 'append') {
        setSettings({ asrCorrections: composed.pairs })
        // MI-2.5 Fix H: a DISTINCT audit event, separate from brain.entity.renamed below — installing an
        // ASR rewrite rule silently changes how future spoken transcripts get transcribed, a
        // security-relevant setting mutation that must be visible in the trail on its own, not just
        // inferable from the rename. (The skipped-pair path already got its own distinct log below.)
        auditLog('brain.entity.asr_correction_added', { kind })
      }
      if (composed.kind === 'skipped') {
        auditLog('brain.entity.renamed', { kind, asrSkipped: true })
        return { ok: true, asrSkipped: true, reason: composed.reason }
      }
    }
    auditLog('brain.entity.renamed', { kind })
    return { ok: true }
  })
  ipcMain.handle(IPC.brainEntityMerge, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = EntityMergePayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid merge request.' }
    const r = await mergeEntities(getSettings(), parsed.data)
    if (r.ok) {
      await markBrainChanged(getSettings())
      auditLog('brain.entity.merged', { kind: parsed.data.kind })
      // Task MI-5: the survivor's page picks up the merged-in data; the source's stale page is removed.
      const s = getSettings()
      await publishEntity(s, parsed.data.kind, parsed.data.intoId)
      await removeFromWiki(s, parsed.data.kind, parsed.data.fromId)
    }
    return r
  })
  ipcMain.handle(IPC.brainEntityUnmerge, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = EntityUnmergePayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid request.' }
    const s = getSettings()
    // Task MI-5: unmergeEntities' payload is just {targetSeq} — read the journal (read-only, before the
    // mutation) for the kind/fromId/intoId this hook needs to know which wiki pages to republish once
    // both entities are restored. unmergeEntities re-derives the same entry internally to do the actual
    // restore; this is a second, harmless read of the same journal.
    const journalEntry = readCorrectionsJournal(s).find(
      (en) => en.kind === 'entity_merge' && en.seq === parsed.data.targetSeq
    )
    const r = await unmergeEntities(s, parsed.data)
    if (r.ok) {
      await markBrainChanged(s)
      auditLog('brain.entity.unmerged', {})
      if (journalEntry && journalEntry.kind === 'entity_merge') {
        await publishEntity(s, journalEntry.payload.kind, journalEntry.payload.fromId)
        await publishEntity(s, journalEntry.payload.kind, journalEntry.payload.intoId)
      }
    }
    return r
  })
  ipcMain.handle(IPC.brainEntityUpdateField, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = EntityUpdateFieldPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid field update.' }
    const r = await updateEntityField(getSettings(), parsed.data)
    if (r.ok) {
      await markBrainChanged(getSettings())
      auditLog('brain.entity.field_updated', { kind: parsed.data.kind, field: parsed.data.field })
      await publishEntity(getSettings(), parsed.data.kind, parsed.data.id)
    }
    return r
  })
  ipcMain.handle(IPC.brainCommitmentReject, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = CommitmentRejectPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid commitment.' }
    const r = await rejectCommitment(getSettings(), parsed.data)
    if (r.ok) {
      await markBrainChanged(getSettings())
      auditLog('brain.commitment.rejected', {})
    }
    return r
  })
  // Dashboard suggestion accept/dismiss (deferred CRM pattern 3) — the one privileged write the Mantu
  // Intelligence window gets (assertBrainReader, not assertMainWindow), because it's exactly as narrow as
  // brain:backfill already was: promote ONE already-`extracted` field the human just reviewed, nothing more.
  ipcMain.handle(IPC.brainFieldDecision, async (e, raw) => {
    assertBrainReader(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = FieldDecisionPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid request.' }
    const { entityKind, entityId, field, decision } = parsed.data
    if (decision === 'dismiss') {
      // No legal expression exists yet: updateEntityField only ever pins a NEW human value (always ->
      // state 'pinned') — there is no field_update variant that clears/reverts one, and some fields
      // (account.sector's enum, deal.amount's {value, currency}) have no null/empty value to revert to
      // even if there were. Refused honestly rather than silently no-opping.
      return { ok: false, error: 'Dismissing a suggestion is not supported yet.' }
    }
    const s = getSettings()
    const provenance = readFieldProvenance(s, { kind: entityKind, id: entityId, field })
    if (!provenance) return { ok: false, error: `"${field}" has no pending suggestion to accept.` }
    if (provenance.state !== 'extracted') return { ok: false, error: 'This field is not pending review.' }
    // "Accept" = the human confirms the extracted value is correct, so it's re-pinned UNCHANGED. This
    // moves it from 'extracted' (never renders as fact — see RENDERABLE_PROVENANCE_STATES) to 'pinned'
    // (does), the same outcome an in-place edit-then-save-with-no-changes would produce today — there is
    // no separate "verify without editing" mutation, so this is the correction engine's exact legal
    // expression of "accept".
    const r = await updateEntityField(s, { kind: entityKind, id: entityId, field, value: provenance.value })
    if (r.ok) {
      await markBrainChanged(s)
      auditLog('brain.entity.field_decision', { kind: entityKind, field, decision })
      await publishEntity(s, entityKind, entityId)
    }
    return r
  })

  // Task MI-3: two read-only channels feeding the CRM record pages, the Review.tsx entity strip, and the
  // needs-attention queue. Same guard pattern as the other brain reads — no audit event (nothing mutates).
  ipcMain.handle(IPC.brainMeetingExtraction, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return null
    const parsed = MeetingExtractionQuerySchema.safeParse(raw)
    if (!parsed.success) return null
    const extraction = await loadBrainMeetingExtraction(getSettings(), brainSlugify(basename(parsed.data.file)))
    if (!extraction) return null
    const { sourceDigest: _sourceDigest, sourceRootId: _sourceRootId, ...visible } = extraction
    return visible
  })
  ipcMain.handle(IPC.brainAttention, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { items: [] }
    return { items: computeAttention(getSettings()) }
  })

  // Commitment settlement — the human closes the loop the LLM never may (kept/broken are only ever
  // set here or by future CRM sync). Main-window only: it's a brain WRITE, unlike the read channels.
  ipcMain.handle(IPC.brainCommitmentSettle, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const p = raw as { deal?: unknown; text?: unknown; status?: unknown }
    const status = String(p?.status ?? '')
    if (!['open', 'kept', 'broken'].includes(status)) return { ok: false, error: 'Bad status.' }
    const deal = String(p?.deal ?? '')
    const text = String(p?.text ?? '')
    if (!deal || !text) return { ok: false, error: 'Missing commitment.' }
    // The renderer sends the deal's CURRENT display name, but a rename keeps the original id (see
    // applyRename: "`id` (the slug) never changes"), so slugifying the name here missed the file and every
    // promise on a renamed deal was permanently unsettleable. Resolve through the alias map exactly as
    // ingest does; it falls back to slugify(name) when there is no alias, so un-renamed deals are
    // unaffected (MQA-013).
    const s = getSettings()
    const r = await settleCommitment(
      s,
      resolveEntitySlug(readAliasMap(s), 'deal', deal),
      text,
      status as 'open' | 'kept' | 'broken'
    )
    if (r.ok) {
      await markBrainChanged(getSettings())
      auditLog('brain.commitment.settled', { status })
    }
    return r
  })
}
