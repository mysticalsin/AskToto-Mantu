import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'

vi.mock('electron')

// pickBackend reads the store directly (the engine pin, the stored keys, the org allowlist). Stub the
// whole module — the real one opens the keychain and the userData dir, neither of which the test sandbox
// may touch. vitest hoists vi.mock() above the static imports, so graphify.ts sees the stub.
const store = vi.hoisted(() => ({
  settings: {} as Settings,
  keys: {} as Record<string, string>,
  allowed: null as string[] | null
}))
vi.mock('./store', () => ({
  getSettings: () => store.settings,
  getApiKey: (p: string) => store.keys[p] || '',
  hasApiKey: (p: string) => (store.keys[p] || '').length > 0,
  getAllowedProviders: () => store.allowed
}))

import { computeRelated, windowsPythonDirs, graphifyRefusalReason, graphifySourceDir, pickBackend } from './graphify'

// Graph shaped like real graphify output: each concept node is owned by ONE note (its source_file),
// and the other note links to the same concept node cross-file. This is how shared people/topics
// connect notes that never reference each other directly.
const graph = {
  nodes: [
    { id: 'bnp_note', label: 'BNP Paribas RFP', file_type: 'document', source_file: '/notes/2026-06-01_bnp.md' },
    { id: 'owens_note', label: 'Owens-Corning extension', file_type: 'document', source_file: '/notes/2026-06-02_owens.md' },
    { id: 'tony', label: 'Tony Walteur', file_type: 'concept', source_file: '/notes/2026-06-01_bnp.md' },
    { id: 'cyber', label: 'Mantu cybersecurity team', file_type: 'concept', source_file: '/notes/2026-06-02_owens.md' },
    { id: 'lonely', label: 'Unrelated topic', file_type: 'concept', source_file: '/notes/2026-06-09_other.md' }
  ],
  links: [
    { source: 'bnp_note', target: 'tony', relation: 'references' },
    { source: 'owens_note', target: 'tony', relation: 'references' },
    { source: 'bnp_note', target: 'cyber', relation: 'shares_data_with' },
    { source: 'owens_note', target: 'cyber', relation: 'references' }
  ]
}

describe('computeRelated', () => {
  it('connects two notes through a shared person (1-hop, my concept) and team (2-hop, neighbour concept)', () => {
    const r = computeRelated(graph, '/notes/2026-06-01_bnp.md')
    expect(r.ok).toBe(true)
    // BNP owns "Tony"; it links to "cyber" (owned by Owens) → both are topics of this note.
    expect(r.topics).toEqual(expect.arrayContaining(['Tony Walteur', 'Mantu cybersecurity team']))
    // Owens connects to BNP via both shared concepts.
    const owens = r.notes.find((n) => n.title === 'Owens-Corning extension')
    expect(owens).toBeTruthy()
    expect(owens!.via.length).toBeGreaterThan(0)
    expect(owens!.file).toBe('2026-06-02_owens.md')
  })

  it('is symmetric — querying the other note finds the first', () => {
    const r = computeRelated(graph, '/notes/2026-06-02_owens.md')
    expect(r.notes.map((n) => n.title)).toContain('BNP Paribas RFP')
  })

  it('returns empty (not error) for a note absent from the graph', () => {
    const r = computeRelated(graph, '/notes/nonexistent.md')
    expect(r.ok).toBe(true)
    expect(r.notes).toEqual([])
    expect(r.topics).toEqual([])
  })
})

describe('windowsPythonDirs — python.org per-user installer PATH fallback', () => {
  const savedLocalAppData = process.env.LOCALAPPDATA
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'asktoto-winpy-'))
    process.env.LOCALAPPDATA = tmpDir
  })
  afterEach(() => {
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = savedLocalAppData
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns [] when Programs\\Python does not exist', () => {
    expect(windowsPythonDirs()).toEqual([])
  })

  it('picks the newest versioned subfolder (not the container dir itself) plus its Scripts dir', () => {
    const base = join(tmpDir, 'Programs', 'Python')
    mkdirSync(join(base, 'Python310'), { recursive: true })
    mkdirSync(join(base, 'Python312'), { recursive: true })
    mkdirSync(join(base, 'Python311'), { recursive: true })
    expect(windowsPythonDirs()).toEqual([join(base, 'Python312'), join(base, 'Python312', 'Scripts')])
  })

  it('ignores non-version-named siblings under Programs\\Python', () => {
    const base = join(tmpDir, 'Programs', 'Python')
    mkdirSync(join(base, 'Python39'), { recursive: true })
    mkdirSync(join(base, 'Launcher'), { recursive: true })
    expect(windowsPythonDirs()).toEqual([join(base, 'Python39'), join(base, 'Python39', 'Scripts')])
  })
})

// Task MI-5 — graphify inheritance: the encryption/graph deadlock is removed exactly when the user has
// consented to publish the plaintext wiki mirror. Pure routing decisions, no child process involved.
describe('graphifyRefusalReason / graphifySourceDir (Task MI-5 — graphify inheritance)', () => {
  const s = (overrides: Partial<Settings>): Settings =>
    ({ meetingsFolder: '/meetings', encryptTranscripts: false, publishBrainPages: false, ...overrides }) as Settings

  it('unencrypted: never refuses, always scans the meetings folder directly (unchanged pre-MI-5 behavior)', () => {
    expect(graphifyRefusalReason(s({ encryptTranscripts: false }))).toBeNull()
    expect(graphifySourceDir(s({ encryptTranscripts: false }))).toBe('/meetings')
    // QA #10: with publishing ON, the graph is built from the confidential-free wiki mirror even when
    // unencrypted — the raw meetings folder still contains confidential meetings; the mirror excludes them.
    expect(graphifySourceDir(s({ encryptTranscripts: false, publishBrainPages: true }))).toBe(join('/meetings', 'wiki'))
  })

  it('encrypted + publishBrainPages off: refuses outright (the old deadlock, unchanged)', () => {
    const settings = s({ encryptTranscripts: true, publishBrainPages: false })
    expect(graphifyRefusalReason(settings)).toMatch(/encrypted/i)
    // The refusal is checked by buildGraph BEFORE ever calling graphifySourceDir in this branch, but the
    // pure function itself still degrades to the (unreadable) meetings folder rather than throwing.
    expect(graphifySourceDir(settings)).toBe('/meetings')
  })

  it('encrypted + publishBrainPages on: never refuses, routes the build at the plaintext wiki/ mirror', () => {
    const settings = s({ encryptTranscripts: true, publishBrainPages: true })
    expect(graphifyRefusalReason(settings)).toBeNull()
    expect(graphifySourceDir(settings)).toBe(join('/meetings', 'wiki'))
  })
})

// MQA-058 — Settings sells the three engines as exclusive contracts ("Claude · uses your Anthropic key"),
// with 'auto' as the separate opt-in to the cascade. A pinned engine whose key is gone must therefore fail
// closed: the auto-rebuild runs in the background over the WHOLE meetings folder, so falling through would
// stream every transcript to a vendor the user never picked, silently.
describe('pickBackend — an explicit engine pick never falls through to another vendor (MQA-058)', () => {
  beforeEach(() => {
    store.settings = { graphifyBackend: 'auto' } as Settings
    store.keys = {}
    store.allowed = null
  })

  it('backend "openai" with the OpenAI key removed yields no backend, not the stored Anthropic key', async () => {
    store.settings = { graphifyBackend: 'openai' } as Settings
    store.keys = { anthropic: 'sk-ant-still-here' }
    expect(await pickBackend()).toBeNull()
  })

  it('backend "claude" with the Anthropic key removed yields no backend, not the stored OpenAI key', async () => {
    store.settings = { graphifyBackend: 'claude' } as Settings
    store.keys = { openai: 'sk-openai-still-here' }
    expect(await pickBackend()).toBeNull()
  })

  it('an org allowlist that blocks the pinned vendor fails closed instead of swapping vendor', async () => {
    store.settings = { graphifyBackend: 'claude' } as Settings
    store.keys = { anthropic: 'sk-ant', openai: 'sk-openai' }
    store.allowed = ['openai']
    expect(await pickBackend()).toBeNull()
  })

  it('still honors an explicit pick whose key is present', async () => {
    store.settings = { graphifyBackend: 'openai' } as Settings
    store.keys = { anthropic: 'sk-ant', openai: 'sk-openai' }
    expect(await pickBackend()).toEqual({ backend: 'openai', apiKey: 'sk-openai' })
  })

  it('"auto" still cascades to a stored key (claude-cli off the allowlist here, so no CLI probe runs)', async () => {
    store.settings = { graphifyBackend: 'auto' } as Settings
    store.keys = { anthropic: 'sk-ant' }
    store.allowed = ['anthropic', 'openai']
    expect(await pickBackend()).toEqual({ backend: 'claude', apiKey: 'sk-ant' })
  })
})
