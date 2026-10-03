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
    Promise.all(personSlugs.map((slug) => loadPerson(s, slug))),
    Promise.all(accountSlugs.map((slug) => loadAccount(s, slug))),
    Promise.all(dealSlugs.map((slug) => loadDeal(s, slug))),
    Promise.all((meetingSlugs ?? []).map((slug) => loadMeetingExtraction(s, slug)))
  ])
  return {
    index,
    graph,
    people: people.filter((person): person is NonNullable<typeof person> => !!person),
    accounts: accounts.filter((account): account is NonNullable<typeof account> => !!account),
    deals: deals.filter((deal): deal is NonNullable<typeof deal> => !!deal),
    meetings: meetings.filter((meeting): meeting is NonNullable<typeof meeting> => !!meeting && !!index.ingested[meeting.source_file]?.ok)
  }
}
