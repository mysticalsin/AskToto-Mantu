import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nodeArtifactFs, type ArtifactFileStat, type ArtifactFs } from './artifact-fs'
import { createArtifactRegistry, safeDisplayName } from './registry'
import { createArtifactService } from './service'

const PROVENANCE = { producer: 'tool' as const, sourceIds: ['tool-call-1'] }

let dir: string
let owner: string | null
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'artifacts-test-'))
  owner = 'owner-a'
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup(fs: ArtifactFs = nodeArtifactFs) {
  let n = 0
  const registry = createArtifactRegistry({ owner: () => owner, fs, now: () => 1000, newId: () => `art-${++n}` })
  const openPath = vi.fn(async () => '')
  const showItemInFolder = vi.fn()
  const clock = { now: 1000 }
  const service = createArtifactService({ registry, fs, openPath, showItemInFolder, now: () => clock.now })
  return { registry, service, openPath, showItemInFolder, clock }
}

function makeFile(name: string, text = 'hello'): string {
  const file = join(dir, name)
  writeFileSync(file, text)
  return file
}

const reg = (registry: ReturnType<typeof setup>['registry'], path: string, turnId = 'turn-1') =>
  registry.register({ turnId, sessionId: 'session-1', path, provenance: PROVENANCE })

describe('artifact registry', () => {
  it('records bytes and sha256 from the real file and lists it in the turn manifest by id only', async () => {
    const { registry } = setup()
    const result = await reg(registry, makeFile('notes.md', 'hello'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record).toMatchObject({
      artifactId: 'art-1',
      kind: 'document',
      displayName: 'notes.md',
      bytes: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    })
    expect(registry.outputManifest('turn-1')).toEqual({ turnId: 'turn-1', artifactIds: ['art-1'] })
    expect(registry.outputManifest('turn-2').artifactIds).toEqual([])
  })

  it('refuses a file that does not exist, a directory, relative or non-normalized paths, and executable types', async () => {
    const { registry } = setup()
    expect(await reg(registry, join(dir, 'ghost.md'))).toEqual({ ok: false, reason: 'not-a-file' })
    expect(await reg(registry, dir)).toEqual({ ok: false, reason: 'not-a-file' })
    expect(await reg(registry, 'relative/notes.md')).toEqual({ ok: false, reason: 'invalid-path' })
    expect(await reg(registry, `${dir}/sub/../notes.md`)).toEqual({ ok: false, reason: 'invalid-path' })
    expect(await reg(registry, makeFile('run.command'))).toEqual({ ok: false, reason: 'blocked-type' })
    expect(await reg(registry, makeFile('setup.exe'))).toEqual({ ok: false, reason: 'blocked-type' })
  })

  it('refuses a symlink and needs an owner', async () => {
    const link: ArtifactFileStat = { isFile: () => false, isSymbolicLink: () => true, size: 1, mtimeMs: 1, ino: 1 }
    const fake: ArtifactFs = { ...nodeArtifactFs, lstat: async () => link }
    const { registry } = setup(fake)
    expect(await reg(registry, join(dir, 'l.md'))).toEqual({ ok: false, reason: 'not-a-file' })
    owner = null
    expect(await reg(setup().registry, makeFile('a.md'))).toEqual({ ok: false, reason: 'no-owner' })
  })

  it('shows a record only to the owner that registered it, and a forged id is unknown', async () => {
    const { registry } = setup()
    await reg(registry, makeFile('a.md'))
    expect(registry.get('art-1')).not.toBeNull()
    expect(registry.get('art-999')).toBeNull()
    expect(registry.get('../../etc/passwd')).toBeNull()
    owner = 'owner-b'
    expect(registry.get('art-1')).toBeNull()
    expect(registry.outputManifest('turn-1').artifactIds).toEqual([])
  })

  it('keeps display names to a bare, bounded file name', () => {
    expect(safeDisplayName('/etc/../secret/report.pdf')).toBe('report.pdf')
    expect(safeDisplayName('C:\\Users\\x\\report.pdf')).toBe('report.pdf')
    expect(safeDisplayName('a\u0000b\nc.md')).toBe('abc.md')
    expect(safeDisplayName('x'.repeat(500)).length).toBe(120)
    expect(safeDisplayName('/')).toBe('file')
  })
})

describe('artifact service: existence and digest check', () => {
  it('reports ready for an intact file and offers open and reveal', async () => {
    const { registry, service, openPath, showItemInFolder } = setup()
    const file = makeFile('a.md')
    await reg(registry, file)
    const turn = await service.forTurn('turn-1')
    expect(turn.chips).toHaveLength(1)
    expect(turn.chips[0]).toMatchObject({ artifactId: 'art-1', status: 'ready', producer: 'tool' })
    expect(JSON.stringify(turn)).not.toContain(dir)
    expect(await service.open('art-1')).toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledWith(file)
    expect(await service.reveal('art-1')).toEqual({ ok: true })
    expect(showItemInFolder).toHaveBeenCalledWith(file)
  })

  it('reports missing when the file was moved, and does not open or reveal it', async () => {
    const { registry, service, openPath, showItemInFolder } = setup()
    const file = makeFile('a.md')
    await reg(registry, file)
    unlinkSync(file)
    expect((await service.forTurn('turn-1')).chips[0].status).toBe('missing')
    expect(await service.open('art-1')).toEqual({ ok: false, reason: 'missing' })
    expect(await service.reveal('art-1')).toEqual({ ok: false, reason: 'missing' })
    expect(openPath).not.toHaveBeenCalled()
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('reports changed when the digest differs, even at the same size', async () => {
    const { registry, service, openPath } = setup()
    const file = makeFile('a.md', 'hello')
    await reg(registry, file)
    writeFileSync(file, 'HELLO')
    expect((await service.forTurn('turn-1')).chips[0].status).toBe('changed')
    expect(await service.open('art-1')).toEqual({ ok: false, reason: 'changed' })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('returns not-found for a forged id', async () => {
    const { service } = setup()
    expect(await service.open('forged')).toEqual({ ok: false, reason: 'not-found' })
    expect(await service.reveal('..')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('reports a failed OS open honestly', async () => {
    const { registry, service, openPath } = setup()
    await reg(registry, makeFile('a.md'))
    openPath.mockResolvedValueOnce('no application')
    expect(await service.open('art-1')).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('artifact service: drag-out', () => {
  it('starts a drag for the recorded file only, after verification and arming', async () => {
    const { registry, service } = setup()
    const file = makeFile('a.md')
    await reg(registry, file)
    const begin = vi.fn()
    expect(await service.arm('art-1')).toEqual({ ok: false, reason: 'changed' }) // never verified
    expect(service.dragStart('art-1', begin)).toEqual({ ok: false, reason: 'changed' }) // never armed
    await service.forTurn('turn-1')
    expect(service.dragStart('art-1', begin)).toEqual({ ok: false, reason: 'changed' }) // verified, not armed
    expect(await service.arm('art-1')).toEqual({ ok: true })
    expect(service.dragStart('art-1', begin)).toEqual({ ok: true })
    expect(begin).toHaveBeenCalledExactlyOnceWith({ file })
  })

  it('refuses once the arming window has passed', async () => {
    const { registry, service, clock } = setup()
    await reg(registry, makeFile('a.md'))
    await service.forTurn('turn-1')
    await service.arm('art-1')
    clock.now += 6000
    const begin = vi.fn()
    expect(service.dragStart('art-1', begin)).toEqual({ ok: false, reason: 'changed' })
    expect(begin).not.toHaveBeenCalled()
  })

  it('refuses a forged id and another owner', async () => {
    const { registry, service } = setup()
    await reg(registry, makeFile('a.md'))
    await service.forTurn('turn-1')
    await service.arm('art-1')
    const begin = vi.fn()
    expect(service.dragStart('/etc/passwd', begin)).toEqual({ ok: false, reason: 'not-found' })
    expect(await service.arm('../x')).toEqual({ ok: false, reason: 'not-found' })
    owner = 'owner-b'
    expect(service.dragStart('art-1', begin)).toEqual({ ok: false, reason: 'not-found' })
    expect(begin).not.toHaveBeenCalled()
  })

  it('refuses to arm when the file was rewritten or removed after it was verified', async () => {
    const { registry, service } = setup()
    const file = makeFile('a.md')
    await reg(registry, file)
    await service.forTurn('turn-1')
    utimesSync(file, new Date(5_000_000), new Date(5_000_000)) // same bytes, new mtime: not what was verified
    const begin = vi.fn()
    expect(await service.arm('art-1')).toEqual({ ok: false, reason: 'changed' })
    expect(service.dragStart('art-1', begin)).toEqual({ ok: false, reason: 'changed' })
    await service.forTurn('turn-1')
    expect(await service.arm('art-1')).toEqual({ ok: true })
    unlinkSync(file)
    await service.forTurn('turn-1') // a later verification that finds it gone disarms the drag
    expect(service.dragStart('art-1', begin)).toEqual({ ok: false, reason: 'changed' })
    expect(begin).not.toHaveBeenCalled()
  })

  it('does not drag after a verification that found the file changed', async () => {
    const { registry, service } = setup()
    const file = makeFile('a.md', 'hello')
    await reg(registry, file)
    await service.forTurn('turn-1')
    await service.arm('art-1')
    writeFileSync(file, 'other contents')
    await service.forTurn('turn-1')
    const begin = vi.fn()
    expect(service.dragStart('art-1', begin)).toEqual({ ok: false, reason: 'changed' })
    expect(begin).not.toHaveBeenCalled()
  })
})

describe('artifact preview and copy (G55)', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')

  it('previews a verified text file from main-resolved bytes only', async () => {
    const { registry, service } = setup()
    const r = await reg(registry, makeFile('notes.md', '# hi <b>'))
    if (!r.ok) throw new Error('register')
    const show = vi.fn()
    expect(await service.preview(r.record.artifactId, show)).toEqual({ ok: true })
    expect(show).toHaveBeenCalledTimes(1)
    expect(show.mock.calls[0][0].title).toBe('notes.md')
    expect(show.mock.calls[0][0].html).toContain('&lt;b&gt;')
    expect(Object.keys(show.mock.calls[0][0]).sort()).toEqual(['html', 'title'])
  })

  it('refuses to preview or copy a file changed since it was recorded, even with the same size', async () => {
    const { registry, service } = setup()
    const file = makeFile('notes.md', 'hello')
    const r = await reg(registry, file)
    if (!r.ok) throw new Error('register')
    writeFileSync(file, 'HELLO')
    const show = vi.fn()
    const write = vi.fn()
    expect((await service.preview(r.record.artifactId, show)).ok).toBe(false)
    expect((await service.copy(r.record.artifactId, write)).ok).toBe(false)
    expect(show).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('reports unsupported types and unknown ids without showing anything', async () => {
    const { registry, service } = setup()
    const r = await reg(registry, makeFile('data.pdf', '%PDF'))
    if (!r.ok) throw new Error('register')
    const show = vi.fn()
    expect(await service.preview(r.record.artifactId, show)).toEqual({ ok: false, reason: 'unsupported' })
    expect(await service.copy(r.record.artifactId, vi.fn())).toEqual({ ok: false, reason: 'unsupported' })
    expect(await service.preview('nope', show)).toEqual({ ok: false, reason: 'not-found' })
    expect(show).not.toHaveBeenCalled()
  })

  it('copies the exact file text, preserving lists, blank lines and unicode, and image bytes untouched', async () => {
    const { registry, service } = setup()
    const text = '# T\n\n- one\n- two\n\n1. a\n2. b\n\ncafé ✓\n'
    const r = await reg(registry, makeFile('n.md', text))
    if (!r.ok) throw new Error('register')
    const write = vi.fn()
    expect(await service.copy(r.record.artifactId, write)).toEqual({ ok: true })
    expect(write).toHaveBeenCalledWith({ kind: 'text', text })
    expect(sha(text)).toBe(r.record.sha256)

    const png = join(dir, 'p.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]))
    const img = await reg(registry, png)
    if (!img.ok) throw new Error('register')
    const writeImg = vi.fn()
    await service.copy(img.record.artifactId, writeImg)
    expect(writeImg.mock.calls[0][0].kind).toBe('image')
    expect([...writeImg.mock.calls[0][0].bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 255])
  })

  it('reports a clipboard failure honestly instead of ok', async () => {
    const { registry, service } = setup()
    const r = await reg(registry, makeFile('n.txt', 'x'))
    if (!r.ok) throw new Error('register')
    const write = vi.fn(() => {
      throw new Error('clipboard busy')
    })
    expect(await service.copy(r.record.artifactId, write)).toEqual({ ok: false, reason: 'failed' })
  })

  it('refuses a file over the cap without reading it', async () => {
    const { registry, service } = setup()
    const r = await reg(registry, makeFile('big.txt', 'x'.repeat(1024 * 1024 + 1)))
    if (!r.ok) throw new Error('register')
    expect(await service.preview(r.record.artifactId, vi.fn())).toEqual({ ok: false, reason: 'too-large' })
  })
})
