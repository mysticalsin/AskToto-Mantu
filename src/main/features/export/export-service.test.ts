import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createExportService } from './export-service'
import { readReceipt } from './export-receipts'

let dir: string
let logPath: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'export-svc-'))
  logPath = join(dir, 'receipts', 'export-receipts.jsonl')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

function setup(opts: { chosen?: string; response?: number; platform?: NodeJS.Platform } = {}) {
  const showSaveDialog = vi.fn(async () => ({
    canceled: opts.chosen === '',
    filePath: opts.chosen ?? join(dir, 'out.md')
  }))
  const showMessageBox = vi.fn(async (_o: unknown) => ({ response: opts.response ?? 0 }))
  const svc = createExportService({
    showSaveDialog,
    showMessageBox,
    receiptLogPath: () => logPath,
    platform: opts.platform ?? 'linux',
    now: () => new Date('2026-10-23T12:00:00.000Z'),
    newId: () => 'exp-1'
  })
  return { svc, showSaveDialog, showMessageBox }
}
const req = (bytes = Buffer.from('# hello')) => ({
  kind: 'meeting-markdown' as const,
  bytes,
  label: 'meeting copy',
  dialog: { title: 'Export' }
})

describe('exportFile', () => {
  it('previews the resolved destination and size, writes after confirmation, and returns a receipt with the digest of the exact bytes', async () => {
    const bytes = Buffer.from('# hello')
    const { svc, showMessageBox } = setup()
    const r = await svc.exportFile(req(bytes))
    if (!r.ok) throw new Error('expected ok')
    expect((await readFile(join(dir, 'out.md'))).equals(bytes)).toBe(true)
    expect(r.receipt).toMatchObject({
      exportId: 'exp-1',
      kind: 'meeting-markdown',
      bytes: bytes.byteLength,
      sha256: sha(bytes),
      writtenAt: '2026-10-23T12:00:00.000Z',
      conflictResolution: 'none'
    })
    expect(r.receipt.destination.endsWith('out.md')).toBe(true)
    const preview = JSON.stringify(showMessageBox.mock.calls[0][0])
    expect(preview).toContain('out.md')
    expect(preview).toMatch(/7 B|bytes/)
    expect(Object.keys(r.receipt).sort()).toEqual(
      ['bytes', 'conflictResolution', 'destination', 'exportId', 'kind', 'sha256', 'writtenAt'].sort()
    )
  })
  it('appends the receipt to the local log without any content', async () => {
    const { svc } = setup()
    await svc.exportFile(req(Buffer.from('SECRET MEETING TEXT')))
    const log = await readFile(logPath, 'utf8')
    expect(log).not.toContain('SECRET MEETING TEXT')
    expect(JSON.parse(log.trim())).toMatchObject({ exportId: 'exp-1' })
    expect((await readReceipt(logPath, 'exp-1'))?.kind).toBe('meeting-markdown')
    expect(await readReceipt(logPath, 'other')).toBeNull()
  })
  it('is cancelled by the save dialog or by the preview, and writes nothing', async () => {
    const a = setup({ chosen: '' })
    expect(await a.svc.exportFile(req())).toEqual({ ok: false, cancelled: true })
    const b = setup({ response: 1 })
    expect(await b.svc.exportFile(req())).toEqual({ ok: false, cancelled: true })
    expect(await readdir(dir)).toEqual([])
  })
  it('never overwrites silently: an existing file offers keep both, replace or cancel; cancel leaves it intact', async () => {
    await writeFile(join(dir, 'out.md'), 'old')
    const { svc, showMessageBox } = setup({ response: 2 })
    expect(await svc.exportFile(req())).toEqual({ ok: false, cancelled: true })
    expect(await readFile(join(dir, 'out.md'), 'utf8')).toBe('old')
    const o = showMessageBox.mock.calls[0][0] as { buttons: string[] }
    expect(o.buttons).toEqual(['Keep both', 'Replace', 'Cancel'])
  })
  it('keep both writes "name (2)" and leaves the original', async () => {
    await writeFile(join(dir, 'out.md'), 'old')
    const { svc } = setup({ response: 0 })
    const r = await svc.exportFile(req())
    if (!r.ok) throw new Error('expected ok')
    expect(await readFile(join(dir, 'out.md'), 'utf8')).toBe('old')
    expect(await readFile(join(dir, 'out (2).md'), 'utf8')).toBe('# hello')
    expect(r.receipt.conflictResolution).toBe('keep-both')
    expect(r.receipt.destination.endsWith('out (2).md')).toBe(true)
  })
  it('replace overwrites only after the explicit choice', async () => {
    await writeFile(join(dir, 'out.md'), 'old')
    const { svc } = setup({ response: 1 })
    const r = await svc.exportFile(req())
    if (!r.ok) throw new Error('expected ok')
    expect(await readFile(join(dir, 'out.md'), 'utf8')).toBe('# hello')
    expect(r.receipt.conflictResolution).toBe('replace')
  })
  it('refuses rather than clobbers when the file appears between preview and write', async () => {
    const { svc, showMessageBox } = setup()
    showMessageBox.mockImplementationOnce(async () => {
      await writeFile(join(dir, 'out.md'), 'appeared meanwhile')
      return { response: 0 }
    })
    const r = await svc.exportFile(req())
    expect(r.ok).toBe(false)
    expect(await readFile(join(dir, 'out.md'), 'utf8')).toBe('appeared meanwhile')
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
  it('refuses a reserved Windows name before any prompt', async () => {
    const { svc, showMessageBox } = setup({ chosen: join(dir, 'CON.md'), platform: 'win32' })
    const r = await svc.exportFile(req())
    expect(r).toMatchObject({ ok: false })
    expect(showMessageBox).not.toHaveBeenCalled()
  })
  it('says honestly that nothing was written when the write fails and leaves no half file', async () => {
    const { svc } = setup({ chosen: join(dir, 'blocked', 'x.md') })
    await mkdir(join(dir, 'blocked'))
    // Make the directory vanish between plan and write by removing it during the preview.
    const showMessageBox = vi.fn(async () => {
      await rm(join(dir, 'blocked'), { recursive: true })
      return { response: 0 }
    })
    const svc2 = createExportService({
      showSaveDialog: async () => ({ canceled: false, filePath: join(dir, 'blocked', 'x.md') }),
      showMessageBox,
      receiptLogPath: () => logPath,
      platform: 'linux'
    })
    void svc
    const r = await svc2.exportFile(req())
    expect(r.ok).toBe(false)
    if (!r.ok && 'error' in r) expect(r.error).toMatch(/no file was written/i)
    expect(await readdir(dir)).not.toContain('blocked')
  })
})

describe('exportDirectory', () => {
  const dreq = {
    kind: 'diagnostics-bundle' as const,
    label: 'diagnostics bundle',
    dialog: { title: 'Export diagnostics' },
    entries: [
      { name: 'b.log', bytes: Buffer.from('bbb') },
      { name: 'a.log', bytes: Buffer.from('aa') }
    ]
  }
  it('writes every entry into a new folder and digests the sorted per-file digests', async () => {
    const { svc } = setup({ chosen: join(dir, 'bundle') })
    const r = await svc.exportDirectory(dreq)
    if (!r.ok) throw new Error('expected ok')
    expect((await readdir(join(dir, 'bundle'))).sort()).toEqual(['a.log', 'b.log'])
    const manifest = `a.log\t${sha('aa')}\nb.log\t${sha('bbb')}\n`
    expect(r.receipt).toMatchObject({ kind: 'diagnostics-bundle', bytes: 5, sha256: sha(manifest) })
  })
  it('offers only keep both or cancel for an existing folder and never merges into it', async () => {
    await mkdir(join(dir, 'bundle'))
    await writeFile(join(dir, 'bundle', 'keep.txt'), 'mine')
    const { svc, showMessageBox } = setup({ chosen: join(dir, 'bundle'), response: 0 })
    const r = await svc.exportDirectory(dreq)
    if (!r.ok) throw new Error('expected ok')
    expect((showMessageBox.mock.calls[0][0] as { buttons: string[] }).buttons).toEqual(['Keep both', 'Cancel'])
    expect(await readdir(join(dir, 'bundle'))).toEqual(['keep.txt'])
    expect((await readdir(join(dir, 'bundle (2)'))).sort()).toEqual(['a.log', 'b.log'])
    expect(r.receipt.conflictResolution).toBe('keep-both')
  })
  it('removes the folder it created when an entry cannot be written', async () => {
    const { svc } = setup({ chosen: join(dir, 'bundle') })
    const r = await svc.exportDirectory({
      ...dreq,
      entries: [...dreq.entries, { name: '../escape.log', bytes: Buffer.from('x') }]
    })
    expect(r.ok).toBe(false)
    expect(await readdir(dir)).not.toContain('bundle')
  })
})
