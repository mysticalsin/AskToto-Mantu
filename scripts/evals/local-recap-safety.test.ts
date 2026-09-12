import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cleanEnvironment, guardedFetch, parseArgs, reapOwnedChildren, verifyBinary, snapshotFiles, assertSnapshot, withHardDeadline, withGuardedNetwork, writeRunConfig } from './local-recap-safety.mjs'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('native eval authorization and identity', () => {
  it('does not authorize inference without an explicit run mode and reviewed binary hash', () => {
    expect(() => parseArgs([])).toThrow(/mode/i)
    expect(() => parseArgs(['--run'])).toThrow(/binary/i)
    expect(() => parseArgs(['--run', '--binary', '/tmp/server', '--binary-sha256', 'wrong'])).toThrow(/sha256/i)
    expect(parseArgs(['--check'])).toMatchObject({ mode: 'check' })
  })

  it('accepts an exact reviewed binary but refuses a byte-changed executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'metis-eval-binary-'))
    roots.push(root)
    const path = join(root, 'llama-server')
    writeFileSync(path, 'synthetic binary', { mode: 0o700 })
    const digest = createHash('sha256').update('synthetic binary').digest('hex')
    expect(verifyBinary(path, digest)).toMatchObject({ path, sha256: digest, bytes: 16 })
    writeFileSync(path, 'changed')
    expect(() => verifyBinary(path, digest)).toThrow(/hash/i)
  })

  it('does not inherit provider credentials or the real HOME into the isolated runner', () => {
    expect(cleanEnvironment('/tmp/synthetic-profile', { PATH: '/bin', HOME: '/real/home', OPENAI_API_KEY: 'synthetic-secret', NODE_OPTIONS: '--require danger', SystemRoot: 'C:\\Windows' })).toEqual({
      PATH: '/bin', SystemRoot: 'C:\\Windows', HOME: '/tmp/synthetic-profile', USERPROFILE: '/tmp/synthetic-profile',
      APPDATA: '/tmp/synthetic-profile', LOCALAPPDATA: '/tmp/synthetic-profile', ASKTOTO_USERDATA: '/tmp/synthetic-profile', METIS_DISABLE_APPLE_FM: '1'
    })
  })
})

describe('loopback-only inference boundary', () => {
  it('denies remote, credentialed, redirect-prone and unowned-local requests before transport', async () => {
    let calls = 0
    const fetch = guardedFetch(async () => { calls++; return new Response('ok') }, new Set([54321]))
    for (const url of ['https://example.invalid', 'http://127.0.0.1:54322/health', 'http://localhost:54321/health', 'http://user:pass@127.0.0.1:54321/health']) {
      await expect(fetch(url)).rejects.toThrow(/denied/i)
    }
    expect(calls).toBe(0)
  })

  it('preserves the actual serialized body, forbids redirects and never captures headers', async () => {
    const requests: unknown[] = []
    const seen: RequestInit[] = []
    const fetch = guardedFetch(async (_url: unknown, init: RequestInit) => { seen.push(init); return new Response('{}') }, new Set([54321]), (record: unknown) => requests.push(record))
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'Synthetic meeting' }], stream: true, id_slot: 1, cache_prompt: true, max_tokens: 512 })
    await fetch('http://127.0.0.1:54321/v1/chat/completions', { method: 'POST', body, headers: { authorization: 'Bearer synthetic-secret' } })
    expect(seen[0]).toMatchObject({ body, redirect: 'error' })
    expect(requests).toEqual([{ path: '/v1/chat/completions', body: JSON.parse(body) }])
    expect(JSON.stringify(requests)).not.toContain('synthetic-secret')
  })
})

describe('owned native lifecycle', () => {
  it('aborts and settles a drip-feeding case at the hard wall-clock deadline', async () => {
    vi.useFakeTimers()
    const abort = vi.fn()
    try {
      const result = withHardDeadline(() => new Promise(() => {}), abort, 180_000)
      const rejection = expect(result).rejects.toThrow(/hard deadline/i)
      await vi.advanceTimersByTimeAsync(179_999)
      expect(abort).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await rejection
      expect(abort).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('clears a successful case deadline without aborting an unrelated later request', async () => {
    vi.useFakeTimers()
    const abort = vi.fn()
    try {
      await expect(withHardDeadline(async () => 'complete', abort, 180_000)).resolves.toBe('complete')
      await vi.advanceTimersByTimeAsync(180_001)
      expect(abort).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('keeps the external network blocked until asynchronous cleanup completes, even on a case error', async () => {
    const original = globalThis.fetch
    const transport = vi.fn(async () => new Response('ok'))
    let cleanupObserved = false
    await expect(withGuardedNetwork(transport, new Set([54321]), () => {}, async () => { throw new Error('case failed') }, async () => {
      await Promise.resolve()
      await expect(globalThis.fetch('https://example.invalid')).rejects.toThrow(/denied/i)
      cleanupObserved = true
    })).rejects.toThrow('case failed')
    expect(cleanupObserved).toBe(true)
    expect(transport).not.toHaveBeenCalled()
    expect(globalThis.fetch).toBe(original)
  })

  it('reaps its own live child and does not terminate another process', async () => {
    const owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    try {
      await reapOwnedChildren([owned])
      expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true)
      expect(unrelated.exitCode).toBeNull()
      expect(unrelated.signalCode).toBeNull()
    } finally {
      for (const child of [owned, unrelated]) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
          child.kill('SIGKILL')
          await exited
        }
      }
    }
  })
})

describe('frozen source identity', () => {
  it('passes large source snapshots through a private config file, not an oversized environment value', () => {
    const root = mkdtempSync(join(tmpdir(), 'metis-eval-config-'))
    roots.push(root)
    const config = { sourceSnapshot: { files: 'synthetic-source-hash'.repeat(5000) } }
    const env = writeRunConfig(root, config)
    expect(JSON.stringify(env).length).toBeLessThan(1024)
    expect(JSON.parse(readFileSync(env.METIS_LOCAL_RECAP_CONFIG, 'utf8'))).toEqual(config)
    expect(() => writeRunConfig(root, config)).toThrow()
  })

  it('records exact input bytes and fails when a source changes, even without a new git commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'metis-eval-source-'))
    roots.push(root)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'local.ts'), 'first source')
    const snapshot = snapshotFiles(root, ['src'])
    expect(snapshot.files).toEqual([{ path: 'src/local.ts', bytes: 12, sha256: createHash('sha256').update('first source').digest('hex') }])
    expect(() => assertSnapshot(root, snapshot)).not.toThrow()
    writeFileSync(join(root, 'src', 'local.ts'), 'changed source')
    expect(() => assertSnapshot(root, snapshot)).toThrow(/source.*changed/i)
  })
})
