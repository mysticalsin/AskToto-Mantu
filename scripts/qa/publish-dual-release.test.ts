import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGitHubTransport, persistReceipt, publishDualRelease, readStage } from './publish-dual-release.mjs'

const SOURCE = 'mysticalsin/AskToto-Mantu'
const FEED = 'mysticalsin/Metis-Releases'
const COMMIT = 'a'.repeat(40)
const FEED_COMMIT = 'b'.repeat(40)
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const manifest = [{ name: 'Metis-1.9.7.zip', size: 5, sha256: digest('bytes') }]
const options = {
  version: '1.9.7',
  candidateRun: '100',
  candidateCommit: COMMIT,
  promotionRun: '200',
  promotionAttempt: '2',
  publish: true,
  manifest,
  manifestSha256: digest(JSON.stringify(manifest)),
  notes: 'Synthetic release notes. Unsigned, manual install only.'
}

type Asset = (typeof manifest)[number]
type Call = {
  repository: string
  route: string
  method?: string
  json?: Record<string, unknown>
  asset?: Asset
}
type Response = { status: number; data: unknown }
type Release = Record<string, unknown> & { id: number; tag_name: string; draft: boolean }
type Result = Awaited<ReturnType<typeof publishDualRelease>>
type Receipt = NonNullable<Result['receipt']>
type Event = { kind: string; call?: Call; receipt?: Receipt }
type Hooks = {
  request?: (call: Call) => Response | undefined
  persist?: (receipt: Receipt) => void
}

function harness(hooks: Hooks = {}) {
  const events: Event[] = []
  const releases = new Map<string, Release>()
  const assets = new Map<string, Record<string, unknown>[]>()
  const tags = new Map<string, string>()
  const receipts: Receipt[] = []
  const request = async (call: Call): Promise<Response> => {
    events.push({ kind: 'request', call: structuredClone(call) })
    const override = hooks.request?.(call)
    if (override) return override
    const { repository, route, method = 'GET', json } = call
    const release = releases.get(repository)
    if (method === 'GET' && route === '') {
      return { status: 200, data: { full_name: repository, permissions: { push: true }, default_branch: 'main' } }
    }
    if (method === 'GET' && route === 'releases/latest') {
      return { status: 200, data: { id: 900, tag_name: 'v1.0.0', draft: false, prerelease: false } }
    }
    if (method === 'GET' && route.startsWith('git/ref/tags/')) {
      const tag = decodeURIComponent(route.slice('git/ref/tags/'.length))
      const sha = tags.get(`${repository}:${tag}`)
      return sha
        ? { status: 200, data: { ref: `refs/tags/${tag}`, object: { type: 'commit', sha } } }
        : { status: 404, data: null }
    }
    if (method === 'GET' && route.startsWith('commits/')) {
      const ref = decodeURIComponent(route.slice('commits/'.length))
      let sha: string | undefined = repository === SOURCE ? COMMIT : FEED_COMMIT
      if (ref.startsWith('refs/tags/')) sha = tags.get(`${repository}:${ref.slice('refs/tags/'.length)}`)
      return sha ? { status: 200, data: { sha } } : { status: 404, data: null }
    }
    if (method === 'GET' && route.startsWith('releases?')) {
      return { status: 200, data: release && route.endsWith('page=1') ? [release] : [] }
    }
    if (method === 'POST' && route === 'releases') {
      const created = { ...json, id: repository === SOURCE ? 10 : 20 } as Release
      releases.set(repository, created)
      assets.set(repository, [])
      return { status: 201, data: structuredClone(created) }
    }
    if (method === 'POST' && route.includes('/assets?') && call.asset) {
      const asset = {
        id: (assets.get(repository)?.length ?? 0) + 1,
        name: call.asset.name,
        size: call.asset.size,
        state: 'uploaded',
        digest: `sha256:${call.asset.sha256}`
      }
      assets.get(repository)!.push(asset)
      return { status: 201, data: asset }
    }
    if (method === 'GET' && route.includes('/assets?')) {
      const page = Number(new URL(`https://example.invalid/${route}`).searchParams.get('page'))
      return { status: 200, data: structuredClone((assets.get(repository) ?? []).slice((page - 1) * 100, page * 100)) }
    }
    if (method === 'GET' && release && route === `releases/${release.id}`) {
      return { status: 200, data: structuredClone(release) }
    }
    if (method === 'PATCH' && release && route === `releases/${release.id}`) {
      Object.assign(release, json)
      tags.set(`${repository}:${release.tag_name}`, String(release.target_commitish))
      return { status: 200, data: structuredClone(release) }
    }
    if (method === 'DELETE' && release && route === `releases/${release.id}`) {
      releases.delete(repository)
      return { status: 204, data: null }
    }
    throw new Error('Unexpected synthetic request')
  }
  const persist = async (receipt: Receipt): Promise<void> => {
    events.push({ kind: 'receipt', receipt: structuredClone(receipt) })
    hooks.persist?.(receipt)
    receipts.push(structuredClone(receipt))
  }
  return { request, persist, events, releases, assets, tags, receipts }
}

type Harness = ReturnType<typeof harness>
const calls = (h: Harness): Call[] => h.events.flatMap((event) => (event.call ? [event.call] : []))
const writes = (h: Harness): Call[] => calls(h).filter((call) => call.method !== undefined && call.method !== 'GET')
const run = (h: Harness, overrides = {}): ReturnType<typeof publishDualRelease> =>
  publishDualRelease({ ...options, ...overrides }, { request: h.request, persist: h.persist })
const receiptOf = (result: Result): Receipt => {
  if (!result.receipt) throw new Error('Expected a closed receipt')
  return result.receipt
}

describe('dual repository promotion', () => {
  it('publishes identical bytes only after both complete manifests and draft identities verify', async () => {
    const h = harness()
    const result = await run(h)
    expect(result.ok).toBe(true)
    expect(receiptOf(result).outcome).toBe('published')
    expect(result.urls).toEqual([
      `https://github.com/${SOURCE}/releases/tag/metis-unsigned-v1.9.7`,
      `https://github.com/${FEED}/releases/tag/v1.9.7`
    ])
    const creates = writes(h).filter((call) => call.route === 'releases')
    expect(creates.map((call) => call.repository)).toEqual([SOURCE, FEED])
    expect(creates.map((call) => call.json)).toEqual([
      {
        tag_name: 'metis-unsigned-v1.9.7',
        target_commitish: COMMIT,
        name: 'Métis 1.9.7 (unsigned, manual install)',
        body: options.notes,
        draft: true,
        prerelease: true,
        make_latest: 'false'
      },
      {
        tag_name: 'v1.9.7',
        target_commitish: FEED_COMMIT,
        name: 'Métis 1.9.7 (unsigned, manual install)',
        body: options.notes,
        draft: true,
        prerelease: true,
        make_latest: 'false'
      }
    ])
    const firstPublish = h.events.findIndex((event) => event.call?.method === 'PATCH')
    for (const repository of [SOURCE, FEED]) {
      const before = h.events.slice(0, firstPublish).flatMap((event) => (event.call ? [event.call] : []))
      expect(
        before.filter(
          (call) => call.repository === repository && call.route.includes('/assets?') && call.route.endsWith('page=1')
        )
      ).toHaveLength(2)
      const uploaded = writes(h).filter((call) => call.repository === repository && call.asset)
      expect(uploaded.map((call) => call.asset)).toEqual(manifest)
    }
    expect(h.events.slice(0, firstPublish).some((event) => event.receipt?.publication_attempted === true)).toBe(true)
    const publications = writes(h).filter((call) => call.method === 'PATCH')
    expect(publications.map((call) => call.json)).toEqual([
      { draft: false, prerelease: true, make_latest: 'false' },
      { draft: false, prerelease: true, make_latest: 'false' }
    ])
    expect(writes(h).some((call) => call.method === 'DELETE')).toBe(false)
    expect(receiptOf(result).targets.map((target) => target.release_id)).toEqual([10, 20])
    expect(h.receipts.every((receipt) => !JSON.stringify(receipt).includes(options.notes))).toBe(true)
  })

  it('uses invocation-unique dry-run tags and deletes only freshly revalidated owned drafts', async () => {
    const h = harness()
    const result = await run(h, { publish: false })
    expect(result.ok).toBe(true)
    expect(receiptOf(result).outcome).toBe('dry-run')
    expect(result.urls).toEqual([])
    expect(writes(h).filter((call) => call.method === 'PATCH')).toEqual([])
    const creates = writes(h).filter((call) => call.route === 'releases')
    expect(creates.map((call) => call.json?.tag_name)).toEqual([
      'metis-unsigned-v1.9.7.dryrun.100.200.2',
      'v1.9.7.dryrun.100.200.2'
    ])
    const deletions = writes(h).filter((call) => call.method === 'DELETE')
    expect(deletions.map((call) => call.route)).toEqual(['releases/10', 'releases/20'])
    for (const [index, event] of h.events.entries()) {
      if (event.call?.method !== 'DELETE') continue
      const prior = h.events.slice(0, index).reverse().find((item) => item.call)
      expect(prior?.call).toEqual({ repository: event.call.repository, route: event.call.route })
    }
  })

  it.each([
    { manifest: [...manifest, manifest[0]] },
    { manifest: [{ ...manifest[0], name: '../secret' }] },
    { manifest: [{ ...manifest[0], name: 'latest.yml' }] },
    { manifest: [{ ...manifest[0], name: 'file.blockmap' }] },
    { manifest: [{ ...manifest[0], size: -1 }] },
    { manifest: [{ ...manifest[0], sha256: 'bad' }] },
    { manifest: [] },
    { version: '2.0\nspoof' },
    { candidateCommit: 'main' },
    { promotionAttempt: '0' },
    { publish: 'true' }
  ])('rejects invalid input without remote mutations: %j', async (override) => {
    const h = harness()
    const result = await run(h, override)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('input-invalid')
    expect(writes(h)).toEqual([])
  })

  it.each([SOURCE, FEED])('refuses mismatched or unreadable repository identity: %s', async (repository) => {
    const h = harness({
      request: (call) =>
        call.repository === repository && call.route === ''
          ? { status: 200, data: { full_name: 'other/repo', permissions: { push: true }, default_branch: 'main' } }
          : undefined
    })
    expect((await run(h)).code).toBe('repository-identity')
    expect(writes(h)).toEqual([])
  })

  it.each([undefined, false])('refuses ambiguous draft visibility (%s)', async (push) => {
    const h = harness({
      request: (call) =>
        call.route === ''
          ? { status: 200, data: { full_name: call.repository, permissions: { push }, default_branch: 'main' } }
          : undefined
    })
    expect((await run(h)).code).toBe('repository-identity')
    expect(writes(h)).toEqual([])
  })

  it.each([404, 403, 500])('refuses latest lookup %i before any create', async (status) => {
    const h = harness({ request: (call) => (call.route === 'releases/latest' ? { status, data: null } : undefined) })
    expect((await run(h)).ok).toBe(false)
    expect(writes(h)).toEqual([])
  })

  it('refuses malformed latest metadata before any create', async () => {
    const h = harness({
      request: (call) => (call.route === 'releases/latest' ? { status: 200, data: { id: 900 } } : undefined)
    })
    expect((await run(h)).code).toBe('latest-identity')
    expect(writes(h)).toEqual([])
  })

  it.each([false, true])('refuses an existing release, including draft=%s', async (draft) => {
    const h = harness({
      request: (call) =>
        call.route.startsWith('releases?') && call.route.endsWith('page=1')
          ? { status: 200, data: [{ id: 33, tag_name: 'metis-unsigned-v1.9.7', draft, prerelease: true }] }
          : undefined
    })
    expect((await run(h)).code).toBe('release-exists')
    expect(writes(h)).toEqual([])
  })

  it('refuses pre-existing tags independently of release listings', async () => {
    const h = harness()
    h.tags.set(`${SOURCE}:metis-unsigned-v1.9.7`, COMMIT)
    expect((await run(h)).code).toBe('tag-exists')
    expect(writes(h)).toEqual([])
  })

  it('checks later release pages and does not interpret the first 100 entries as complete', async () => {
    const h = harness({
      request: (call) => {
        if (!call.route.startsWith('releases?')) return undefined
        let data: Release[] = []
        if (call.route.endsWith('page=1')) {
          data = Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            tag_name: `old-${i}`,
            draft: false,
            prerelease: false
          }))
        } else if (call.route.endsWith('page=2')) {
          data = [{ id: 101, tag_name: 'metis-unsigned-v1.9.7', draft: true, prerelease: true }]
        }
        return {
          status: 200,
          data
        }
      }
    })
    expect((await run(h)).code).toBe('release-exists')
    expect(calls(h).some((call) => call.route.endsWith('page=2'))).toBe(true)
    expect(writes(h)).toEqual([])
  })

  it.each(['shape', 'duplicate', 'ceiling'])('fails closed on pagination %s', async (mode) => {
    const h = harness({
      request: (call) => {
        if (!call.route.startsWith('releases?')) return undefined
        if (mode === 'shape') return { status: 200, data: { items: [] } }
        const page = Number(new URL(`https://example.invalid/${call.route}`).searchParams.get('page'))
        return {
          status: 200,
          data: Array.from({ length: 100 }, (_, i) => ({
            id: mode === 'duplicate' ? i + 1 : (page - 1) * 100 + i + 1,
            tag_name: `old-${page}-${i}`,
            draft: false,
            prerelease: false
          }))
        }
      }
    })
    expect((await run(h)).ok).toBe(false)
    expect(writes(h)).toEqual([])
    expect(calls(h).filter((call) => call.route.startsWith('releases?')).length).toBeLessThanOrEqual(100)
  })

  it('verifies every asset beyond the first page on both destinations', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ ...manifest[0], name: `asset-${i}.zip` }))
    const h = harness()
    const result = await run(h, { manifest: many, manifestSha256: digest(JSON.stringify(many)) })
    expect(result.ok).toBe(true)
    for (const repository of [SOURCE, FEED]) {
      expect(writes(h).filter((call) => call.repository === repository && call.asset)).toHaveLength(101)
      const secondPages = calls(h).filter(
        (call) => call.repository === repository && call.route.includes('/assets?') && call.route.endsWith('page=2')
      )
      expect(secondPages).toHaveLength(3)
    }
  })

  it('never adopts a tag-matched release after an unknown create outcome', async () => {
    const h = harness({
      request: (call) => {
        if (call.method === 'POST' && call.route === 'releases') throw new Error('synthetic secret response')
        return undefined
      }
    })
    const result = await run(h)
    expect(result.ok).toBe(false)
    expect(receiptOf(result).targets[0].state).toBe('unknown')
    expect(receiptOf(result).targets[0].release_id).toBeNull()
    expect(writes(h)).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('synthetic secret response')
  })

  it('does not adopt or delete the unknown second create, but may clean up its acknowledged first draft', async () => {
    const h = harness({
      request: (call) => {
        if (call.repository === FEED && call.method === 'POST' && call.route === 'releases') {
          throw new Error('lost second create response')
        }
        return undefined
      }
    })
    const result = await run(h)
    expect(result.ok).toBe(false)
    expect(receiptOf(result).targets[1]).toMatchObject({ release_id: null, state: 'unknown' })
    const deletions = writes(h).filter((call) => call.method === 'DELETE')
    expect(deletions.map((call) => call.repository)).toEqual([SOURCE])
    expect(writes(h).some((call) => call.method === 'PATCH' || call.asset)).toBe(false)
  })

  it.each([{ id: '10' }, { id: 10, draft: false }, { id: 10, tag_name: 'different' }])(
    'does not claim ownership from a malformed create acknowledgement: %j',
    async (override) => {
      const h = harness({
        request: (call) =>
          call.method === 'POST' && call.route === 'releases'
            ? { status: 201, data: { ...call.json, ...override } }
            : undefined
      })
      const result = await run(h)
      expect(result.code).toBe('release-identity')
      expect(receiptOf(result).targets[0]).toMatchObject({ release_id: null, state: 'unknown' })
      expect(writes(h)).toHaveLength(1)
    }
  )

  it.each(['first-create', 'second-create', 'uploaded', 'before-patch'])(
    'preserves drafts after receipt failure: %s',
    async (when) => {
      const h = harness({
        persist: (receipt) => {
          const targets = receipt.targets
          const fail =
            when === 'first-create'
              ? targets[0]?.state === 'draft'
              : when === 'second-create'
                ? targets[1]?.state === 'draft'
                : when === 'uploaded'
                  ? targets.some((target) => target.state === 'uploaded')
                  : receipt.publication_attempted === true
          if (fail) throw new Error('synthetic receipt failure')
        }
      })
      const result = await run(h)
      expect(result.ok).toBe(false)
      expect(result.code).toBe('receipt-write-failed')
      const failedIndex = h.events.findLastIndex((event) => event.kind === 'receipt')
      expect(h.events.slice(failedIndex + 1).filter((event) => event.call?.method)).toEqual([])
      expect(writes(h).some((call) => call.method === 'PATCH' || call.method === 'DELETE')).toBe(false)
      expect(h.releases.size).toBe(when === 'first-create' ? 1 : 2)
    }
  )

  it('retains the primary upload error and a separate cleanup error', async () => {
    const h = harness({
      request: (call) =>
        call.asset || call.method === 'DELETE' ? { status: 500, data: { private: 'must not escape' } } : undefined
    })
    const result = await run(h)
    expect(result.ok).toBe(false)
    expect(receiptOf(result).failure).toMatchObject({ phase: 'upload' })
    expect(receiptOf(result).cleanup_errors).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain('must not escape')
  })

  it.each(['digest', 'size', 'state', 'duplicate'])(
    'rejects uploaded asset %s mismatch before publication',
    async (field) => {
      const h = harness({
        request: (call) => {
          if (call.method || !call.route.includes('/assets?')) return undefined
          const asset = {
            id: 1,
            name: manifest[0].name,
            size: 5,
            digest: `sha256:${manifest[0].sha256}`,
            state: 'uploaded'
          }
          const changed =
            field === 'digest'
              ? { ...asset, digest: `sha256:${'0'.repeat(64)}` }
              : field === 'size'
                ? { ...asset, size: 6 }
                : { ...asset, state: 'starter' }
          return {
            status: 200,
            data: !call.route.endsWith('page=1') ? [] : field === 'duplicate' ? [asset, asset] : [changed]
          }
        }
      })
      expect((await run(h)).ok).toBe(false)
      expect(writes(h).some((call) => call.method === 'PATCH')).toBe(false)
    }
  )

  it('rechecks tags after upload and refuses a changed source commit before publication', async () => {
    const h = harness({
      request: (call) => {
        if (call.asset && call.repository === FEED) h.tags.set(`${SOURCE}:metis-unsigned-v1.9.7`, 'c'.repeat(40))
        return undefined
      }
    })
    expect((await run(h)).code).toBe('tag-target')
    expect(writes(h).some((call) => call.method === 'PATCH')).toBe(false)
  })

  it.each(['body', 'name', 'draft', 'tag_name'])(
    'rechecks draft %s after upload and does not delete a changed identity',
    async (field) => {
      const h = harness({
        request: (call) => {
          if (call.asset && call.repository === FEED) {
            h.releases.get(SOURCE)![field] = field === 'draft' ? false : 'changed'
          }
          return undefined
        }
      })
      const result = await run(h)
      expect(result.ok).toBe(false)
      expect(writes(h).some((call) => call.method === 'PATCH')).toBe(false)
      expect(writes(h).some((call) => call.method === 'DELETE' && call.repository === SOURCE)).toBe(false)
    }
  )

  it.each([SOURCE, FEED])(
    'preserves both releases after an ambiguous publication response on %s',
    async (repository) => {
      const h = harness({
        request: (call) => {
          if (call.method === 'PATCH' && call.repository === repository) throw new Error('lost response')
          return undefined
        }
      })
      const result = await run(h)
      expect(result.ok).toBe(false)
      expect(receiptOf(result).outcome).toBe('partial-or-unknown')
      expect(result.urls).toEqual([])
      expect(h.releases.size).toBe(2)
      expect(writes(h).some((call) => call.method === 'DELETE')).toBe(false)
      expect(writes(h).filter((call) => call.method === 'PATCH')).toHaveLength(repository === SOURCE ? 1 : 2)
    }
  )

  it.each(['latest-auth', 'tag', 'assets'])(
    'does not claim delivery after failed published readback: %s',
    async (mode) => {
      const h = harness({
        request: (call) => {
          if (h.releases.get(FEED)?.draft !== false) return undefined
          if (mode === 'latest-auth' && call.route === 'releases/latest') return { status: 403, data: null }
          if (mode === 'tag' && call.route.startsWith('commits/refs')) {
            return { status: 200, data: { sha: 'c'.repeat(40) } }
          }
          if (mode === 'assets' && call.route.includes('/assets?')) return { status: 200, data: [] }
          return undefined
        }
      })
      const result = await run(h)
      expect(result.ok).toBe(false)
      expect(result.urls).toEqual([])
      expect(writes(h).some((call) => call.method === 'DELETE')).toBe(false)
    }
  )
})

const temporaryDirectories: string[] = []
function stageFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'metis-dual-release-test-'))
  temporaryDirectories.push(directory)
  mkdirSync(join(directory, 'upload'))
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(directory, 'notes.md'), options.notes)
  writeFileSync(join(directory, 'upload', manifest[0].name), 'bytes')
  return directory
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('staged bytes and receipt files', () => {
  it('checks the exact manifest bytes, regular files, sizes and streaming digests', async () => {
    const directory = stageFixture()
    const stage = await readStage(directory)
    expect(stage.manifest).toEqual(manifest)
    expect(stage.manifestSha256).toBe(digest(JSON.stringify(manifest)))
    expect(stage.notes).toBe(options.notes)
  })

  it.each(['size', 'hash', 'directory', 'symlink'])('refuses a staged %s mismatch', async (mode) => {
    const directory = stageFixture()
    const path = join(directory, 'upload', manifest[0].name)
    if (mode === 'size' || mode === 'hash') writeFileSync(path, mode === 'size' ? 'larger' : 'wrong')
    else {
      rmSync(path)
      if (mode === 'directory') mkdirSync(path)
      else symlinkSync(join(directory, 'notes.md'), path, 'file')
    }
    await expect(readStage(directory)).rejects.toThrow('stage-invalid')
  })

  it('atomically replaces the same owned receipt with cumulative state', async () => {
    const directory = stageFixture()
    const path = join(directory, 'receipt.json')
    await persistReceipt(path, { targets: [{ release_id: 10 }] })
    await persistReceipt(path, { targets: [{ release_id: 10 }, { release_id: 20 }] })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ targets: [{ release_id: 10 }, { release_id: 20 }] })
  })

  it('preserves an existing receipt and a temporary-file collision instead of adopting either', async () => {
    const directory = stageFixture()
    const path = join(directory, 'receipt.json')
    writeFileSync(path, 'previous')
    writeFileSync(`${path}.pending`, 'not-owned')
    await expect(persistReceipt(path, { targets: [] })).rejects.toThrow('receipt-write-failed')
    expect(readFileSync(path, 'utf8')).toBe('previous')
    expect(readFileSync(`${path}.pending`, 'utf8')).toBe('not-owned')
  })
})

describe('fixed GitHub transport', () => {
  function fakeHttp(status = 200, body = '{}') {
    const observed: { url: string; headers: Record<string, string>; method: string; bytes: Buffer[] }[] = []
    const request = (
      url: URL,
      init: { headers: Record<string, string>; method: string },
      callback: (response: PassThrough) => void
    ) => {
      const item = { url: url.href, ...init, bytes: [] as Buffer[] }
      observed.push(item)
      return new Writable({
        write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
          item.bytes.push(Buffer.from(chunk))
          done()
        },
        final(done: (error?: Error | null) => void) {
          const response = Object.assign(new PassThrough(), { statusCode: status })
          callback(response)
          response.end(body)
          done()
        }
      })
    }
    return { request: request as unknown as typeof httpsRequest, observed }
  }

  it('streams exact asset bytes to the fixed upload endpoint with a content length', async () => {
    const directory = stageFixture()
    const fake = fakeHttp(201, '{"id":1}')
    const request = createGitHubTransport({ token: 'synthetic-token', stageDir: directory, requestImpl: fake.request })
    const response = await request({
      repository: SOURCE,
      route: 'releases/10/assets?name=Metis-1.9.7.zip',
      method: 'POST',
      asset: manifest[0]
    })
    expect(response).toEqual({ status: 201, data: { id: 1 } })
    expect(fake.observed).toHaveLength(1)
    expect(fake.observed[0].url).toBe(
      `https://uploads.github.com/repos/${SOURCE}/releases/10/assets?name=Metis-1.9.7.zip`
    )
    expect(fake.observed[0].headers['Content-Length']).toBe('5')
    expect(Buffer.concat(fake.observed[0].bytes).toString()).toBe('bytes')
  })

  it('rejects changed bytes even if the endpoint would acknowledge the upload', async () => {
    const directory = stageFixture()
    writeFileSync(join(directory, 'upload', manifest[0].name), 'wrong')
    const fake = fakeHttp(201, '{"id":1}')
    const request = createGitHubTransport({ token: 'synthetic-token', stageDir: directory, requestImpl: fake.request })
    await expect(
      request({
        repository: SOURCE,
        route: 'releases/10/assets?name=Metis-1.9.7.zip',
        method: 'POST',
        asset: manifest[0]
      })
    ).rejects.toThrow('asset-bytes-changed')
    expect(fake.observed).toHaveLength(1)
  })

  it.each([301, 302, 307, 308])('refuses HTTP %i without following redirects or retrying', async (status) => {
    const fake = fakeHttp(status)
    const request = createGitHubTransport({ token: 'synthetic-token', stageDir: '', requestImpl: fake.request })
    await expect(request({ repository: SOURCE, route: 'releases/latest' })).rejects.toThrow('http-redirect')
    expect(fake.observed).toHaveLength(1)
  })

  it.each(['https://other.invalid/', '../other', 'releases#fragment'])(
    'rejects route escape %s before HTTP',
    async (route) => {
      const fake = fakeHttp()
      const request = createGitHubTransport({ token: 'synthetic-token', stageDir: '', requestImpl: fake.request })
      await expect(request({ repository: SOURCE, route })).rejects.toThrow('transport-input')
      expect(fake.observed).toEqual([])
    }
  )

  it('rejects a different repository and bounds JSON responses', async () => {
    const fake = fakeHttp(200, 'x'.repeat(2 * 1024 * 1024 + 1))
    const request = createGitHubTransport({ token: 'synthetic-token', stageDir: '', requestImpl: fake.request })
    await expect(request({ repository: 'other/repo', route: '' })).rejects.toThrow('transport-input')
    expect(fake.observed).toEqual([])
    await expect(request({ repository: SOURCE, route: 'releases/latest' })).rejects.toThrow('http-response-limit')
    expect(fake.observed).toHaveLength(1)
  })

  it('enforces a wall-clock deadline without retrying a stalled request', async () => {
    vi.useFakeTimers()
    const opened: Writable[] = []
    try {
      const stalled = () => {
        const stream = new Writable({
          write(_chunk, _encoding, done) {
            done()
          }
        })
        opened.push(stream)
        return stream
      }
      const request = createGitHubTransport({
        token: 'synthetic-token',
        stageDir: '',
        requestImpl: stalled as unknown as typeof httpsRequest
      })
      const check = expect(request({ repository: SOURCE, route: 'releases/latest' })).rejects.toThrow('http-deadline')
      await vi.advanceTimersByTimeAsync(60_000)
      await check
      expect(opened).toHaveLength(1)
      expect(opened[0].destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
