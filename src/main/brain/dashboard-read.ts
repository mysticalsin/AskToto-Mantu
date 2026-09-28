import type { Settings } from '@shared/ipc'
import {
  readIndex,
  loadIndex
} from './ledger'
import {
  loadGraph,
  loadPerson,
  loadAccount,
  loadDeal,
  loadEntitySlugs,
  loadMeetingExtraction,
  loadMeetingExtractionSlugs
} from './store'

export async function readBrainDashboard(s: Settings) {
  await loadIndex(s)
  const index = readIndex(s)
  const [graph, personSlugs, accountSlugs, dealSlugs, meetingSlugs] = await Promise.all([
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
    Promise.all(meetingSlugs.map((slug) => loadMeetingExtraction(s, slug)))
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

export async function readBrainEntityNames(s: Settings): Promise<{ names: string[] }> {
  const [personSlugs, accountSlugs] = await Promise.all([
    loadEntitySlugs(s, 'person'),
    loadEntitySlugs(s, 'account')
  ])
  const [people, accounts] = await Promise.all([
    Promise.all(personSlugs.map((slug) => loadPerson(s, slug))),
    Promise.all(accountSlugs.map((slug) => loadAccount(s, slug)))
  ])
  const personNames = people.map((person) => person?.name).filter((name): name is string => !!name)
  const accountNames = accounts.map((account) => account?.name).filter((name): name is string => !!name)
  return { names: Array.from(new Set([...personNames, ...accountNames])).slice(0, 500) }
}
