import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

// cli-installer.ts imports `app` from electron for userData path resolution — mock it the same way
// secrets-local-keystore.test.ts does (repo's __mocks__/electron.ts automock, getPath overridden per test).
vi.mock('electron')

import { app } from 'electron'
import {
  installManagedCli,
  managedCliEntry,
  managedCliCommand,
  MANAGED_CLIS,
  MIN_NATIVE_CLI_BYTES,
  isJsCliEntry,
  resolveClaudeNativePlatform,
  type CliInstallProgress
} from './cli-installer'

// ─── tarBuilder test helper: hand-assembled ustar tar buffer ────────────────────────
// Mirrors exactly the field layout cli-installer.ts's vendored reader expects (name @0/100,
// size-octal @124/12, typeflag @156, ustar magic @257, prefix @345/155). Every fixture name here is
// short enough to fit the 100-byte name field directly, so prefix is always left empty.

const TAR_BLOCK = 512

function tarHeader(name: string, size: number, type: '0' | '5'): Buffer {
  const header = Buffer.alloc(TAR_BLOCK, 0)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii') // mode
  header.write('0000000\0', 108, 8, 'ascii') // uid
  header.write('0000000\0', 116, 8, 'ascii') // gid
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii') // mtime
  header.write('        ', 148, 8, 'ascii') // checksum (unchecked by the vendored reader)
  header[156] = type.charCodeAt(0)
  header.write('ustar\0' + '00', 257, 8, 'ascii') // magic + version
  return header
}

function tarEntry(name: string, content: string, type: '0' | '5' = '0'): Buffer {
  if (type === '5') return tarHeader(name, 0, type)
  const data = Buffer.from(content, 'utf8')
  const header = tarHeader(name, data.length, type)
  const padLen = (TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK
  return Buffer.concat([header, data, Buffer.alloc(padLen, 0)])
}

function buildTarball(entries: Array<{ name: string; content: string; type?: '0' | '5' }>): Buffer {
  const parts = entries.map((e) => tarEntry(e.name, e.content, e.type ?? '0'))
  return Buffer.concat([...parts, Buffer.alloc(TAR_BLOCK * 2, 0)]) // two zero blocks = end-of-archive
}

function sha512Integrity(buf: Buffer): string {
  return 'sha512-' + createHash('sha512').update(buf).digest('base64')
}

/** A ReadableStream that delivers `chunks` one at a time via pull(), invoking `onBeforeChunk(i)`
 *  synchronously before each chunk is enqueued — used by the abort test to flip an AbortSignal at an
 *  exact point mid-stream. */
function chunkedStream(chunks: Uint8Array[], onBeforeChunk?: (i: number) => void): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(streamController) {
      if (i >= chunks.length) {
        streamController.close()
        return
      }
      onBeforeChunk?.(i)
      streamController.enqueue(chunks[i])
      i++
    }
  })
}

// ─── fixtures ────────────────────────────────────────────────────────────────────

let userData: string

function registryResponse(json: unknown): Response {
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'asktoto-cli-installer-test-'))
  ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
    name === 'userData' ? userData : join(userData, name)
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(userData, { recursive: true, force: true })
})

describe('installManagedCli — happy path', () => {
  it('installs end-to-end: ordered progress phases, entry on disk, managedCliEntry + managedCliCommand', async () => {
    const version = '9.9.9'
    const tgz = gzipSync(
      buildTarball([
        { name: 'package/cli.js', content: '#!/usr/bin/env node\nconsole.log("hi")\n' },
        { name: 'package/package.json', content: JSON.stringify({ name: MANAGED_CLIS.claude.npmPackage, version }) }
      ])
    )
    const registryJson = {
      version,
      dist: { tarball: 'https://example.invalid/claude-code-9.9.9.tgz', integrity: sha512Integrity(tgz) }
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/latest')) return registryResponse(registryJson)
        return new Response(tgz, { status: 200, headers: { 'content-length': String(tgz.length) } })
      })
    )

    const progress: CliInstallProgress[] = []
    const result = await installManagedCli('claude', (p) => progress.push(p))

    expect(result.version).toBe(version)
    expect(existsSync(result.entry)).toBe(true)
    expect(result.entry.endsWith(join('package', 'cli.js'))).toBe(true)

    const phases = progress.map((p) => p.phase)
    expect(phases[0]).toBe('resolving')
    expect(phases).toContain('downloading')
    expect(phases.indexOf('verifying')).toBeGreaterThan(phases.lastIndexOf('downloading'))
    expect(phases.indexOf('extracting')).toBeGreaterThan(phases.indexOf('verifying'))
    expect(phases[phases.length - 1]).toBe('done')
    expect(phases).not.toContain('error')

    expect(managedCliEntry('claude')).toEqual({ entry: result.entry, version })

    expect(managedCliCommand('claude')).toEqual({
      command: process.execPath,
      args: [result.entry],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    // codex was never installed in this test — its command lookup must independently report null.
    expect(managedCliCommand('codex')).toBeNull()
  })
})

describe('installManagedCli — integrity verification', () => {
  it('a sha512 mismatch is a hard error and leaves nothing installed', async () => {
    const version = '1.0.0'
    const tgz = gzipSync(buildTarball([{ name: 'package/cli.js', content: 'console.log(1)\n' }]))
    const wrongIntegrity = sha512Integrity(Buffer.from('these-are-not-the-real-tarball-bytes'))
    const registryJson = { version, dist: { tarball: 'https://example.invalid/x.tgz', integrity: wrongIntegrity } }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/latest')) return registryResponse(registryJson)
        return new Response(tgz, { status: 200, headers: { 'content-length': String(tgz.length) } })
      })
    )

    const progress: CliInstallProgress[] = []
    await expect(installManagedCli('claude', (p) => progress.push(p))).rejects.toThrow(/integrity/i)

    const last = progress[progress.length - 1]
    expect(last.phase).toBe('error')
    expect(last.error).toMatch(/integrity/i)
    expect(progress.some((p) => p.phase === 'extracting')).toBe(false)

    expect(managedCliEntry('claude')).toBeNull()
    expect(existsSync(join(userData, 'managed-cli', 'claude'))).toBe(false)
  })
})

describe('installManagedCli — zip-slip protection', () => {
  it('an entry path containing ".." aborts the install with nothing left on disk', async () => {
    const version = '2.0.0'
    const tgz = gzipSync(
      buildTarball([
        { name: 'package/cli.js', content: 'console.log(1)\n' },
        { name: 'package/../evil.js', content: 'pwned\n' }
      ])
    )
    const registryJson = { version, dist: { tarball: 'https://example.invalid/x.tgz', integrity: sha512Integrity(tgz) } }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/latest')) return registryResponse(registryJson)
        return new Response(tgz, { status: 200, headers: { 'content-length': String(tgz.length) } })
      })
    )

    await expect(installManagedCli('claude', () => {})).rejects.toThrow(/unsafe tar entry/i)

    expect(managedCliEntry('claude')).toBeNull()
    expect(existsSync(join(userData, 'evil.js'))).toBe(false)
    expect(existsSync(join(userData, 'managed-cli', 'evil.js'))).toBe(false)

    const claudeRoot = join(userData, 'managed-cli', 'claude')
    // Either the root was never created, or it was created (as a mkdirSync(recursive) side effect of
    // the scratch tmp dir) and then fully cleaned back out — either way, nothing survives.
    if (existsSync(claudeRoot)) {
      expect(readdirSync(claudeRoot)).toEqual([])
    }
  })
})

describe('installManagedCli — cancellation', () => {
  it('aborting mid-download reports phase "error" with error "cancelled" and leaves no version dir', async () => {
    const version = '3.0.0'
    const tgz = gzipSync(buildTarball([{ name: 'package/cli.js', content: 'console.log(1)\n'.repeat(20) }]))
    const registryJson = { version, dist: { tarball: 'https://example.invalid/x.tgz', integrity: sha512Integrity(tgz) } }

    const controller = new AbortController()
    const mid = Math.floor(tgz.length / 2)
    const chunk1 = tgz.subarray(0, mid)
    const chunk2 = tgz.subarray(mid)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/latest')) return registryResponse(registryJson)
        const stream = chunkedStream([chunk1, chunk2], (i) => {
          if (i === 1) controller.abort() // flip the signal right before the 2nd chunk is delivered
        })
        return new Response(stream, { status: 200, headers: { 'content-length': String(tgz.length) } })
      })
    )

    const progress: CliInstallProgress[] = []
    await expect(installManagedCli('claude', (p) => progress.push(p), controller.signal)).rejects.toThrow('cancelled')

    const last = progress[progress.length - 1]
    expect(last.phase).toBe('error')
    expect(last.error).toBe('cancelled')

    expect(managedCliEntry('claude')).toBeNull()
    expect(existsSync(join(userData, 'managed-cli', 'claude'))).toBe(false)
  })
})

describe('installManagedCli — download ETA', () => {
  it('emits a finite etaMs once at least 2 progress samples exist', async () => {
    const version = '4.0.0'
    const tgz = gzipSync(buildTarball([{ name: 'package/cli.js', content: 'console.log(1)\n'.repeat(50) }]))
    const registryJson = { version, dist: { tarball: 'https://example.invalid/x.tgz', integrity: sha512Integrity(tgz) } }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/latest')) return registryResponse(registryJson)
        return new Response(tgz, { status: 200, headers: { 'content-length': String(tgz.length) } })
      })
    )

    // Force every progress tick past the 250ms throttle deterministically, with no real waiting.
    let t = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 300))

    const progress: CliInstallProgress[] = []
    await installManagedCli('claude', (p) => progress.push(p))

    const downloadEvents = progress.filter((p) => p.phase === 'downloading')
    expect(downloadEvents.length).toBeGreaterThanOrEqual(2)
    // The very first sample (0 bytes received) can't have a rate yet; a later one must.
    expect(downloadEvents[0].etaMs).toBeNull()
    expect(downloadEvents.some((p) => typeof p.etaMs === 'number' && Number.isFinite(p.etaMs))).toBe(true)
  })
})

describe('resolveClaudeNativePlatform / isJsCliEntry', () => {
  it('maps Windows x64 to the win32-x64 native package', () => {
    expect(resolveClaudeNativePlatform('win32', 'x64')).toEqual({
      npmPackage: '@anthropic-ai/claude-code-win32-x64',
      binaryName: 'claude.exe'
    })
  })

  it('maps darwin arm64 and linux musl variants', () => {
    expect(resolveClaudeNativePlatform('darwin', 'arm64')?.npmPackage).toBe('@anthropic-ai/claude-code-darwin-arm64')
    expect(resolveClaudeNativePlatform('linux', 'x64', true)?.npmPackage).toBe(
      '@anthropic-ai/claude-code-linux-x64-musl'
    )
  })

  it('treats .js/.cjs/.mjs as JS entries and native binaries as not', () => {
    expect(isJsCliEntry('/x/package/cli.js')).toBe(true)
    expect(isJsCliEntry('/x/package/cli-wrapper.cjs')).toBe(true)
    expect(isJsCliEntry('/x/package/bin/claude.exe')).toBe(false)
    expect(isJsCliEntry('/x/package/bin/claude')).toBe(false)
  })
})

describe('installManagedCli — modern Claude Code native layout', () => {
  it('fetches the platform package, replaces the stub, and returns a native spawn command', async () => {
    const version = '2.1.258'
    const stub = 'S'.repeat(500)
    const native = 'N'.repeat(MIN_NATIVE_CLI_BYTES + 64)
    const host = resolveClaudeNativePlatform(process.platform, process.arch, false)
    expect(host).not.toBeNull()
    if (!host) throw new Error('unsupported test host platform')

    const wrapperTgz = gzipSync(
      buildTarball([
        {
          name: 'package/package.json',
          content: JSON.stringify({
            name: '@anthropic-ai/claude-code',
            version,
            bin: { claude: `bin/${host.binaryName}` }
          })
        },
        { name: `package/bin/${host.binaryName}`, content: stub }
      ])
    )
    const platformTgz = gzipSync(
      buildTarball([
        {
          name: 'package/package.json',
          content: JSON.stringify({ name: host.npmPackage, version })
        },
        { name: `package/${host.binaryName}`, content: native }
      ])
    )

    const wrapperMeta = {
      version,
      dist: { tarball: 'https://example.invalid/wrapper.tgz', integrity: sha512Integrity(wrapperTgz) }
    }
    const platformMeta = {
      version,
      dist: { tarball: 'https://example.invalid/platform.tgz', integrity: sha512Integrity(platformTgz) }
    }
    const platformPathToken = host.npmPackage.replace('/', '%2f')

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.includes(platformPathToken) && url.includes(`/${version}`)) {
          return registryResponse(platformMeta)
        }
        if (url.endsWith('/latest')) {
          return registryResponse(wrapperMeta)
        }
        if (url.includes('wrapper.tgz')) {
          return new Response(wrapperTgz, { status: 200, headers: { 'content-length': String(wrapperTgz.length) } })
        }
        if (url.includes('platform.tgz')) {
          return new Response(platformTgz, { status: 200, headers: { 'content-length': String(platformTgz.length) } })
        }
        return new Response(`unexpected fetch ${url}`, { status: 500 })
      })
    )

    const progress: CliInstallProgress[] = []
    const result = await installManagedCli('claude', (p) => progress.push(p))

    expect(result.version).toBe(version)
    expect(existsSync(result.entry)).toBe(true)
    expect(result.entry.endsWith(join('package', 'bin', host.binaryName))).toBe(true)
    expect(statSync(result.entry).size).toBe(native.length)

    expect(managedCliCommand('claude')).toEqual({ command: result.entry, args: [], env: {} })
    expect(progress.map((p) => p.phase)).toContain('downloading')
    expect(progress[progress.length - 1].phase).toBe('done')
  })

  it('still errors clearly when neither cli.js nor a package.json bin exists', async () => {
    const version = '2.1.258'
    const tgz = gzipSync(
      buildTarball([
        {
          name: 'package/package.json',
          content: JSON.stringify({ name: '@anthropic-ai/claude-code', version })
        }
      ])
    )
    const registryJson = {
      version,
      dist: { tarball: 'https://example.invalid/x.tgz', integrity: sha512Integrity(tgz) }
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/latest')) return registryResponse(registryJson)
        return new Response(tgz, { status: 200, headers: { 'content-length': String(tgz.length) } })
      })
    )
    await expect(installManagedCli('claude', () => {})).rejects.toThrow(/expected entry 'cli\.js' is missing/)
    expect(managedCliEntry('claude')).toBeNull()
  })
})
