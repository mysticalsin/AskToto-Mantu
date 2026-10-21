import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { PersonEntitySchema, AccountEntitySchema, DealEntitySchema } from '@shared/brain'

vi.mock('electron')

/**
 * MQA-010 — Receipt Mode's relevance pass used to `.map(read)` the WHOLE brain before `.filter(match)`,
 * so every answer-mode ask stat+read+decrypt+Zod-parsed every person/account/deal file on the
 * synchronous IPC handler — hundreds of files on a OneDrive-backed `.brain`, even for a question that
 * named nobody. What these tests measure is therefore not the returned block but the FILES OPENED to
 * produce it, so the store module is wrapped to record each entity read and forward to the real one.
 */
const opened: string[] = []

vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>()
  return {
    ...actual,
    readPerson: (s: Settings, slug: string) => {
      opened.push(`person/${slug}`)
      return actual.readPerson(s, slug)
    },
    readAccount: (s: Settings, slug: string) => {
      opened.push(`account/${slug}`)
      return actual.readAccount(s, slug)
    },
    readDeal: (s: Settings, slug: string) => {
      opened.push(`deal/${slug}`)
      return actual.readDeal(s, slug)
    },
    // WP04A: matched records are read once through the stable snapshot reader (bytes + digest), so
    // that read is the one that counts as opening the entity file for MQA-010.
    readBrainEntitySnapshot: ((s: Settings, kind: 'person' | 'account' | 'deal', slug: string) => {
      opened.push(`${kind}/${slug}`)
      return actual.readBrainEntitySnapshot(s, kind, slug)
    }) as typeof actual.readBrainEntitySnapshot
  }
})

import { buildBrainContext, buildBrainContextWithSources, formatDeal, resetMatchKeyCacheForTests } from './context'
import { writePerson, writeAccount, writeDeal, readIndex, writeIndex } from './store'
import { settleBrainWritesForTests } from '../test-helpers/settle-brain-writes'

const settingsFor = (folder: string): Settings => ({ meetingsFolder: folder }) as Settings

const ROOT = 'a'.repeat(64)
const digestOf = (file: string): string => createHash('sha256').update(file).digest('hex')

const MEETING = { file: 'm1.md', date: '2026-06-01', title: 'Renewal call', sourceRootId: ROOT }

/** The full WP04A source-reference shape: canonical root identity plus the ingestion-bound digest. */
const refFor = (kind: 'meeting' | 'provenance', source: string, date: string) => ({
  kind,
  source,
  date,
  sourceRootId: ROOT,
  sourceDigest: digestOf(source)
})

const PEOPLE = ['maria-silva', 'nadia-haddad', 'tom-becker', 'priya-raman', 'lars-jensen', 'chen-wei']
const ACCOUNTS = ['northwind-trading', 'initech', 'contoso-group']
const DEALS = ['latam-sap-ams', 'core-banking-refresh', 'nordics-rollout']

/** Display name for a slug — "maria-silva" -> "Maria Silva", so the block is assertable by name. */
const titleCase = (slug: string): string =>
  slug
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')

const personFor = (slug: string, aliases: string[] = []): ReturnType<typeof PersonEntitySchema.parse> =>
  PersonEntitySchema.parse({ id: slug, name: titleCase(slug), aliases, meetings: [MEETING] })

describe('buildBrainContext — relevance pass cost (MQA-010)', () => {
  let folder: string
  let s: Settings

  // Seed Main-only ingestion receipts the way ingest stamps them. Settle the index-write lane first so a
  // detached updateIndex from the preceding entity writes cannot land afterwards and clobber `ingested`.
  const seedReceipts = async (files: string[]): Promise<void> => {
    await settleBrainWritesForTests()
    const index = readIndex(s)
    const ingested = { ...index.ingested }
    for (const file of files) ingested[file] = { at: 1, ok: true, sourceRootId: ROOT, sourceDigest: digestOf(file) }
    await writeIndex(s, { ...index, ingested })
  }

  beforeEach(async () => {
    resetMatchKeyCacheForTests()
    folder = mkdtempSync(join(tmpdir(), 'asktoto-brain-context-'))
    s = settingsFor(folder)
    for (const slug of PEOPLE) await writePerson(s, slug, personFor(slug))
    for (const slug of ACCOUNTS) {
      await writeAccount(s, slug, AccountEntitySchema.parse({ id: slug, name: titleCase(slug), meetings: [MEETING] }))
    }
    for (const slug of DEALS) {
      await writeDeal(s, slug, DealEntitySchema.parse({ id: slug, name: titleCase(slug), meetings: [MEETING] }))
    }
    await seedReceipts([MEETING.file])
    opened.length = 0
  })
  // MQA-007: settle the index-write lane BEFORE removing the profile. updateIndex writes
  // index.json through a tmp+rename, and a detached one can still be in flight here — under
  // parallel load the rename then lands on a directory this line already deleted, failing an
  // unrelated test in whichever file happened to be running.
  afterEach(async () => {
    await settleBrainWritesForTests()
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  it('MQA-010 — a question that names no entity opens no entity file at all', async () => {
    await buildBrainContext(s, 'what is the weather in Paris today') // first ask builds the match index
    opened.length = 0

    const { block, matched } = await buildBrainContext(s, 'what is the weather in Paris today')
    expect(matched).toBe(false)
    expect(block).toBe('')
    expect(opened).toEqual([])
  })

  it('MQA-010 — a question naming one person opens only that person, not the corpus', async () => {
    await buildBrainContext(s, 'what is the weather in Paris today')
    opened.length = 0

    const { block, matched } = await buildBrainContext(s, 'what did Maria Silva promise on pricing?')
    expect(matched).toBe(true)
    expect(block).toContain('Maria Silva')
    expect(opened).toEqual(['person/maria-silva'])
  })

  it('returns bounded local source references alongside the existing cited context', async () => {
    await buildBrainContext(s, 'what is the weather in Paris today')
    const result = await buildBrainContextWithSources(s, 'what did Maria Silva promise?')
    expect(result.block).toContain('Renewal call')
    expect(result.sourceReferences).toContainEqual(refFor('meeting', MEETING.file, MEETING.date))
    expect(result.sourceReferencesComplete).toBe(true)
    expect(result.sourceReferences.length).toBeLessThanOrEqual(64)
  })

  it('gates person, account, and deal fields by provenance and records verified field sources', async () => {
    const person = PersonEntitySchema.parse({
      id: 'provenance-person',
      name: 'Provenance Person',
      role: 'Legacy Role',
      account: 'Legacy Organization',
      meetings: [MEETING, { file: 'person-role.md', date: '2026-05-20', title: 'Role review', sourceRootId: ROOT }],
      role_provenance: {
        value: 'Verified Role',
        source_file: 'person-role.md',
        date: '2026-05-20',
        confidence: 'EXTRACTED',
        state: 'verified'
      },
      org_provenance: {
        value: 'Pinned Organization',
        source_file: '',
        date: '',
        confidence: 'INFERRED',
        state: 'pinned'
      }
    })
    await writePerson(s, person.id, person)

    const account = AccountEntitySchema.parse({
      id: 'provenance-account',
      name: 'Provenance Account',
      sector: 'retail',
      strategic: true,
      meetings: [
        MEETING,
        { file: 'account-sector.md', date: '2026-05-21', title: 'Sector review', sourceRootId: ROOT }
      ],
      sector_provenance: {
        value: 'banking',
        source_file: 'account-sector.md',
        date: '2026-05-21',
        confidence: 'EXTRACTED',
        state: 'verified'
      }
    })
    await writeAccount(s, account.id, account)

    const deal = DealEntitySchema.parse({
      id: 'provenance-deal',
      name: 'Provenance Deal',
      account: 'Unproven Deal Account',
      stage: 'legacy stage',
      win_likelihood_band: 'good',
      meetings: [MEETING, { file: 'deal-outlook.md', date: '2026-05-22', title: 'Outlook review', sourceRootId: ROOT }],
      stage_provenance: {
        value: 'contract',
        source_file: '',
        date: '',
        confidence: 'INFERRED',
        state: 'edited'
      },
      win_likelihood_band_provenance: {
        value: 'concerning',
        source_file: 'deal-outlook.md',
        date: '2026-05-22',
        confidence: 'EXTRACTED',
        state: 'verified'
      }
    })
    await writeDeal(s, deal.id, deal)

    await seedReceipts(['person-role.md', 'account-sector.md', 'deal-outlook.md'])

    const result = await buildBrainContextWithSources(
      s,
      'Summarize Provenance Person Provenance Account Provenance Deal.'
    )
    expect(result.block).toContain('Verified Role [person-role.md, 2026-05-20]')
    expect(result.block).toContain('Pinned Organization (edited by you)')
    expect(result.block).not.toContain('Legacy Role')
    expect(result.block).not.toContain('Legacy Organization')
    expect(result.block).toContain('banking [account-sector.md, 2026-05-21]')
    expect(result.block).not.toContain('retail')
    expect(result.block).not.toContain('strategic')
    expect(result.block).toContain('contract (edited by you)')
    expect(result.block).toContain('concerning likelihood [deal-outlook.md, 2026-05-22]')
    expect(result.block).not.toContain('Unproven Deal Account')
    expect(result.block).not.toContain('legacy stage')
    expect(result.block).not.toContain('good likelihood')
    expect(result.sourceReferences).toContainEqual(refFor('provenance', 'person-role.md', '2026-05-20'))
    expect(result.sourceReferences).toContainEqual(refFor('provenance', 'account-sector.md', '2026-05-21'))
    expect(result.sourceReferences).toContainEqual(refFor('provenance', 'deal-outlook.md', '2026-05-22'))
    expect(result.sourceReferences.filter((r) => r.source === 'person-role.md')).toHaveLength(1)
    expect(result.sourceReferences.filter((r) => r.source === 'account-sector.md')).toHaveLength(1)
    expect(result.sourceReferences.filter((r) => r.source === 'deal-outlook.md')).toHaveLength(1)
    expect(result.sourceReferencesComplete).toBe(true)
  })

  it('preserves rendered role provenance when a later account contributes the same source', async () => {
    const source = 'shared-role-sector.md'
    const fieldDate = '2026-05-20'
    const genericDate = '2026-06-01'
    const sharedMeeting = { file: source, date: genericDate, title: 'Shared review', sourceRootId: ROOT }
    const person = PersonEntitySchema.parse({
      id: 'collision-person-first',
      name: 'Collision Person First',
      meetings: [sharedMeeting],
      role_provenance: {
        value: 'Verified role',
        source_file: source,
        date: fieldDate,
        confidence: 'EXTRACTED',
        state: 'verified'
      }
    })
    const account = AccountEntitySchema.parse({
      id: 'collision-account-later',
      name: 'Collision Account Later',
      meetings: [sharedMeeting]
    })
    await writePerson(s, person.id, person)
    await writeAccount(s, account.id, account)
    await seedReceipts([source])

    const result = await buildBrainContextWithSources(
      s,
      'Summarize Collision Person First and Collision Account Later.'
    )
    expect(result.block).toContain('Verified role [' + source + ', ' + fieldDate + ']')
    expect(
      result.sourceReferences.filter((reference) => reference.source === source && reference.sourceRootId === ROOT)
    ).toEqual([refFor('provenance', source, fieldDate)])
    expect(result.sourceReferencesComplete).toBe(true)
  })

  it('promotes an earlier person meeting contributor when an account renders verified sector provenance', async () => {
    const source = 'shared-person-account.md'
    const fieldDate = '2026-05-21'
    const genericDate = '2026-06-02'
    const sharedMeeting = { file: source, date: genericDate, title: 'Shared review', sourceRootId: ROOT }
    const person = PersonEntitySchema.parse({
      id: 'collision-person-generic',
      name: 'Collision Person Generic',
      meetings: [sharedMeeting]
    })
    const account = AccountEntitySchema.parse({
      id: 'collision-account-verified',
      name: 'Collision Account Verified',
      sector_provenance: {
        value: 'banking',
        source_file: source,
        date: fieldDate,
        confidence: 'EXTRACTED',
        state: 'verified'
      },
      meetings: [MEETING]
    })
    await writePerson(s, person.id, person)
    await writeAccount(s, account.id, account)
    await seedReceipts([source, MEETING.file])

    const result = await buildBrainContextWithSources(
      s,
      'Summarize Collision Person Generic and Collision Account Verified.'
    )
    expect(result.block).toContain('banking [' + source + ', ' + fieldDate + ']')
    expect(
      result.sourceReferences.filter((reference) => reference.source === source && reference.sourceRootId === ROOT)
    ).toEqual([refFor('provenance', source, fieldDate)])
    expect(result.sourceReferencesComplete).toBe(true)
  })

  it('promotes an existing source reference at the 64-source limit without taking another slot', async () => {
    const fieldDate = '2026-05-22'
    const meetings = Array.from({ length: 64 }, (_, index) => ({
      file: 'budget-source-' + index + '.md',
      date: '2026-06-03',
      title: 'Budget review ' + index,
      sourceRootId: ROOT
    }))
    const source = meetings[0].file
    const person = PersonEntitySchema.parse({
      id: 'budget-person-64',
      name: 'Budget Person Sixty Four',
      meetings,
      role_provenance: {
        value: 'Verified budget role',
        source_file: source,
        date: fieldDate,
        confidence: 'EXTRACTED',
        state: 'verified'
      }
    })
    await writePerson(s, person.id, person)
    await seedReceipts(meetings.map((meeting) => meeting.file))

    const result = await buildBrainContextWithSources(s, 'Summarize Budget Person 64.')
    expect(result.block).toContain('Verified budget role [' + source + ', ' + fieldDate + ']')
    expect(result.sourceReferences).toHaveLength(64)
    expect(
      result.sourceReferences.filter((reference) => reference.source === source && reference.sourceRootId === ROOT)
    ).toEqual([refFor('provenance', source, fieldDate)])
    expect(result.sourceReferencesComplete).toBe(true)
  })

  it('keeps the genuine 65th contributor incomplete while promoting a source inside the 64-slot budget', async () => {
    const fieldDate = '2026-05-23'
    const meetings = Array.from({ length: 65 }, (_, index) => ({
      file: 'budget-overflow-source-' + index + '.md',
      date: '2026-06-04',
      title: 'Budget overflow review ' + index,
      sourceRootId: ROOT
    }))
    const source = meetings[0].file
    const person = PersonEntitySchema.parse({
      id: 'budget-person-65',
      name: 'Budget Person Sixty Five',
      meetings,
      role_provenance: {
        value: 'Verified overflow role',
        source_file: source,
        date: fieldDate,
        confidence: 'EXTRACTED',
        state: 'verified'
      }
    })
    await writePerson(s, person.id, person)
    await seedReceipts(meetings.map((meeting) => meeting.file))

    const result = await buildBrainContextWithSources(s, 'Summarize Budget Person 65.')
    expect(result.block).toContain('Verified overflow role [' + source + ', ' + fieldDate + ']')
    expect(result.sourceReferences).toHaveLength(64)
    expect(result.sourceReferences.length).toBeLessThanOrEqual(64)
    expect(
      result.sourceReferences.filter((reference) => reference.source === source && reference.sourceRootId === ROOT)
    ).toEqual([refFor('provenance', source, fieldDate)])
    expect(result.sourceReferencesComplete).toBe(false)
  })

  it('omits plain role, organization, sector, stage, and band values without renderable provenance', async () => {
    const person = PersonEntitySchema.parse({
      id: 'unproven-person',
      name: 'Unproven Person',
      role: 'Unverified Role',
      account: 'Unverified Org',
      meetings: [MEETING],
      role_provenance: { value: 'Unverified Role', source_file: 'm1.md', date: MEETING.date, state: 'extracted' },
      org_provenance: { value: 'Unverified Org', source_file: 'm1.md', date: MEETING.date, state: 'extracted' }
    })
    await writePerson(s, person.id, person)
    const account = AccountEntitySchema.parse({
      id: 'unproven-account',
      name: 'Unproven Account',
      sector: 'retail',
      strategic: true,
      meetings: [MEETING],
      sector_provenance: { value: 'retail', source_file: 'm1.md', date: MEETING.date, state: 'extracted' }
    })
    await writeAccount(s, account.id, account)
    const deal = DealEntitySchema.parse({
      id: 'unproven-deal',
      name: 'Unproven Deal',
      stage: 'unverified stage',
      win_likelihood_band: 'good',
      meetings: [MEETING],
      stage_provenance: { value: 'unverified stage', source_file: 'm1.md', date: MEETING.date, state: 'extracted' },
      win_likelihood_band_provenance: { value: 'good', source_file: 'm1.md', date: MEETING.date, state: 'extracted' }
    })
    await writeDeal(s, deal.id, deal)

    const result = await buildBrainContextWithSources(s, 'Summarize Unproven Person Unproven Account Unproven Deal.')
    expect(result.block).not.toContain('Unverified Role')
    expect(result.block).not.toContain('Unverified Org')
    expect(result.block).not.toContain('(retail)')
    expect(result.block).not.toContain('strategic')
    expect(result.block).not.toContain('unverified stage')
    expect(result.block).not.toContain('good likelihood')
  })

  it('does not report provenance sources for amount or close-date fields that are omitted for missing files', async () => {
    const deal = DealEntitySchema.parse({
      id: 'missing-source-deal',
      name: 'Missing Source Deal',
      meetings: [],
      amount: {
        value: { value: 125000, currency: 'USD' },
        source_file: '',
        date: '2026-05-23',
        confidence: 'EXTRACTED',
        state: 'verified'
      },
      close_date: {
        value: '2026-06-30',
        source_file: '',
        date: '2026-05-24',
        confidence: 'EXTRACTED',
        state: 'verified'
      }
    })
    await writeDeal(s, deal.id, deal)

    const result = await buildBrainContextWithSources(s, 'Summarize Missing Source Deal.')
    expect(result.block).not.toContain('Amount:')
    expect(result.block).not.toContain('Close date:')
    expect(result.sourceReferences).toEqual([])
    expect(result.sourceReferencesComplete).toBe(true)
  })

  it('includes velocity only when a renderable provenance record grounds the displayed evidence', async () => {
    const value = { signal: 'soft-organizational-gate' as const, evidence: 'sponsor wants a decision next month' }
    const grounded = DealEntitySchema.parse({
      id: 'velocity-deal',
      name: 'Velocity Deal',
      meetings: [MEETING],
      velocity: value,
      velocity_provenance: {
        value,
        source_file: MEETING.file,
        date: MEETING.date,
        confidence: 'EXTRACTED',
        state: 'verified'
      }
    })
    await writeDeal(s, grounded.id, grounded)

    const result = await buildBrainContextWithSources(s, 'What is happening with the Velocity Deal?')
    expect(result.block).toContain(`Velocity ${value.signal}: ${value.evidence} [${MEETING.file}, ${MEETING.date}].`)
    expect(result.sourceReferences).toContainEqual(refFor('provenance', MEETING.file, MEETING.date))
    expect(result.sourceReferences.filter((r) => r.source === MEETING.file)).toHaveLength(1)
    expect(result.sourceReferencesComplete).toBe(true)

    const ungrounded = DealEntitySchema.parse({
      id: 'ungrounded-deal',
      name: 'Ungrounded Deal',
      velocity: value
    })
    expect(formatDeal(ungrounded)).not.toContain('Velocity ')
  })

  it('MQA-010 — an alias-only match still hits the canonical record without reopening the corpus', async () => {
    // The pre-filter must not shrink what CAN match: aliases[] live inside the entity file, so a
    // slug-only filter would silently drop this hit (Task MI-5's corrected-away surface form).
    await writePerson(s, 'acme-co', personFor('acme-co', ['Acme Corp']))
    await buildBrainContext(s, 'what is the weather in Paris today')
    opened.length = 0

    const { block, matched } = await buildBrainContext(s, 'what did Acme Corp say on the renewal call?')
    expect(matched).toBe(true)
    expect(block).toContain('Acme Co') // the CURRENT canonical name, not the alias itself
    expect(opened).toEqual(['person/acme-co'])
  })

  it('MQA-010 — an alias added to an existing entity after the index was built still matches', async () => {
    expect((await buildBrainContext(s, 'what did Globex Holdings say?')).matched).toBe(false)

    await writePerson(s, 'nadia-haddad', personFor('nadia-haddad', ['Globex Holdings']))

    const { block, matched } = await buildBrainContext(s, 'what did Globex Holdings say?')
    expect(matched).toBe(true)
    expect(block).toContain('Nadia Haddad')
  })

  it('MQA-010 — a question naming an account and a deal opens only those two files', async () => {
    await buildBrainContext(s, 'what is the weather in Paris today')
    opened.length = 0

    const { block, matched } = await buildBrainContext(s, 'where is the Initech Nordics Rollout heading?')
    expect(matched).toBe(true)
    expect(block).toContain('Initech')
    expect(block).toContain('Nordics Rollout')
    expect(opened).toEqual(['account/initech', 'deal/nordics-rollout'])
  })
})
