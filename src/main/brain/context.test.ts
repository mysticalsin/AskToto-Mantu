import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
    }
  }
})

import { buildBrainContext } from './context'
import { writePerson, writeAccount, writeDeal } from './store'
import { whenIndexWritesSettle } from './ingest'

const settingsFor = (folder: string): Settings => ({ meetingsFolder: folder } as Settings)

const MEETING = { file: 'm1.md', date: '2026-06-01', title: 'Renewal call' }

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

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-brain-context-'))
    s = settingsFor(folder)
    for (const slug of PEOPLE) await writePerson(s, slug, personFor(slug))
    for (const slug of ACCOUNTS) {
      await writeAccount(s, slug, AccountEntitySchema.parse({ id: slug, name: titleCase(slug), meetings: [MEETING] }))
    }
    for (const slug of DEALS) {
      await writeDeal(s, slug, DealEntitySchema.parse({ id: slug, name: titleCase(slug), meetings: [MEETING] }))
    }
    opened.length = 0
  })
  // MQA-007: settle the index-write lane BEFORE removing the profile. updateIndex writes
  // index.json through a tmp+rename, and a detached one can still be in flight here — under
  // parallel load the rename then lands on a directory this line already deleted, failing an
  // unrelated test in whichever file happened to be running.
  afterEach(async () => {
    await whenIndexWritesSettle()
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  it('MQA-010 — a question that names no entity opens no entity file at all', () => {
    buildBrainContext(s, 'what is the weather in Paris today') // first ask builds the match index
    opened.length = 0

    const { block, matched } = buildBrainContext(s, 'what is the weather in Paris today')
    expect(matched).toBe(false)
    expect(block).toBe('')
    expect(opened).toEqual([])
  })

  it('MQA-010 — a question naming one person opens only that person, not the corpus', () => {
    buildBrainContext(s, 'what is the weather in Paris today')
    opened.length = 0

    const { block, matched } = buildBrainContext(s, 'what did Maria Silva promise on pricing?')
    expect(matched).toBe(true)
    expect(block).toContain('Maria Silva')
    expect(opened).toEqual(['person/maria-silva'])
  })

  it('MQA-010 — an alias-only match still hits the canonical record without reopening the corpus', async () => {
    // The pre-filter must not shrink what CAN match: aliases[] live inside the entity file, so a
    // slug-only filter would silently drop this hit (Task MI-5's corrected-away surface form).
    await writePerson(s, 'acme-co', personFor('acme-co', ['Acme Corp']))
    buildBrainContext(s, 'what is the weather in Paris today')
    opened.length = 0

    const { block, matched } = buildBrainContext(s, 'what did Acme Corp say on the renewal call?')
    expect(matched).toBe(true)
    expect(block).toContain('Acme Co') // the CURRENT canonical name, not the alias itself
    expect(opened).toEqual(['person/acme-co'])
  })

  it('MQA-010 — an alias added to an existing entity after the index was built still matches', async () => {
    expect(buildBrainContext(s, 'what did Globex Holdings say?').matched).toBe(false)

    await writePerson(s, 'nadia-haddad', personFor('nadia-haddad', ['Globex Holdings']))

    const { block, matched } = buildBrainContext(s, 'what did Globex Holdings say?')
    expect(matched).toBe(true)
    expect(block).toContain('Nadia Haddad')
  })

  it('MQA-010 — a question naming an account and a deal opens only those two files', () => {
    buildBrainContext(s, 'what is the weather in Paris today')
    opened.length = 0

    const { block, matched } = buildBrainContext(s, 'where is the Initech Nordics Rollout heading?')
    expect(matched).toBe(true)
    expect(block).toContain('Initech')
    expect(block).toContain('Nordics Rollout')
    expect(opened).toEqual(['account/initech', 'deal/nordics-rollout'])
  })
})
