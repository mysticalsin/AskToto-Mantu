import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectDiagnosticsBundle, previewDiagnosticsBundle } from './diagnostics-bundle'

let userData = ''
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'metis-diag-bundle-'))
  await mkdir(join(userData, 'logs'))
  const record = { ts: '2026-10-23T10:00:00Z', event: 'ask.done', transcript: 'secret meeting words' }
  await writeFile(join(userData, 'logs', 'audit.log'), JSON.stringify(record) + '\n')
  await writeFile(join(userData, 'logs', 'main.log'), 'failed for owner@example.com at /Users/owner/x\n')
  await writeFile(join(userData, 'crash-1.log'), 'stack Bearer ' + 'z'.repeat(30))
  await writeFile(
    join(userData, 'upgrade-receipts.jsonl'),
    '{"schema":1,"kind":"upgrade","from":"2.11.0","to":"2.12.0","at":"2026-10-22T00:00:00Z"}\n'
  )
})
afterEach(async () => {
  await rm(userData, { recursive: true, force: true })
})

const info = (): Parameters<typeof collectDiagnosticsBundle>[0] => ({
  userData,
  version: '2.12.0',
  platform: 'darwin',
  arch: 'arm64',
  packaged: true,
  now: () => new Date('2026-10-23T12:00:00Z')
})

describe('collectDiagnosticsBundle redaction gate', () => {
  it('writes only redacted bytes: no meeting words, email, home account or token reach any entry', async () => {
    const bundle = await collectDiagnosticsBundle(info())
    const all = bundle.entries.map((e) => e.bytes.toString('utf8')).join('\n')
    expect(all).not.toMatch(/meeting words|owner@example|\/Users\/owner|zzzzzzzz/)
    expect(all).toContain('ask.done')
  })

  it('includes the upgrade receipts and states the redaction in the manifest', async () => {
    const bundle = await collectDiagnosticsBundle(info())
    const names = bundle.entries.map((e) => e.name)
    expect(names).toContain('upgrade-receipts.jsonl')
    const manifest = bundle.entries.find((e) => e.name === 'MANIFEST.txt')?.bytes.toString('utf8') ?? ''
    expect(manifest).toMatch(/redactions: \d+/)
  })

  it('does not upload: collecting performs no network call', async () => {
    const calls: unknown[] = []
    const real = globalThis.fetch
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args)
      return Promise.reject(new Error('blocked'))
    }) as typeof fetch
    try {
      await collectDiagnosticsBundle(info())
    } finally {
      globalThis.fetch = real
    }
    expect(calls).toEqual([])
  })
})

describe('previewDiagnosticsBundle', () => {
  it('shows exactly the bytes that would be exported, with per-file hashes and redaction counts', async () => {
    const bundle = await collectDiagnosticsBundle(info())
    const preview = previewDiagnosticsBundle(bundle)
    expect(preview.files.map((f) => f.name).sort()).toEqual(bundle.entries.map((e) => e.name).sort())
    const audit = preview.files.find((f) => f.name === 'audit.log')
    expect(audit?.text).toBe(bundle.entries.find((e) => e.name === 'audit.log')?.bytes.toString('utf8'))
    expect(audit?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(audit?.redactions.total).toBeGreaterThan(0)
    expect(preview.totalRedactions).toBeGreaterThanOrEqual(3)
  })

  it('caps the displayed text but still hashes the full file', async () => {
    const bundle = await collectDiagnosticsBundle(info())
    bundle.entries.push({ name: 'big.log', bytes: Buffer.from('a'.repeat(200_000)) })
    const big = previewDiagnosticsBundle(bundle, { maxTextBytes: 1000 }).files.find((f) => f.name === 'big.log')
    expect(big?.text.length).toBeLessThanOrEqual(1000)
    expect(big?.textTruncated).toBe(true)
    expect(big?.bytes).toBe(200_000)
  })
})
