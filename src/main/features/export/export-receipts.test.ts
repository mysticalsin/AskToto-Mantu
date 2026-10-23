import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendReceipt, readReceipt } from './export-receipts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'export-rcpt-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const receipt = (exportId: string) => ({
  exportId,
  kind: 'recap-pdf' as const,
  destination: '/x/a.pdf',
  bytes: 3,
  sha256: 'a'.repeat(64),
  writtenAt: '2026-10-23T12:00:00.000Z',
  conflictResolution: 'none' as const
})

describe('export receipts', () => {
  it('appends one line per receipt and never rewrites earlier lines', async () => {
    const file = join(dir, 'sub', 'log.jsonl')
    await appendReceipt(file, receipt('1'))
    const first = await readFile(file, 'utf8')
    await appendReceipt(file, receipt('2'))
    const all = await readFile(file, 'utf8')
    expect(all.startsWith(first)).toBe(true)
    expect(all.trim().split('\n')).toHaveLength(2)
  })
  it('finds a receipt by id and skips corrupt or foreign lines', async () => {
    const file = join(dir, 'log.jsonl')
    await writeFile(file, `not json\n${JSON.stringify({ exportId: 'x' })}\n${JSON.stringify(receipt('ok'))}\n`)
    expect((await readReceipt(file, 'ok'))?.destination).toBe('/x/a.pdf')
    expect(await readReceipt(file, 'x')).toBeNull()
    expect(await readReceipt(join(dir, 'missing.jsonl'), 'ok')).toBeNull()
  })
})
