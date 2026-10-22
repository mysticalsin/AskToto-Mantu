import type { Settings } from '@shared/ipc'
import {
  loadIndexForStatus,
  loadGraph,
  loadPerson,
  loadAccount,
  loadDeal,
  loadEntitySlugs,
  loadMeetingExtraction,
  loadMeetingExtractionSlugs
} from './store'
import { resolveMeetingsFolder } from '../transcripts'
import { mapWithConcurrency } from '../infra/concurrency'

/** D8-6: at most this many entity or extraction files are read at once, whatever the size of the brain. */
const READ_CONCURRENCY = 16

type BrainStatusCounts = { people: number; accounts: number; deals: number; nodes: number; edges: number }
let brainStatusCountsCache: { folder: string; revision: number; counts: BrainStatusCounts } | null = null

/** Status is polled frequently by two windows. Re-scan graph/entity directories only after a revision change. */
export async function brainStatusCounts(s: Settings, revision: number): Promise<BrainStatusCounts> {
  const folder = resolveMeetingsFolder(s)
  if (brainStatusCountsCache?.folder === folder && brainStatusCountsCache.revision === revision) {
    return brainStatusCountsCache.counts
  }
  const graph = await loadGraph(s)
  const counts = {
    people: (await loadEntitySlugs(s, 'person')).length,
    accounts: (await loadEntitySlugs(s, 'account')).length,
    deals: (await loadEntitySlugs(s, 'deal')).length,
    nodes: graph.nodes.length,
    edges: graph.edges.length
  }
  brainStatusCountsCache = { folder, revision, counts }
  return counts
}

export async function readBrainDashboard(s: Settings) {
  const [index, graph, personSlugs, accountSlugs, dealSlugs, meetingSlugs] = await Promise.all([
    loadIndexForStatus(s),
    loadGraph(s),
    loadEntitySlugs(s, 'person'),
    loadEntitySlugs(s, 'account'),
    loadEntitySlugs(s, 'deal'),
    loadMeetingExtractionSlugs(s)
  ])
  const [people, accounts, deals, meetings] = await Promise.all([
    mapWithConcurrency(personSlugs, READ_CONCURRENCY, (slug) => loadPerson(s, slug)),
    mapWithConcurrency(accountSlugs, READ_CONCURRENCY, (slug) => loadAccount(s, slug)),
    mapWithConcurrency(dealSlugs, READ_CONCURRENCY, (slug) => loadDeal(s, slug)),
    mapWithConcurrency(meetingSlugs ?? [], READ_CONCURRENCY, (slug) => loadMeetingExtraction(s, slug))
  ])
  // Source receipts bind private on-device paths/bytes to ingestion. Keep them Main-only even though the
  // dashboard needs the ordinary meeting refs and extraction fields.
  const stripMeetingReceipt = <T extends { sourceRootId?: string }>(meeting: T) => {
    const { sourceRootId: _sourceRootId, ...visible } = meeting
    return visible
  }
  const publicIndex = {
    ...index,
    ingested: Object.fromEntries(
      Object.entries(index.ingested).map(([key, receipt]) => {
        const { sourceDigest: _sourceDigest, sourceRootId: _sourceRootId, ...visible } = receipt
        return [key, visible]
      })
    )
  }
  const stripEntityReceipts = <T extends { meetings: Array<{ sourceRootId?: string }> }>(entity: T) => ({
    ...entity,
    meetings: entity.meetings.map(stripMeetingReceipt)
  })
  const publicMeetings = meetings
    .filter((meeting): meeting is NonNullable<typeof meeting> => !!meeting && !!index.ingested[meeting.source_file]?.ok)
    .map((meeting) => {
      const { sourceDigest: _sourceDigest, sourceRootId: _sourceRootId, ...visible } = meeting
      return visible
    })
  return {
    index: publicIndex,
    graph,
    people: people.filter((person): person is NonNullable<typeof person> => !!person).map(stripEntityReceipts),
    accounts: accounts.filter((account): account is NonNullable<typeof account> => !!account).map(stripEntityReceipts),
    deals: deals.filter((deal): deal is NonNullable<typeof deal> => !!deal).map(stripEntityReceipts),
    meetings: publicMeetings
  }
}
