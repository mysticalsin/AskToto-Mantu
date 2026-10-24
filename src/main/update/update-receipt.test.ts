import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearInstallReceipt, readInstallReceipt, writeInstallReceipt } from './update-receipt'

describe('G86 install receipt', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'g86-receipt-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const receipt = { schema: 1, fromVersion: '2.0.0', toVersion: '2.1.0', at: 5 } as const

  it('round-trips through the atomic write and carries versions and a timestamp only', async () => {
    await writeInstallReceipt(dir, receipt)
    expect(await readInstallReceipt(dir)).toEqual(receipt)
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'update-receipt.json'), 'utf8')))).toEqual([
      'schema',
      'fromVersion',
      'toVersion',
      'at'
    ])
  })

  it('treats a missing, malformed, extra-field or oversized file as absent', async () => {
    expect(await readInstallReceipt(dir)).toBeNull()
    const file = join(dir, 'update-receipt.json')
    writeFileSync(file, 'not json')
    expect(await readInstallReceipt(dir)).toBeNull()
    writeFileSync(file, JSON.stringify({ ...receipt, extra: 1 }))
    expect(await readInstallReceipt(dir)).toBeNull()
    writeFileSync(file, JSON.stringify({ ...receipt, fromVersion: 'x'.repeat(5000) }))
    expect(await readInstallReceipt(dir)).toBeNull()
  })

  it('clear removes it and tolerates a missing file', async () => {
    await writeInstallReceipt(dir, receipt)
    await clearInstallReceipt(dir)
    expect(existsSync(join(dir, 'update-receipt.json'))).toBe(false)
    await expect(clearInstallReceipt(dir)).resolves.toBeUndefined()
  })
})
