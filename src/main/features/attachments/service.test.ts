import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_TURN_BYTES,
  AttachmentIntentSchema
} from '@shared/attachments'
import { createAttachmentService, type AttachmentService, type ClipboardPayload } from './service'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])

describe('composer attachment service (G54)', () => {
  let dir: string
  let owner: string | null
  let session: string
  let picked: string[] | null
  let clip: ClipboardPayload | null
  let svc: AttachmentService
  const file = async (name: string, body: string | Buffer): Promise<string> => {
    const p = join(dir, name)
    await writeFile(p, body)
    return p
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'metis-g54-'))
    owner = 'owner-a'
    session = 'session-1'
    picked = null
    clip = null
    let n = 0
    svc = createAttachmentService({
      owner: () => owner,
      session: () => session,
      now: () => 1000,
      newId: () => `att-${String(++n).padStart(8, '0')}`,
      pickFiles: async () => picked,
      readClipboard: async () => clip,
      isProtectedPath: (p) => p.includes(`${join(dir, 'secret')}`)
    })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const drop = (paths: string[], key = 'c1') => svc.add({ source: 'drop', conversationKey: key, paths })

  it('accepts a text file and holds it bound to the conversation, exposing no path or content', async () => {
    const r = await drop([await file('notes.md', '# hello')])
    expect(r.ok).toBe(true)
    expect(r.rejected).toEqual([])
    expect(r.attachments).toEqual([
      { id: 'att-00000001', name: 'notes.md', kind: 'text', bytes: 7, conversationKey: 'c1', addedAt: 1000 }
    ])
    expect(JSON.stringify(r)).not.toContain(dir)
    expect(svc.list('c1')).toHaveLength(1)
    expect(svc.list('other')).toHaveLength(0)
  })

  it.each([
    ['photo.exe', 'x', 'executable'],
    ['run.sh', 'echo', 'executable'],
    ['doc.pdf', 'x', 'unsupported-type'],
    ['noext', 'x', 'unsupported-type'],
    ['empty.txt', '', 'empty']
  ])('refuses %s with %s', async (name, body, reason) => {
    const r = await drop([await file(name, body)])
    expect(r.attachments).toEqual([])
    expect(r.rejected[0]).toMatchObject({ name, reason })
    expect(r.rejected[0]?.message.length).toBeGreaterThan(5)
  })

  it('refuses a renamed program by its magic bytes, a binary blob as text, and a fake image', async () => {
    const mz = await file('report.txt', Buffer.from('MZ\u0090\u0000\u0003'))
    const elf = await file('log.txt', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]))
    const shebang = await file('x.txt', '#!/bin/sh\nrm -rf ~')
    const fake = await file('pic.png', 'not really a png')
    const r = await drop([mz, elf, shebang, fake])
    expect(r.attachments).toEqual([])
    expect(r.rejected.map((x) => x.reason)).toEqual(['executable', 'executable', 'executable', 'not-an-image'])
  })

  it('refuses directories, symlinks and protected locations', async () => {
    const real = await file('real.txt', 'data')
    const link = join(dir, 'link.txt')
    await symlink(real, link)
    const sub = join(dir, 'folder.txt')
    await mkdir(sub)
    await mkdir(join(dir, 'secret'))
    const prot = await file('secret/k.json', '{}')
    const r = await drop([link, sub, prot])
    expect(r.rejected.map((x) => x.reason)).toEqual(['symlink', 'not-a-file', 'protected-location'])
  })

  it('refuses a relative path or one with a NUL byte', async () => {
    const r = await drop(['relative/file.txt', `${dir}/a\u0000.txt`])
    expect(r.rejected.map((x) => x.reason)).toEqual(['invalid', 'invalid'])
  })

  it('PROPOSED limits: per-file 25 MiB, 10 files, 50 MiB per turn', async () => {
    expect(ATTACHMENT_MAX_FILE_BYTES).toBe(25 * 1024 * 1024)
    expect(ATTACHMENT_MAX_FILES).toBe(10)
    expect(ATTACHMENT_MAX_TURN_BYTES).toBe(50 * 1024 * 1024)
    const big = await file('big.txt', Buffer.alloc(ATTACHMENT_MAX_FILE_BYTES + 1, 97))
    expect((await drop([big])).rejected[0]?.reason).toBe('too-large')
    const paths: string[] = []
    for (let i = 0; i < ATTACHMENT_MAX_FILES + 2; i++) paths.push(await file(`f${i}.txt`, `x${i}`))
    const r = await drop(paths)
    expect(r.attachments).toHaveLength(ATTACHMENT_MAX_FILES)
    expect(r.rejected.map((x) => x.reason)).toEqual(['too-many', 'too-many'])
  })

  it('per-turn total: a file that would pass 50 MiB is refused', async () => {
    const chunk = Buffer.alloc(ATTACHMENT_MAX_FILE_BYTES, 97)
    const a = await file('a.txt', chunk)
    const b = await file('b.txt', chunk)
    const c = await file('c.txt', chunk)
    const r = await drop([a, b, c])
    expect(r.attachments).toHaveLength(2)
    expect(r.rejected[0]).toMatchObject({ name: 'c.txt', reason: 'turn-too-large' })
  })

  it('one image per turn', async () => {
    const r = await drop([await file('a.png', PNG), await file('b.png', PNG)])
    expect(r.attachments.map((a) => a.kind)).toEqual(['image'])
    expect(r.rejected[0]?.reason).toBe('too-many-images')
  })

  it('picker: main supplies the paths; cancel is a quiet, honest result', async () => {
    picked = null
    const none = await svc.add({ source: 'picker', conversationKey: 'c1' })
    expect(none).toMatchObject({ ok: false, attachments: [], rejected: [{ reason: 'cancelled' }] })
    picked = [await file('p.txt', 'picked')]
    const r = await svc.add({ source: 'picker', conversationKey: 'c1' })
    expect(r.attachments[0]?.name).toBe('p.txt')
  })

  it('paste: file paths and in-memory images work; empty clipboard says so', async () => {
    expect((await svc.add({ source: 'paste', conversationKey: 'c1' })).rejected[0]?.reason).toBe('nothing-to-paste')
    clip = { paths: [await file('c.csv', 'a,b')] }
    expect((await svc.add({ source: 'paste', conversationKey: 'c1' })).attachments[0]?.name).toBe('c.csv')
    clip = { image: { name: 'pasted-image.png', data: PNG } }
    const r = await svc.add({ source: 'paste', conversationKey: 'c1' })
    expect(r.attachments[0]).toMatchObject({ name: 'pasted-image.png', kind: 'image' })
  })

  it('refuses everything while signed out', async () => {
    owner = null
    const r = await drop([await file('a.txt', 'x')])
    expect(r.rejected[0]?.reason).toBe('signed-out')
  })

  it('consume hands the bytes to the bound conversation once, then forgets them', async () => {
    const [a] = (await drop([await file('a.txt', 'hello')])).attachments
    const got = svc.consume([a!.id], 'c1', { imageSlotFree: true })
    expect(got).toMatchObject({ ok: true, items: [{ name: 'a.txt', kind: 'text', bytes: 5 }] })
    if (got.ok) expect(got.items[0]?.data.toString()).toBe('hello')
    expect(svc.list('c1')).toEqual([])
    expect(svc.consume([a!.id], 'c1', { imageSlotFree: true })).toEqual({ ok: false, reason: 'not-found' })
  })

  it('CAP-28: a different conversation key refuses visibly and discards the stale file', async () => {
    const [a] = (await drop([await file('a.txt', 'hello')], 'c1')).attachments
    expect(svc.consume([a!.id], 'c2', { imageSlotFree: true })).toEqual({ ok: false, reason: 'wrong-target' })
    expect(svc.consume([a!.id], 'c1', { imageSlotFree: true })).toEqual({ ok: false, reason: 'not-found' })
  })

  it('CAP-28: a changed main session, a switched owner or a sign-out refuses', async () => {
    const add = async (): Promise<string> =>
      (await drop([await file(`n${Math.random()}.txt`, 'hello')])).attachments[0]!.id
    let id = await add()
    session = 'session-2'
    expect(svc.consume([id], 'c1', { imageSlotFree: true })).toEqual({ ok: false, reason: 'wrong-target' })
    id = await add()
    owner = 'owner-b'
    expect(svc.consume([id], 'c1', { imageSlotFree: true })).toEqual({ ok: false, reason: 'wrong-target' })
    owner = 'owner-b'
    id = await add()
    owner = null
    expect(svc.consume([id], 'c1', { imageSlotFree: true })).toEqual({ ok: false, reason: 'signed-out' })
  })

  it('one bad id fails the whole send and consumes nothing', async () => {
    const [a] = (await drop([await file('a.txt', 'hello')])).attachments
    expect(svc.consume([a!.id, 'missing-id-0001'], 'c1', { imageSlotFree: true })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(svc.list('c1')).toHaveLength(1)
  })

  it('an attached image while the turn already has a screenshot refuses before consuming', async () => {
    const [a] = (await drop([await file('a.png', PNG)])).attachments
    expect(svc.consume([a!.id], 'c1', { imageSlotFree: false })).toEqual({ ok: false, reason: 'image-slot-taken' })
    expect(svc.list('c1')).toHaveLength(1)
  })

  it('remove, and clear on revoke, drop held files', async () => {
    const [a, b] = (await drop([await file('a.txt', 'a'), await file('b.txt', 'b')])).attachments
    expect(svc.remove(a!.id)).toBe(true)
    expect(svc.remove(a!.id)).toBe(false)
    svc.clear('owner_switch')
    expect(svc.list('c1')).toEqual([])
    expect(svc.consume([b!.id], 'c1', { imageSlotFree: true })).toEqual({ ok: false, reason: 'not-found' })
  })

  it('the intent schema is strict: no content, no stray fields', () => {
    expect(AttachmentIntentSchema.safeParse({ source: 'paste', conversationKey: 'c', data: 'AAAA' }).success).toBe(
      false
    )
    expect(AttachmentIntentSchema.safeParse({ source: 'picker', conversationKey: 'c', paths: ['/x'] }).success).toBe(
      false
    )
    expect(AttachmentIntentSchema.safeParse({ source: 'drop', conversationKey: 'c', paths: [] }).success).toBe(false)
    expect(
      AttachmentIntentSchema.safeParse({ source: 'drop', conversationKey: 'c', paths: ['/a/b.txt'] }).success
    ).toBe(true)
  })
})
