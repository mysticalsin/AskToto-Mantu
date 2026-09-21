import { afterEach, describe, expect, it, vi } from 'vitest'
import childProcess from 'node:child_process'
import { ApplicationCatalog } from './application-catalog'
import type { DiscoveredApplication } from './application-discovery'

// Trap both named and default imports before the catalog module is evaluated.
vi.mock('node:child_process', () => {
  const api = Object.fromEntries(['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync', 'fork']
    .map(name => [name, vi.fn(() => { throw new Error('No processes allowed') })]))
  return { ...api, default: api }
})
vi.mock('child_process', () => {
  const api = Object.fromEntries(['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync', 'fork']
    .map(name => [name, vi.fn(() => { throw new Error('No processes allowed') })]))
  return { ...api, default: api }
})

const key = Buffer.alloc(32, 7)
function app(overrides: Partial<DiscoveredApplication> = {}): DiscoveredApplication {
  return {
    displayName: 'Notes', aliases: ['My Notes'], kind: 'notes', available: true,
    native: { platform: 'darwin', bundlePath: '/Applications/Notes.app', bundleId: 'com.example.notes', fingerprint: 'signed-build-1' },
    ...overrides
  }
}
function fixture(records: unknown = [app()], ttlMs = 100) {
  let now = 0
  let calls = 0
  const state = { records }
  const catalog = new ApplicationCatalog({
    installationKey: key, ttlMs, now: () => now,
    discovery: { discover: async () => { calls++; return state.records } }
  })
  return { catalog, state, advance: (ms: number) => { now += ms }, calls: () => calls }
}

afterEach(() => vi.clearAllMocks())

describe('ApplicationCatalog', () => {
  it('keeps identity stable across refresh/order while scoping it to the installation', async () => {
    const f = fixture()
    const first = await f.catalog.snapshot()
    expect(first.applications[0].id).toMatch(/^app_[a-f0-9]{64}$/)
    expect(await f.catalog.refresh()).toEqual(first)
    const other = new ApplicationCatalog({ installationKey: Buffer.alloc(32, 8), discovery: { discover: async () => [app()] } })
    expect((await other.snapshot()).applications[0].id).not.toBe(first.applications[0].id)
  })

  it('returns only an allowlisted public view, including in resolution and revalidation', async () => {
    const f = fixture()
    const snapshot = await f.catalog.snapshot()
    const record = snapshot.applications[0]
    expect(Object.keys(record).sort()).toEqual(['aliases', 'availability', 'displayName', 'id', 'kind', 'risk'])
    const values = [snapshot, await f.catalog.resolve('notes'), await f.catalog.revalidate(record.id, snapshot)]
    const json = JSON.stringify(values)
    for (const secret of ['/Applications', 'Notes.app', 'com.example.notes', 'signed-build-1', 'bundlePath', 'native', 'fingerprint']) {
      expect(json).not.toContain(secret)
    }
    expect(JSON.stringify(f.catalog)).toBe('{}')
  })

  it('normalizes spacing, case and composed accents without fuzzy selection', async () => {
    const f = fixture([app({ displayName: 'Métis Notes', aliases: ['  My   Notes  '] })])
    expect((await f.catalog.resolve('  ME\u0301TIS  NOTES ')).status).toBe('resolved')
    expect((await f.catalog.resolve('my notes')).status).toBe('resolved')
    expect((await f.catalog.resolve('Metis Notes')).status).toBe('missing')
    expect((await f.catalog.resolve('Notes')).status).toBe('missing')
  })

  it('returns ambiguity for name/alias collisions including restricted apps', async () => {
    const f = fixture([app(), app({ displayName: 'Other', aliases: ['Notes'], kind: 'terminal', native: { platform: 'win32', executablePath: 'C:\\Tools\\other.exe', fingerprint: '1' } })])
    const result = await f.catalog.resolve('Notes')
    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous') expect(result.candidates).toHaveLength(2)
  })

  it.each(['notes', 'browser', 'document-editor'] as const)('makes %s eligible without executing it', async kind => {
    const result = await fixture([app({ kind })]).catalog.resolve('Notes')
    expect(result).toMatchObject({ status: 'resolved', application: { risk: 'R1', availability: 'available' } })
  })

  it.each(['terminal', 'system-admin', 'installer', 'credential-security', 'camera-media-capture', 'unknown'] as const)('marks %s restricted even when discovery reports availability', async kind => {
    const result = await fixture([app({ kind })]).catalog.resolve('Notes')
    expect(result).toMatchObject({ status: 'unavailable', application: { risk: 'restricted', availability: 'restricted' } })
  })

  it('caches to the TTL boundary and explicit refresh bypasses the cache', async () => {
    const f = fixture()
    await f.catalog.snapshot()
    f.advance(99)
    await f.catalog.resolve('Notes')
    expect(f.calls()).toBe(1)
    f.advance(1)
    await f.catalog.snapshot()
    expect(f.calls()).toBe(2)
    await f.catalog.refresh()
    expect(f.calls()).toBe(3)
  })

  it('retains digest/revision for equivalent discovery and changes both for changed identity', async () => {
    const a = app(), b = app({ displayName: 'Chrome', kind: 'browser', native: { platform: 'win32', aumid: 'Package!Chrome', fingerprint: '1' } })
    const f = fixture([a, b])
    const first = await f.catalog.snapshot()
    f.state.records = [b, { ...a, aliases: ['MY NOTES', 'My Notes'] }]
    expect(await f.catalog.refresh()).toEqual(first)
    f.state.records = [b, { ...a, native: { ...a.native, fingerprint: 'signed-build-2' } }]
    const changed = await f.catalog.refresh()
    expect(changed.revision).toBe(first.revision + 1)
    expect(changed.digest).not.toBe(first.digest)
    expect(changed.applications.map(v => v.id)).toEqual(first.applications.map(v => v.id))
  })

  it('refreshes for revalidation and distinguishes stale identity, missing, unavailable and valid', async () => {
    const f = fixture()
    const first = await f.catalog.snapshot(), id = first.applications[0].id
    expect((await f.catalog.revalidate(id, first)).status).toBe('valid')
    f.state.records = [app({ native: { ...app().native, fingerprint: 'replacement' } })]
    expect((await f.catalog.revalidate(id, first)).status).toBe('stale')
    const replacement = await f.catalog.snapshot()
    f.state.records = [app({ available: false })]
    expect((await f.catalog.revalidate(id, replacement)).status).toBe('unavailable')
    f.state.records = []
    expect((await f.catalog.revalidate(id, first)).status).toBe('missing')
    expect(f.calls()).toBe(5)
  })

  it('invalidates a prior candidate set when another candidate changes', async () => {
    const f = fixture(), first = await f.catalog.snapshot()
    f.state.records = [app(), app({ displayName: 'Other Notes', native: { platform: 'win32', aumid: 'Other!Notes', fingerprint: '1' } })]
    expect((await f.catalog.revalidate(first.applications[0].id, first)).status).toBe('stale')
  })

  it('excludes conflicting records for one native identity instead of picking a winner', async () => {
    const f = fixture([app(), app({ kind: 'terminal' })])
    expect((await f.catalog.snapshot()).applications).toEqual([])
    f.state.records = [app(), app()]
    expect((await f.catalog.refresh()).applications).toHaveLength(1)
  })

  it('excludes malformed records and labels containing private target data', async () => {
    const valid = app()
    const f = fixture([null, {}, { ...valid, kind: 'invented' }, { ...valid, available: 'yes' },
      { ...valid, displayName: '/Applications/Notes.app' }, { ...valid, aliases: ['com.example.notes'] },
      { ...valid, displayName: 'Notes\u202E' }, { ...valid, native: { ...valid.native, fingerprint: '' } },
      { ...valid, native: { platform: 'win32', executablePath: 'relative.exe', fingerprint: '1' } },
      { ...valid, native: { platform: 'win32', executablePath: 'C:\\Tools\\notes.exe', aumid: 'Other!Notes', fingerprint: '1' } }, valid])
    expect((await f.catalog.snapshot()).applications).toHaveLength(1)
  })

  it('rejects malformed whole discovery responses without accepting stale data after TTL expiry', async () => {
    const f = fixture()
    await f.catalog.snapshot()
    f.state.records = { applications: [] }
    f.advance(100)
    await expect(f.catalog.snapshot()).rejects.toThrow('Application discovery unavailable')
    await expect(f.catalog.resolve('notes')).rejects.toThrow('Application discovery unavailable')
    f.state.records = [app()]
    expect((await f.catalog.snapshot()).applications).toHaveLength(1)
  })

  it('coalesces concurrent discovery without stale requests racing a newer result', async () => {
    let release!: (value: unknown) => void
    let calls = 0
    const catalog = new ApplicationCatalog({ installationKey: key, discovery: { discover: () => { calls++; return new Promise(resolve => { release = resolve }) } } })
    const one = catalog.snapshot(), two = catalog.refresh()
    release([app()])
    expect(await one).toEqual(await two)
    expect(calls).toBe(1)
  })

  it('starts a fresh read for revalidation after an already-running discovery completes', async () => {
    let release!: (value: unknown) => void
    let calls = 0
    const catalog = new ApplicationCatalog({ installationKey: key, discovery: { discover: () => {
      calls++
      if (calls === 2) return new Promise(resolve => { release = resolve })
      return Promise.resolve(calls === 1 ? [app()] : [])
    } } })
    const first = await catalog.snapshot()
    const pendingRefresh = catalog.refresh()
    const revalidation = catalog.revalidate(first.applications[0].id, first)
    release([app()])
    await pendingRefresh
    expect((await revalidation).status).toBe('missing')
    expect(calls).toBe(3)
  })

  it('redacts a native provider error and does not fall back to still-cached data', async () => {
    let failed = false
    const catalog = new ApplicationCatalog({ installationKey: key, discovery: { discover: async () => {
      if (failed) throw new Error('Private path C:\\Secret\\Agent.exe')
      return [app()]
    } } })
    await catalog.snapshot()
    failed = true
    await expect(catalog.refresh()).rejects.toThrow(/^Application discovery unavailable$/)
    await expect(catalog.snapshot()).rejects.toThrow(/^Application discovery unavailable$/)
  })

  it('keeps Windows executable paths and AUMIDs out of catalog results', async () => {
    const f = fixture([
      app({ displayName: 'Editor', kind: 'document-editor', native: { platform: 'win32', executablePath: 'C:\\Program Files\\Editor\\Editor.exe', fingerprint: 'identity-one' } }),
      app({ displayName: 'Browser', kind: 'browser', native: { platform: 'win32', aumid: 'PrivatePackage!Browser', fingerprint: 'identity-two' } })
    ])
    const snapshot = await f.catalog.snapshot()
    expect(snapshot.applications).toHaveLength(2)
    const json = JSON.stringify([snapshot, await f.catalog.resolve('Editor'), await f.catalog.resolve('Browser')])
    for (const privateValue of ['Program Files', 'Editor.exe', 'PrivatePackage', 'identity-one', 'identity-two', 'executablePath', 'aumid']) {
      expect(json).not.toContain(privateValue)
    }
  })

  describe.each([
    { platform: 'macOS bundle ID', value: 'com.private.browser', native: { platform: 'darwin', bundlePath: '/Applications/Browser.app', bundleId: 'com.private.browser', fingerprint: 'browser-identity' } },
    { platform: 'Windows AUMID', value: 'PrivatePackage!Browser', native: { platform: 'win32', aumid: 'PrivatePackage!Browser', fingerprint: 'browser-identity' } }
  ] as const)('cross-record $platform privacy', ({ value, native }) => {
    it.each([
      ['display name', false], ['display name', true], ['alias', false], ['alias', true]
    ] as const)('excludes contamination through a %s (reversed order: %s)', async (field, reversed) => {
      const contaminated = app(field === 'display name' ? { displayName: value } : { aliases: [value] })
      const owner = app({ displayName: 'Browser', aliases: [], kind: 'browser', native })
      const f = fixture([contaminated])
      const oldSnapshot = await f.catalog.snapshot()
      const oldId = oldSnapshot.applications[0].id
      f.state.records = reversed ? [owner, contaminated] : [contaminated, owner]
      const snapshot = await f.catalog.refresh()
      const resolution = await f.catalog.resolve(value)
      const revalidation = await f.catalog.revalidate(oldId, oldSnapshot)
      expect(resolution.status).toBe('missing')
      expect(revalidation.status).toBe('missing')
      expect(snapshot.applications).toHaveLength(1)
      const json = JSON.stringify([snapshot, resolution, revalidation])
      expect(json).not.toContain(value)
      expect(json.toLowerCase()).not.toContain(value.toLowerCase())
    })

    it.each([
      { kind: 'invalid' }, { available: 'invalid' }, { aliases: null },
      { displayName: '' }, { native: { ...native, fingerprint: '' } },
      { native: { ...native, unknown: 'invalid' } }
    ])('still excludes identifiers when owner metadata is malformed: %j', async malformed => {
      const contaminated = app({ aliases: [value] })
      const owner = { ...app({ displayName: 'Browser', aliases: [], kind: 'browser', native }), ...malformed }
      for (const records of [[contaminated, owner], [owner, contaminated]]) {
        const f = fixture([contaminated])
        const before = await f.catalog.snapshot(), oldId = before.applications[0].id
        f.state.records = records
        const snapshot = await f.catalog.refresh()
        const resolution = await f.catalog.resolve(value)
        const revalidation = await f.catalog.revalidate(oldId, before)
        expect(resolution.status).toBe('missing')
        expect(revalidation.status).toBe('missing')
        const json = JSON.stringify([snapshot, resolution, revalidation])
        expect(json).not.toContain(value)
        expect(json.toLowerCase()).not.toContain(value.toLowerCase())
      }
    })
  })

  it('does not expose mutable state through snapshots or retain mutable discovery input', async () => {
    const record = app(), f = fixture([record])
    const first = await f.catalog.snapshot()
    record.aliases.push('Changed')
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.applications[0].aliases)).toBe(true)
    expect((await f.catalog.resolve('Changed')).status).toBe('missing')
  })

  it('rejects weak installation keys and unbounded cache TTLs', () => {
    const discovery = { discover: async () => [] }
    expect(() => new ApplicationCatalog({ installationKey: Buffer.alloc(8), discovery })).toThrow()
    for (const ttlMs of [0, -1, Infinity, NaN, 300001]) {
      expect(() => new ApplicationCatalog({ installationKey: key, discovery, ttlMs })).toThrow()
    }
  })

  it('does not invoke child processes during any catalog operation', async () => {
    const f = fixture(), snapshot = await f.catalog.snapshot()
    await f.catalog.refresh()
    await f.catalog.resolve('notes')
    await f.catalog.revalidate(snapshot.applications[0].id, snapshot)
    for (const method of ['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync', 'fork'] as const) {
      expect(childProcess[method]).not.toHaveBeenCalled()
    }
  })
})
