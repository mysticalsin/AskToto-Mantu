import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'
import {
  MEETINGS_INDEX_FILE,
  readMeetingsIndex,
  writeMeetingsIndex,
  loadOrRebuildMeetingsIndex,
  type MeetingsIndex
} from './meetings-index'
import type { FileClass, StorageGateway } from './gateway'

vi.mock('electron')

const VERSION = { mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_000, size: 120 }

function localFile(size = VERSION.size): FileClass {
  return { status: 'ok', version: { ...VERSION, size }, isRegular: true, isSymlink: false }
}

function datalessFile(size = VERSION.size): FileClass {
  return { status: 'dataless', version: { ...VERSION, size }, isRegular: true, isSymlink: false }
}

function gatewayFixture(files: Record<string, { text: string; fileClass?: FileClass }>): StorageGateway {
  const reads: string[] = []
  return {
    list: vi.fn(async () => ({ status: 'ok', names: Object.keys(files) })),
    classify: vi.fn(async (paths: readonly string[]) => {
      const out = new Map<string, FileClass>()
      for (const path of paths) {
        const fixture = files[path]
        out.set(path, fixture?.fileClass ?? localFile(Buffer.byteLength(fixture?.text ?? '')))
      }
      return out
    }),
    read: vi.fn(async (path: string) => {
      reads.push(path)
      const fixture = files[path]
      if (!fixture) return { status: 'missing' }
      const fileClass = fixture.fileClass ?? localFile(Buffer.byteLength(fixture.text))
      if (!('version' in fileClass)) return fileClass
      if (fileClass.status !== 'ok') return { status: fileClass.status, version: fileClass.version }
      return { status: 'ok', version: fileClass.version, bytes: Buffer.from(fixture.text) }
    }),
    get reads() {
      return reads
    }
  } as StorageGateway & { reads: string[] }
}

function indexFixture(): MeetingsIndex {
  return {
    schema_version: 1,
    rebuilt_at: '2026-10-01T00:00:00.000Z',
    roots: [
      {
        id: 'primary',
        path: '/synthetic/meetings',
        entries: [
          {
            file: '2026-10-01_090000-planning.md',
            title: 'Planning',
            date: '2026-10-01T09:00:00.000Z',
            mode: 'meeting',
            durationMin: 12,
            participants: ['Ada'],
            topics: ['roadmap'],
            confidential: true,
            localState: 'local',
            version: VERSION
          }
        ]
      }
    ]
  }
}

describe('meetings index store', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'metis-meetings-index-'))
    vi.mocked(app.getPath).mockImplementation((name: string) => join(userData, name))
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    vi.mocked(safeStorage.encryptString).mockImplementation((value: string) => Buffer.from(`enc:${value}`))
    vi.mocked(safeStorage.decryptString).mockImplementation((bytes: Buffer) => {
      const value = bytes.toString('utf8')
      return value.startsWith('enc:') ? value.slice(4) : value
    })
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('persists the index as an encrypted userData file and reads the C5 entry schema back', async () => {
    const index = indexFixture()

    await writeMeetingsIndex(index)

    const bytes = readFileSync(join(userData, 'userData', MEETINGS_INDEX_FILE))
    expect(bytes.toString('utf8')).toContain('ATKENC2')
    expect(bytes.toString('utf8')).not.toContain('Planning')
    expect(await readMeetingsIndex()).toEqual(index)
    expect(readdirSync(join(userData, 'userData')).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('rebuilds a corrupt index from a gateway listing and replaces the corrupt bytes', async () => {
    const indexPath = join(userData, 'userData', MEETINGS_INDEX_FILE)
    mkdirSync(join(userData, 'userData'), { recursive: true })
    writeFileSync(indexPath, '{not json', 'utf8')
    const localText =
      '---\n' +
      'type: meeting-transcript\n' +
      'title: "Planning"\n' +
      'date: "2026-10-01T09:00:00.000Z"\n' +
      'mode: "meeting"\n' +
      'duration_min: 12\n' +
      'participants: Ada, Grace\n' +
      'topics: roadmap, budget\n' +
      'confidential: true\n' +
      '---\n\n## Notes & follow-ups\n'
    const gateway = gatewayFixture({
      '2026-10-01_090000-planning.md': {
        text: localText
      },
      '2026-10-01_100000-cloud-only.md': {
        text: '',
        fileClass: datalessFile(2048)
      },
      'README.md': { text: 'ignored' },
      'notes.txt': { text: 'ignored' }
    }) as StorageGateway & { reads: string[] }

    const rebuilt = await loadOrRebuildMeetingsIndex({
      roots: [{ id: 'primary', path: '/synthetic/meetings', gateway }]
    })

    expect(rebuilt.status).toBe('rebuilt')
    expect(rebuilt.index.roots[0].entries).toEqual([
      {
        file: '2026-10-01_100000-cloud-only.md',
        title: 'cloud only',
        date: '2026-10-01T10:00:00.000Z',
        mode: 'general',
        durationMin: 0,
        participants: [],
        localState: 'not-downloaded',
        version: { ...VERSION, size: 2048 }
      },
      {
        file: '2026-10-01_090000-planning.md',
        title: 'Planning',
        date: '2026-10-01T09:00:00.000Z',
        mode: 'meeting',
        durationMin: 12,
        participants: ['Ada', 'Grace'],
        topics: ['roadmap', 'budget'],
        confidential: true,
        localState: 'local',
        version: { ...VERSION, size: Buffer.byteLength(localText) }
      }
    ])
    expect(gateway.reads).toEqual(['2026-10-01_090000-planning.md'])
    expect(readFileSync(indexPath, 'utf8')).toContain('ATKENC2')
  })

  it('rebuilds an undecryptable ATKENC2 index from a gateway listing', async () => {
    const indexPath = join(userData, 'userData', MEETINGS_INDEX_FILE)
    mkdirSync(join(userData, 'userData'), { recursive: true })
    writeFileSync(
      indexPath,
      Buffer.concat([
        Buffer.from('ATKENC2\n'),
        Buffer.from(
          JSON.stringify({
            v: 2,
            iv: Buffer.alloc(12).toString('base64'),
            tag: Buffer.alloc(16).toString('base64'),
            ct: Buffer.from('ciphertext').toString('base64'),
            kLocal: `S:${Buffer.from('foreign-keychain-wrap').toString('base64')}`
          })
        )
      ])
    )
    vi.mocked(safeStorage.decryptString).mockImplementationOnce(() => {
      throw new Error('foreign keychain')
    })
    const gateway = gatewayFixture({
      '2026-10-01_090000-planning.md': {
        text: '---\ntitle: "Planning"\ndate: "2026-10-01T09:00:00.000Z"\n---\n'
      }
    }) as StorageGateway & { reads: string[] }

    const rebuilt = await loadOrRebuildMeetingsIndex({
      roots: [{ id: 'primary', path: '/synthetic/meetings', gateway }]
    })

    expect(rebuilt.status).toBe('rebuilt')
    expect(rebuilt.index.roots[0].entries).toMatchObject([
      {
        file: '2026-10-01_090000-planning.md',
        title: 'Planning',
        localState: 'local'
      }
    ])
    expect(gateway.list).toHaveBeenCalled()
    expect(gateway.reads).toEqual(['2026-10-01_090000-planning.md'])
    expect(readFileSync(indexPath, 'utf8')).toContain('ATKENC2')
  })

  it('keeps a valid index without touching the listings', async () => {
    const index = indexFixture()
    await writeMeetingsIndex(index)
    const gateway = gatewayFixture({}) as StorageGateway & { reads: string[] }

    const loaded = await loadOrRebuildMeetingsIndex({
      roots: [{ id: 'primary', path: '/synthetic/meetings', gateway }]
    })

    expect(loaded).toEqual({ status: 'loaded', index })
    expect(gateway.list).not.toHaveBeenCalled()
    expect(gateway.reads).toEqual([])
  })

  it('does not replace a corrupt index with a partial rebuild when a root listing is unavailable', async () => {
    const indexPath = join(userData, 'userData', MEETINGS_INDEX_FILE)
    mkdirSync(join(userData, 'userData'), { recursive: true })
    writeFileSync(indexPath, '{not json', 'utf8')
    const unavailableGateway = {
      list: vi.fn(async () => ({ status: 'unavailable', code: 'EPERM' })),
      classify: vi.fn(),
      read: vi.fn()
    } as unknown as StorageGateway

    const rebuilt = await loadOrRebuildMeetingsIndex({
      roots: [{ id: 'primary', path: '/synthetic/meetings', gateway: unavailableGateway }]
    })

    expect(rebuilt).toEqual({
      status: 'rebuilt',
      index: {
        schema_version: 1,
        rebuilt_at: expect.any(String),
        roots: []
      }
    })
    expect(unavailableGateway.classify).not.toHaveBeenCalled()
    expect(readFileSync(indexPath, 'utf8')).toBe('{not json')
  })
})
