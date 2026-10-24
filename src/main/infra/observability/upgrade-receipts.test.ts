import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyVersionChange, compareVersions, readUpgradeReceipts, recordLaunchVersion } from './upgrade-receipts'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'metis-upgrade-receipts-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const at = (): Date => new Date('2026-10-23T12:00:00Z')

describe('version comparison', () => {
  it('orders dotted versions numerically, not lexically', () => {
    expect(compareVersions('2.9.0', '2.10.0')).toBe(-1)
    expect(compareVersions('2.12.1', '2.12.0')).toBe(1)
    expect(compareVersions('2.12', '2.12.0')).toBe(0)
  })
  it('sorts a pre-release before its release and refuses to order two pre-releases', () => {
    expect(compareVersions('2.12.0-rc.1', '2.12.0')).toBe(-1)
    expect(compareVersions('2.12.0-rc.1', '2.12.0-rc.2')).toBeNull()
  })
  it('classifies first-run, upgrade, rollback, changed and unchanged', () => {
    expect(classifyVersionChange(undefined, '2.12.0')).toBe('first-run')
    expect(classifyVersionChange('2.11.0', '2.12.0')).toBe('upgrade')
    expect(classifyVersionChange('2.12.0', '2.11.0')).toBe('rollback')
    expect(classifyVersionChange('weird', '2.12.0')).toBe('changed')
    expect(classifyVersionChange('2.12.0', '2.12.0')).toBeNull()
  })
})

describe('recordLaunchVersion', () => {
  it('writes a receipt per version change and nothing on a same-version relaunch', async () => {
    const logPath = join(dir, 'upgrade-receipts.jsonl')
    expect(await recordLaunchVersion({ logPath, version: '2.11.0', now: at })).toMatchObject({ kind: 'first-run' })
    expect(await recordLaunchVersion({ logPath, version: '2.11.0', now: at })).toBeNull()
    expect(await recordLaunchVersion({ logPath, version: '2.12.0', now: at })).toMatchObject({
      kind: 'upgrade',
      from: '2.11.0',
      to: '2.12.0'
    })
    expect(await recordLaunchVersion({ logPath, version: '2.11.0', now: at })).toMatchObject({
      kind: 'rollback',
      from: '2.12.0',
      to: '2.11.0'
    })
    const receipts = await readUpgradeReceipts(logPath)
    expect(receipts.map((r) => r.kind)).toEqual(['first-run', 'upgrade', 'rollback'])
  })

  it('stores only versions and a timestamp', async () => {
    const logPath = join(dir, 'r.jsonl')
    await recordLaunchVersion({ logPath, version: '2.12.0', now: at })
    const raw = (await readFile(logPath, 'utf8')).trim()
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['at', 'kind', 'schema', 'to'])
  })

  it('skips a torn line and keeps the valid history', async () => {
    const logPath = join(dir, 'r.jsonl')
    await writeFile(
      logPath,
      '{"schema":1,"kind":"first-run","to":"2.10.0","at":"2026-01-01T00:00:00Z"}\n{"schema":1,"kind":"upg'
    )
    expect(await recordLaunchVersion({ logPath, version: '2.12.0', now: at })).toMatchObject({ from: '2.10.0' })
  })

  it('never rejects when the log cannot be written', async () => {
    const blocker = join(dir, 'file')
    await writeFile(blocker, 'x')
    await expect(
      recordLaunchVersion({ logPath: join(blocker, 'sub', 'r.jsonl'), version: '2.12.0' })
    ).resolves.toBeNull()
  })

  it('returns an empty history for a missing log', async () => {
    expect(await readUpgradeReceipts(join(dir, 'missing.jsonl'))).toEqual([])
  })
})
