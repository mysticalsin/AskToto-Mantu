import type { Settings } from '@shared/ipc'
import {
  cloneEntity,
  commitmentKey,
  listEntities,
  readDeal,
  readPerson,
  withEntityLock,
  writeDeal,
  writePerson
} from './store'
import { readAliasMap, resolveEntitySlug } from './corrections'
import { commitmentMarkKey, readHumanMarks, recordCommitmentMark } from './human-marks'

/**
 * Settle a commitment — the human closes the loop the LLM never may. Flips the matching row (by
 * normalized text) on the deal's ledger AND any person ledger holding the same promise, so the two
 * copies can't diverge. This is what makes the ledger a live count of what is actually owed, and
 * what makes a per-person kept-promise rate computable at all.
 *
 * MQA-085: runs on store.ts's withEntityLock — the one lane every read-modify-write of a `.brain/` entity
 * file must take (see its doc comment). This is a read-deal → mutate-row → write-deal round trip over the
 * same deal/person files an in-flight ingest job merges, and mergeExtraction awaits writeAccount between
 * ITS read and write of the deal: unlocked, a settle landing in that window is overwritten by the job's
 * older snapshot and the promise silently reappears in the rail. Never called from inside the lane
 * (its only callers are the IPC handler and tests), so there is no re-entrancy risk.
 */
export async function settleCommitment(
  s: Settings,
  dealSlug: string,
  text: string,
  status: 'open' | 'kept' | 'broken'
): Promise<{ ok: boolean; error?: string }> {
  return withEntityLock(async () => {
    const key = commitmentKey(text)
    const readDealFile = readDeal(s, dealSlug)
    if (!readDealFile) return { ok: false, error: 'Deal not found.' }
    if (!readDealFile.commitments.some((c) => commitmentKey(c.text) === key)) {
      return { ok: false, error: 'Commitment not found on this deal.' }
    }
    // D8-2: journal-first. The human mark is durable before any derived file changes, so a rebuild
    // that lands between the two writes still re-applies it (human-marks.ts).
    await recordCommitmentMark(s, dealSlug, key, status)
    // Clone before mutating — readJson hands back the cached object by reference (see cloneEntity).
    const deal = cloneEntity(readDealFile)
    for (const c of deal.commitments) if (commitmentKey(c.text) === key) c.status = status
    await writeDeal(s, dealSlug, deal)
    // Mirror onto the named person's own ledger when one holds the same promise.
    for (const pslug of listEntities(s, 'person')) {
      const readPersonFile = readPerson(s, pslug)
      if (!readPersonFile?.commitments?.some((c) => commitmentKey(c.text) === key)) continue
      const person = cloneEntity(readPersonFile)
      for (const c of person.commitments ?? []) if (commitmentKey(c.text) === key) c.status = status
      await writePerson(s, pslug, person)
    }
    return { ok: true }
  })
}

/**
 * Re-apply the human marks sidecar (human-marks.ts) after a rebuild's correction replay. Runs after
 * replayCorrections so a later merge or rename wins on identity: each mark's deal slug is resolved through
 * the current alias map, and a mark only lands on a deal or commitment that still exists. A commitment
 * the human rejected stays rejected. Idempotent: re-running changes nothing.
 */
export async function applyHumanMarks(s: Settings): Promise<{ applied: number }> {
  return withEntityLock(async () => {
    const marks = await readHumanMarks(s)
    const aliasMap = readAliasMap(s)
    let applied = 0
    for (const [slug, mark] of Object.entries(marks.dealOutcomes)) {
      const id = resolveEntitySlug(aliasMap, 'deal', slug)
      const read = readDeal(s, id)
      if (!read || read.outcome === mark.outcome) continue
      const deal = cloneEntity(read)
      deal.outcome = mark.outcome
      await writeDeal(s, id, deal)
      applied += 1
    }
    // The newest mark per promise text also mirrors onto person ledgers, as settleCommitment does.
    const newest = new Map<string, { status: 'open' | 'kept' | 'broken'; at: string }>()
    const byDeal = new Map<string, Map<string, 'open' | 'kept' | 'broken'>>()
    for (const [markKey, mark] of Object.entries(marks.commitmentStatus)) {
      if (!mark.dealSlug) continue
      const key = markKey.slice(commitmentMarkKey(mark.dealSlug, '').length)
      const id = resolveEntitySlug(aliasMap, 'deal', mark.dealSlug)
      const forDeal = byDeal.get(id) ?? new Map<string, 'open' | 'kept' | 'broken'>()
      forDeal.set(key, mark.status)
      byDeal.set(id, forDeal)
      const prior = newest.get(key)
      if (!prior || prior.at <= mark.at) newest.set(key, { status: mark.status, at: mark.at })
    }
    for (const [id, statuses] of byDeal) {
      const read = readDeal(s, id)
      if (!read) continue
      const deal = cloneEntity(read)
      let changed = false
      for (const c of deal.commitments) {
        const status = statuses.get(commitmentKey(c.text))
        if (status && c.status !== 'rejected' && c.status !== status) {
          c.status = status
          changed = true
          applied += 1
        }
      }
      if (changed) await writeDeal(s, id, deal)
    }
    if (newest.size === 0) return { applied }
    for (const pslug of listEntities(s, 'person')) {
      const read = readPerson(s, pslug)
      if (!read?.commitments?.length) continue
      const person = cloneEntity(read)
      let changed = false
      for (const c of person.commitments ?? []) {
        const mark = newest.get(commitmentKey(c.text))
        if (mark && c.status !== 'rejected' && c.status !== mark.status) {
          c.status = mark.status
          changed = true
        }
      }
      if (changed) await writePerson(s, pslug, person)
    }
    return { applied }
  })
}
