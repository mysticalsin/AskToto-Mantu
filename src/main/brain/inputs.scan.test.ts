import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { Settings } from '@shared/ipc'
import { BrainIndexSchema } from '@shared/brain'
import type { FileClass, ListResult, StorageGateway } from '../infra/storage/gateway'
import { storageAt, useStorageForTests } from '../infra/storage/meetings-storage'
import {
  canonicalSourceRootId,
  formatSourceVersion,
  hasIncompleteSource,
  hasSourceDrift,
  scanMeetingSources,
  sourceVersions
} from './inputs'

const scriptedGateways = vi.hoisted(() => new Map<string, unknown>())

vi.mock('../infra/storage/meetings-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/storage/meetings-storage')>()
  return {
    ...actual,
    storageAt: (root: string) => scriptedGateways.get(root) ?? actual.storageAt(root)
  }
})
vi.mock('electron')

type TestSettings = Settings & { meetingsFolder: string; teamTranscriptFolders: string[] }

function settings(meetingsFolder: string, teamTranscriptFolders: string[] = []): TestSettings {
  return { meetingsFolder, teamTranscriptFolders, publishBrainPages: false } as TestSettings
}

function emptyIndex() {
  return BrainIndexSchema.parse({ ingested: {} })
}

async function scanOnly(s: TestSettings) {
  const reads = [s.meetingsFolder, ...s.teamTranscriptFolders].map((root) => vi.spyOn(storageAt(root), 'read'))
  const scan = await scanMeetingSources(s)
  for (const read of reads) expect(read).not.toHaveBeenCalled()
  return scan
}

function scriptedGateway(
  listing: ListResult,
  classify: (paths: readonly string[]) => Map<string, FileClass> = () => new Map()
) {
  const gateway = {
    list: vi.fn(async () => listing),
    classify: vi.fn(async (paths: readonly string[]) => classify(paths)),
    read: vi.fn(),
    stream: vi.fn()
  } as unknown as StorageGateway
  return gateway
}

describe('scanMeetingSources missing-root classification', () => {
  let temp: string

  beforeEach(() => {
    scriptedGateways.clear()
    useStorageForTests()
    temp = mkdtempSync(join(tmpdir(), 'metis-inputs-scan-'))
    vi.mocked(app.getPath).mockReturnValue('')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    scriptedGateways.clear()
    rmSync(temp, { recursive: true, force: true })
  })

  it('reports a genuinely absent own root as missing without source-version or completion proof', async () => {
    const root = join(temp, 'absent-own')
    const scan = await scanOnly(settings(root))

    expect(scan).toHaveLength(1)
    expect(scan[0]).toMatchObject({ root, source: 'meetings', status: 'missing', sources: [] })
    expect(sourceVersions(scan)).toBeNull()
    expect(hasIncompleteSource(scan, emptyIndex())).toBe(true)
  })

  it('keeps a readable own source bound while an absent team root cannot prove deletion or drift', async () => {
    const ownRoot = join(temp, 'own')
    const missingTeamRoot = join(temp, 'shared')
    mkdirSync(ownRoot)
    const ownFile = join(ownRoot, 'own-meeting.md')
    writeFileSync(ownFile, 'synthetic metadata-only transcript\n', 'utf8')
    const scan = await scanOnly(settings(ownRoot, [missingTeamRoot]))
    const own = scan[0]?.sources[0]
    const expectedRootId = createHash('sha256').update(realpathSync(ownRoot), 'utf8').digest('hex')
    const stats = statSync(ownFile)
    const prior = BrainIndexSchema.parse({
      ingested: {
        'team/shared/team-meeting.md': { at: 1, ok: true, sourceVersion: '1:1' }
      }
    })

    expect(own).toMatchObject({
      key: 'own-meeting.md',
      file: ownFile,
      source: 'meetings',
      sourceRootId: expectedRootId,
      version: formatSourceVersion(stats)
    })
    expect(scan[1]).toMatchObject({
      root: missingTeamRoot,
      source: 'team',
      label: 'shared',
      status: 'missing',
      sources: []
    })
    expect(sourceVersions(scan)).toBeNull()
    expect(hasSourceDrift(scan, prior)).toBe(false)
    expect(hasIncompleteSource(scan, prior)).toBe(true)
  })

  it('keeps a regular file configured as a root failed rather than missing or usable', async () => {
    const root = join(temp, 'not-a-directory')
    writeFileSync(root, 'synthetic file root', 'utf8')

    const scan = await scanOnly(settings(root))

    expect(scan[0]).toMatchObject({ root, source: 'meetings', status: 'failed', sources: [] })
    expect(sourceVersions(scan)).toBeNull()
  })

  it.each([
    ['unavailable', { status: 'unavailable', code: 'EACCES' }],
    ['timeout', { status: 'timeout' }],
    ['degraded', { status: 'degraded' }],
    ['aborted', { status: 'aborted' }]
  ] as const)('keeps a %s listing failure failed', async (_name, listing) => {
    const root = join(temp, 'existing-root')
    mkdirSync(root)
    const gateway = scriptedGateway(listing as ListResult)
    scriptedGateways.set(root, gateway)

    const scan = await scanOnly(settings(root))

    expect(scan[0]).toMatchObject({ root, status: 'failed', sources: [] })
    expect(gateway.classify).not.toHaveBeenCalled()
  })

  it.each([
    ['unavailable', { status: 'unavailable', code: 'EACCES' }],
    ['timeout', { status: 'timeout' }],
    ['no entry', undefined]
  ] as const)('keeps a missing listing with %s root classification failed', async (_name, self) => {
    const root = join(temp, 'absent-root')
    const gateway = scriptedGateway({ status: 'missing' }, () =>
      self ? new Map([['', self as FileClass]]) : new Map()
    )
    scriptedGateways.set(root, gateway)

    const scan = await scanOnly(settings(root))

    expect(scan[0]).toMatchObject({ root, status: 'failed', sources: [] })
    expect(gateway.classify).toHaveBeenCalledWith([''])
  })

  it('rejects a successful listing when canonical identity is unresolved', async () => {
    const root = join(temp, 'unresolved-root')
    const fileClass: FileClass = {
      status: 'ok',
      version: { mtimeMs: 1, ctimeMs: 1, size: 1 },
      isSymlink: false,
      isRegular: true
    }
    const gateway = scriptedGateway({ status: 'ok', names: ['meeting.md'] }, () => new Map([['meeting.md', fileClass]]))
    scriptedGateways.set(root, gateway)

    const scan = await scanOnly(settings(root))

    expect(scan[0]).toMatchObject({ root, status: 'failed', sources: [] })
    expect(gateway.classify).not.toHaveBeenCalled()
  })

  it('refuses colliding team keys from two real roots with the same basename', async () => {
    const ownRoot = join(temp, 'own')
    const firstParent = join(temp, 'first')
    const secondParent = join(temp, 'second')
    const firstTeam = join(firstParent, 'shared')
    const secondTeam = join(secondParent, 'shared')
    mkdirSync(ownRoot)
    mkdirSync(firstTeam, { recursive: true })
    mkdirSync(secondTeam, { recursive: true })
    writeFileSync(join(firstTeam, 'same.md'), 'synthetic first source\n', 'utf8')
    writeFileSync(join(secondTeam, 'same.md'), 'synthetic second source\n', 'utf8')

    const scan = await scanOnly(settings(ownRoot, [firstTeam, secondTeam]))

    expect(scan.slice(1).map((folder) => folder.status)).toEqual(['failed', 'failed'])
    expect(scan.slice(1).flatMap((folder) => folder.sources.map((source) => source.key))).toEqual([
      'team/shared/same.md',
      'team/shared/same.md'
    ])
    expect(sourceVersions(scan)).toBeNull()
  })
})
