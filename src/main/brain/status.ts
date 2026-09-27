/**
 * brain:status. RecallView polls it every 1-5 s and the dashboard every few seconds, so it reads the
 * ledger and .brain only through the storage gateway: never synchronously, never a cloud-only file.
 */
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import { BrainGraphSchema, type BrainStatus } from '@shared/brain'
import { loadIndex, readIndex, indexUnavailable, indexUnavailableMessage } from './ledger'
import { listBrainNames, loadJson } from './store'
import { journalCorruptionBlocked } from './corrections'
import { readIntelligenceIndexStatus, lastIndexedAt } from './intelligence-index'
import { resolveMeetingsFolder } from '../transcripts'
import {
  brainBackfillProgress,
  brainLiveIngestProgress,
  ingestFailureCounts,
  ingestFailureDetails,
  isPendingIngestRecord
} from './ingest'
import { pausedForCloudOnlyInputs } from './inputs'

type BrainCounts = { people: number; accounts: number; deals: number; nodes: number; edges: number }
const countsCache = new Map<string, { revision: number; counts: BrainCounts }>()

/** Re-derives entity/graph counts only after a revision change; on unavailable/null results it answers the
 *  last complete counts for this folder without caching, so the next poll retries. */
async function brainCounts(s: Settings, revision: number): Promise<BrainCounts> {
  const folder = resolveMeetingsFolder(s)
  const cached = countsCache.get(folder)
  if (cached?.revision === revision) return cached.counts
  const [people, accounts, deals, graph] = await Promise.all([
    listBrainNames(s, join('entities', 'person')),
    listBrainNames(s, join('entities', 'account')),
    listBrainNames(s, join('entities', 'deal')),
    loadJson(s, 'graph.json', (raw) => BrainGraphSchema.parse(raw))
  ])
  if (people === null || accounts === null || deals === null || graph.status !== 'ok') {
    return cached?.counts ?? { people: 0, accounts: 0, deals: 0, nodes: 0, edges: 0 }
  }
  const g = graph.value ?? { nodes: [], edges: [] }
  const counts = {
    people: people.filter((n) => n.endsWith('.json')).length,
    accounts: accounts.filter((n) => n.endsWith('.json')).length,
    deals: deals.filter((n) => n.endsWith('.json')).length,
    nodes: g.nodes.length,
    edges: g.edges.length
  }
  countsCache.set(folder, { revision, counts })
  return counts
}

export async function readBrainStatus(s: Settings): Promise<BrainStatus> {
  await loadIndex(s)
  const idx = readIndex(s)
  const unavailable = indexUnavailable(s)
  const [counts, intelligenceIndex, corruptionBlocked] = await Promise.all([
    brainCounts(s, idx.revision),
    readIntelligenceIndexStatus(s),
    journalCorruptionBlocked(s)
  ])
  const failure = ingestFailureCounts(idx)
  const failureDetails = ingestFailureDetails(idx)
  const pausedReason = unavailable ?? (pausedForCloudOnlyInputs(s) ? 'cloud-only' : null)
  return {
    meetings: Object.values(idx.ingested).filter((v) => v.ok).length,
    ingestedFiles: Object.entries(idx.ingested).filter(([, v]) => v.ok).map(([file]) => file),
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
    corruptionBlocked,
    cleanupPending: idx.sourceRefreshRequested === true,
    lastIndexedAt: lastIndexedAt(s),
    intelligenceIndex,
    ...(unavailable ? { indexUnavailable: unavailable } : {}),
    ...(pausedReason !== null ? { error: indexUnavailableMessage(pausedReason) } : {})
  }
}
