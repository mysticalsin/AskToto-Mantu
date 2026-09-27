import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { BrainIndexSchema, type BrainIndex } from '@shared/brain'
import type { Settings } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import type { ContentPresence } from '../infra/storage/dataless'
import type { StorageFs } from '../infra/storage/gateway'
import { useStorageForTests } from '../infra/storage/meetings-storage'
import {
  brainInputsLocal,
  countUnextracted,
  hasIncompleteSource,
  hasSourceDrift,
  scanMeetingSources,
  sourceVersions
} from './inputs'

const storageState = vi.hoisted(() => ({
  cloud: new Set<string>(),
  deleteBeforeClassify: new Set<string>()
}))

interface TestMeetingSource {
  key: string
  file: string
  source: 'meetings' | 'team'
  label?: string
  version?: string
  local: boolean
}

interface TestSourceFolder {
  root: string
  source: 'meetings' | 'team'
  label?: string
  status: 'ok' | 'missing' | 'failed'
  sources: TestMeetingSource[]
}

type TestSourceScan = readonly TestSourceFolder[]

function source(key: string, version: string | undefined = '1', local = true): TestMeetingSource {
  return { key, file: `${key}.md`, source: 'meetings' as const, version, local }
}

function okScan(...sources: TestMeetingSource[]): TestSourceScan {
  return [{ root: '/meetings', source: 'meetings', status: 'ok', sources }]
}

function idx(ingested: BrainIndex['ingested']): BrainIndex {
  return BrainIndexSchema.parse({ ingested })
}

function installStorage(): void {
  const fs: StorageFs = {
    readdir: fsp.readdir,
    realpath: fsp.realpath,
    stat: fsp.stat,
    readFile: fsp.readFile
  }
  useStorageForTests({
    detector: {
      classify: vi.fn(async (files: readonly { path: string }[]): Promise<Map<string, ContentPresence>> => {
        for (const file of files) {
          const name = basename(file.path)
          if (storageState.deleteBeforeClassify.has(name)) {
            storageState.deleteBeforeClassify.delete(name)
            await fsp.rm(file.path, { force: true })
          }
        }
        return new Map(files.map((file): [string, ContentPresence] => {
          const name = basename(file.path)
          return [file.path, storageState.cloud.has(name) ? 'dataless' : 'local']
        }))
      }),
      markLocal: vi.fn()
    },
    fs
  })
}

describe('brain input source helpers', () => {
  beforeEach(() => {
    storageState.cloud.clear()
    storageState.deleteBeforeClassify.clear()
    installStorage()
  })

  it('sourceVersions', () => {
    expect(sourceVersions([{ root: '/missing', source: 'meetings', status: 'missing', sources: [] }])).toBeNull()
    expect(sourceVersions(okScan({ ...source('a'), version: undefined }))).toBeNull()

    const versions = sourceVersions([
      { root: '/meetings', source: 'meetings', status: 'ok', sources: [source('a', 'v1')] },
      { root: '/team', source: 'team', label: 'Design', status: 'ok', sources: [{ ...source('team/Design/b', 'v2'), source: 'team' }] }
    ])

    expect(versions).toBeInstanceOf(Map)
    expect([...versions!.entries()]).toEqual([
      ['a', 'v1'],
      ['team/Design/b', 'v2']
    ])
  })

  it.each([
    {
      name: 'drift when a recorded sourceVersion differs',
      scan: okScan(source('a', 'new')),
      index: idx({ a: { at: 1, ok: true, sourceVersion: 'old' } }),
      drift: true,
      incomplete: false,
      unextracted: 0
    },
    {
      name: 'incomplete when a folder is unavailable',
      scan: [{ root: '/meetings', source: 'meetings', status: 'failed', sources: [] }] satisfies TestSourceScan,
      index: idx({}),
      drift: false,
      incomplete: true,
      unextracted: 0
    },
    {
      name: 'incomplete and unextracted when a local source has no ok record',
      scan: okScan(source('a', 'v1'), source('b', 'v1')),
      index: idx({ a: { at: 1, ok: true, sourceVersion: 'v1' } }),
      drift: false,
      incomplete: true,
      unextracted: 1
    },
    {
      name: 'cloud-only sources do not count as incomplete work',
      scan: okScan(source('a', 'v1', false)),
      index: idx({}),
      drift: false,
      incomplete: false,
      unextracted: 1
    }
  ])('$name', ({ scan, index, drift, incomplete, unextracted }) => {
    expect(hasSourceDrift(scan, index)).toBe(drift)
    expect(hasIncompleteSource(scan, index)).toBe(incomplete)
    expect(countUnextracted(scan, index)).toBe(unextracted)
  })

  it('scanMeetingSources', async () => {
    const meetingsFolder = mkdtempSync(join(tmpdir(), 'm2-0031-meetings-'))
    const teamFolder = mkdtempSync(join(tmpdir(), 'm2-0031-team-'))
    try {
      writeFileSync(join(meetingsFolder, 'own-local.md'), 'own', 'utf8')
      writeFileSync(join(meetingsFolder, 'own-cloud.md'), 'cloud', 'utf8')
      writeFileSync(join(teamFolder, 'team-local.md'), 'team', 'utf8')
      writeFileSync(join(teamFolder, 'team-cloud.md'), 'team cloud', 'utf8')
      writeFileSync(join(teamFolder, 'deleted.md'), 'gone', 'utf8')
      storageState.cloud.add('own-cloud.md')
      storageState.cloud.add('team-cloud.md')
      storageState.deleteBeforeClassify.add('deleted.md')

      const s: Settings = { ...DEFAULT_SETTINGS, meetingsFolder, teamTranscriptFolders: [teamFolder], encryptTranscripts: false }
      const scan = await scanMeetingSources(s)

      expect(scan).toHaveLength(2)
      const own = (scan as TestSourceScan).find((folder) => folder.source === 'meetings')!
      const team = (scan as TestSourceScan).find((folder) => folder.source === 'team')!
      expect(own.status).toBe('ok')
      expect(team.status).toBe('ok')
      expect(own.sources.map((entry) => entry.key).sort()).toEqual(['own-cloud.md', 'own-local.md'])
      expect(team.sources.map((entry) => entry.key).sort()).toEqual([
        `team/${team.label}/team-cloud.md`,
        `team/${team.label}/team-local.md`
      ])
      expect(own.sources.find((entry) => entry.key === 'own-cloud.md')).toEqual(expect.objectContaining({ local: false, version: expect.any(String) }))
      expect(team.sources.find((entry) => entry.key.endsWith('/team-cloud.md'))).toEqual(expect.objectContaining({ local: false, version: expect.any(String) }))
      expect(team.sources.some((entry) => entry.key.endsWith('/deleted.md'))).toBe(false)
    } finally {
      rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      rmSync(teamFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('brainInputsLocal', async () => {
    const meetingsFolder = mkdtempSync(join(tmpdir(), 'm2-0031-locality-'))
    try {
      mkdirSync(join(meetingsFolder, '.brain'), { recursive: true })
      writeFileSync(join(meetingsFolder, '.brain', 'index (conflicted copy).json'), '{}', 'utf8')
      storageState.cloud.add('index (conflicted copy).json')
      const base: Settings = { ...DEFAULT_SETTINGS, meetingsFolder, encryptTranscripts: false }
      expect(await brainInputsLocal(base)).toBe(false)

      storageState.cloud.clear()
      writeFileSync(join(meetingsFolder, '.brain', 'index.corrupt-2026-01-01.json'), '{}', 'utf8')
      storageState.cloud.add('index.corrupt-2026-01-01.json')
      unlinkSync(join(meetingsFolder, '.brain', 'index (conflicted copy).json'))
      expect(await brainInputsLocal(base)).toBe(true)

      writeFileSync(join(meetingsFolder, 'cloud-meeting.md'), 'cloud', 'utf8')
      storageState.cloud.add('cloud-meeting.md')
      expect(await brainInputsLocal({ ...base, publishBrainPages: true })).toBe(false)
    } finally {
      rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})
