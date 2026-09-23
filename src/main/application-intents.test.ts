import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { ApplicationCatalog } from './application-catalog'
import { classifyApplicationIntent, parseApplicationIntent } from './application-intents'
import * as applicationIntents from './application-intents'

vi.mock('node:child_process', () => { throw new Error('Intent contracts must not import process authority') })
vi.mock('child_process', () => { throw new Error('Intent contracts must not import process authority') })
vi.mock('electron', () => { throw new Error('Intent contracts must not import native authority') })

const applicationId = `app_${'a'.repeat(64)}`
const candidateSet = { revision: 1, digest: 'b'.repeat(64) }
const open = { operation: 'apps.open', applicationId, candidateSet }
const targeted = ['apps.open', 'apps.focus', 'apps.quit'] as const
const makeIntent = (operation: typeof targeted[number]) => ({ ...open, operation, ...(operation === 'apps.quit' ? { mode: 'graceful' } : {}) })
const parseValid = (input: unknown) => {
  const result = parseApplicationIntent(input)
  if (!result.success) throw result.error
  return result.data
}

describe('application intent input boundary', () => {
  it.each([
    { operation: 'apps.list' }, { operation: 'apps.list', query: 'Métis Notes' },
    ...targeted.map(makeIntent)
  ])('accepts exactly the supported data shape: $operation', input => {
    expect(parseApplicationIntent(input)).toEqual({ success: true, data: input })
  })

  it.each([null, undefined, [], 'apps.list', 1, true, {}, { operation: 'apps.execute' }, { operation: 'toString' }])('refuses unknown input %j', input => {
    expect(parseApplicationIntent(input).success).toBe(false)
  })

  it.each(['path', 'bundleId', 'aumid', 'executable', 'shell', 'command', 'url', 'force', 'kill', 'timeout', 'displayName', 'target', 'args', 'kind', 'risk', 'token'])('rejects the extra field %s on every operation', field => {
    for (const input of [{ operation: 'apps.list' }, ...targeted.map(makeIntent)]) {
      expect(parseApplicationIntent({ ...input, [field]: 'untrusted' }).success).toBe(false)
    }
  })

  it.each(['__proto__', 'constructor', 'prototype'])('rejects parsed JSON pollution key %s at either object level', key => {
    const top = JSON.parse(`{"operation":"apps.list","${key}":{"polluted":true}}`)
    const nested = JSON.parse(`{"revision":1,"digest":"${candidateSet.digest}","${key}":{}}`)
    expect(parseApplicationIntent(top).success).toBe(false)
    expect(parseApplicationIntent({ ...open, candidateSet: nested }).success).toBe(false)
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('rejects object-literal prototype manipulation at either level', () => {
    expect(parseApplicationIntent({ __proto__: { polluted: true }, operation: 'apps.list' }).success).toBe(false)
    expect(parseApplicationIntent({ ...open, candidateSet: { __proto__: { polluted: true }, ...candidateSet } }).success).toBe(false)
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('rejects inherited fields, altered prototypes, symbols, accessors and non-enumerable keys without invoking getters', () => {
    const getter = vi.fn(() => 'apps.list')
    const accessor = Object.defineProperty({}, 'operation', { enumerable: true, get: getter })
    const hidden = Object.defineProperty({ operation: 'apps.list' }, 'command', { value: 'ignored' })
    const versionAccessor = Object.defineProperty({ digest: candidateSet.digest }, 'revision', { enumerable: true, get: getter })
    const values = [Object.create(open), Object.assign(Object.create(null), open), accessor, hidden,
      { ...open, [Symbol('extra')]: true }, { ...open, candidateSet: Object.create(candidateSet) },
      { ...open, candidateSet: Object.assign(Object.create(null), candidateSet) }, { ...open, candidateSet: versionAccessor }]
    for (const value of values) expect(parseApplicationIntent(value).success).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([
    ['top', 'then', false], ['top', 'then', true], ['top', 'catch', false], ['top', 'catch', true],
    ['nested', 'then', false], ['nested', 'then', true], ['nested', 'catch', false], ['nested', 'catch', true]
  ] as const)('rejects %s %s getters before Zod sees them (throwing=%s)', (level, key, throws) => {
    const getter = vi.fn(() => {
      if (throws) throw new Error('Accessor must not run')
      return undefined
    })
    const record = Object.defineProperty(level === 'top' ? { operation: 'apps.list' } : { ...candidateSet }, key,
      { enumerable: true, get: getter })
    // Zod probes catch only when then is a function.
    if (key === 'catch') Object.defineProperty(record, 'then', { enumerable: true, value: () => undefined })
    const input = level === 'top' ? record : { ...open, candidateSet: record }
    let result: ReturnType<typeof parseApplicationIntent> | undefined
    expect(() => { result = parseApplicationIntent(input) }).not.toThrow()
    expect(result?.success).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejects nested objects masquerading as primitive fields without probing their getters', () => {
    const getter = vi.fn(() => { throw new Error('Accessor must not run') })
    const value = Object.defineProperty({}, 'then', { enumerable: true, get: getter })
    for (const input of [{ operation: value }, { operation: 'apps.list', query: value },
      { ...open, applicationId: value }, { ...open, candidateSet: { ...candidateSet, revision: value } },
      { ...open, candidateSet: { ...candidateSet, digest: value } }]) {
      expect(() => expect(parseApplicationIntent(input).success).toBe(false)).not.toThrow()
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it('exports no unguarded schema or alternative raw-input entry point', () => {
    expect(Object.keys(applicationIntents).sort()).toEqual(['classifyApplicationIntent', 'parseApplicationIntent'])
  })

  it.each(['Notes', 'com.apple.Notes', 'Microsoft.Notes!App', '/Applications/Notes.app', 'C:\\Notes.exe', 'notes.exe', 'https://example.com', `app_${'A'.repeat(64)}`, `app_${'a'.repeat(63)}`, `app_${'a'.repeat(65)}`, 'a'.repeat(5000)])('rejects non-catalog target %s', applicationId => {
    for (const operation of targeted) expect(parseApplicationIntent({ ...makeIntent(operation), applicationId }).success).toBe(false)
  })

  it.each([undefined, null, {}, { revision: 0, digest: candidateSet.digest }, { revision: -1, digest: candidateSet.digest },
    { revision: 1.5, digest: candidateSet.digest }, { revision: Number.MAX_SAFE_INTEGER + 1, digest: candidateSet.digest },
    { revision: NaN, digest: candidateSet.digest }, { revision: Infinity, digest: candidateSet.digest },
    { revision: '1', digest: candidateSet.digest }, { revision: 1, digest: 'b'.repeat(63) },
    { revision: 1, digest: 'B'.repeat(64) }, { revision: 1, digest: 'b'.repeat(65) }, { ...candidateSet, id: applicationId }])('rejects malformed candidate version %j', candidateSet => {
    expect(parseApplicationIntent({ ...open, candidateSet }).success).toBe(false)
  })

  it('requires the exact ID and candidate version for every targeted operation', () => {
    for (const operation of targeted) {
      const { applicationId: _id, ...withoutId } = makeIntent(operation)
      const { candidateSet: _version, ...withoutVersion } = makeIntent(operation)
      expect(parseApplicationIntent(withoutId).success).toBe(false)
      expect(parseApplicationIntent(withoutVersion).success).toBe(false)
      expect(parseApplicationIntent({ ...makeIntent(operation), query: 'Notes' }).success).toBe(false)
    }
    expect(parseApplicationIntent({ operation: 'apps.list', applicationId, candidateSet }).success).toBe(false)
  })

  it.each(['', ' '.repeat(5), 'a'.repeat(121), '/Applications/Notes.app', 'C:\\Notes.exe', 'notes.exe', 'Notes.app', 'com.apple.Notes',
    'Microsoft.Notes!App', 'https://example.com', 'Notes\n', 'Notes\u0000', 'Notes\u202e'])('rejects unsafe display-name query %j', query => {
    expect(parseApplicationIntent({ operation: 'apps.list', query }).success).toBe(false)
  })

  it('permits a bounded query but does not normalize it into a target', () => {
    expect(parseApplicationIntent({ operation: 'apps.list', query: 'A'.repeat(120) }).success).toBe(true)
    expect(parseApplicationIntent({ operation: 'apps.list', query: '  Notes  ' })).toEqual({ success: true, data: { operation: 'apps.list', query: '  Notes  ' } })
  })

  it.each([null, 5, true, [], {}])('rejects non-text display query %j without coercion', query => {
    expect(parseApplicationIntent({ operation: 'apps.list', query }).success).toBe(false)
  })

  it.each(['apps.list', 'apps.open', 'apps.focus'])('refuses quit mode on %s', operation => {
    expect(parseApplicationIntent({ ...(operation === 'apps.list' ? { operation } : { ...open, operation }), mode: 'graceful' }).success).toBe(false)
  })

  it.each([undefined, 'force', 'kill', 'graceful ', false, 0, {}])('requires literal graceful quit mode %j', mode => {
    expect(parseApplicationIntent({ ...open, operation: 'apps.quit', mode }).success).toBe(false)
  })

  it('copies and freezes accepted intent and version without freezing or mutating the caller', () => {
    const input = { ...open, candidateSet: { ...candidateSet } }
    const parsed = parseValid(input)
    expect(parsed).not.toBe(input)
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(parsed)).toBe(true)
    if (parsed.operation !== 'apps.list') {
      expect(Object.isFrozen(parsed.candidateSet)).toBe(true)
      input.candidateSet.revision = 99
      expect(parsed.candidateSet.revision).toBe(1)
    }
  })
})

describe('pure capability/risk classification', () => {
  it.each([['apps.list', 'R0', 'selection'], ['apps.open', 'R1', 'proposal'], ['apps.focus', 'R1', 'proposal'], ['apps.quit', 'R2', 'proposal']] as const)('classifies %s without granting authority', (operation, risk, stage) => {
    const intent = parseValid(operation === 'apps.list' ? { operation } : makeIntent(operation))
    expect(classifyApplicationIntent(intent, 'notes')).toEqual({ operation, risk, stage, executable: false })
  })

  it.each(['terminal', 'system-admin', 'installer', 'credential-security', 'camera-media-capture', 'unknown'] as const)('refuses restricted app kind %s', kind => {
    for (const operation of targeted) expect(classifyApplicationIntent(parseValid(makeIntent(operation)), kind)).toBeNull()
  })

  it('requires an eligible kind for targeted proposals and refuses runtime-forged generic operations', () => {
    const intent = parseValid(open)
    expect(classifyApplicationIntent(intent)).toBeNull()
    for (const kind of ['notes', 'browser', 'document-editor'] as const) expect(classifyApplicationIntent(intent, kind)?.risk).toBe('R1')
    expect(classifyApplicationIntent(parseValid({ operation: 'apps.list' }))?.risk).toBe('R0')
    // Runtime callers cannot elevate a forged typed value into a capability.
    expect(classifyApplicationIntent({ operation: 'apps.execute' } as never, 'notes')).toBeNull()
    expect(classifyApplicationIntent(intent, 'toString' as never)).toBeNull()
  })

  it('preserves real catalog bindings and leaves freshness/membership to catalog revalidation', async () => {
    const catalog = new ApplicationCatalog({ installationKey: new Uint8Array(32).fill(7), discovery: { discover: async () => [{
      displayName: 'Notes', aliases: [], kind: 'notes', available: true,
      native: { platform: 'darwin', bundlePath: '/Applications/Notes.app', bundleId: 'com.example.notes', fingerprint: 'build-1' }
    }] } })
    const snapshot = await catalog.snapshot()
    const intent = parseValid({ operation: 'apps.open', applicationId: snapshot.applications[0].id,
      candidateSet: { revision: snapshot.revision, digest: snapshot.digest } })
    if (intent.operation === 'apps.list') throw new Error('Expected targeted intent')
    expect((await catalog.revalidate(intent.applicationId, intent.candidateSet)).status).toBe('valid')
    expect((await catalog.revalidate(intent.applicationId, { ...intent.candidateSet, revision: intent.candidateSet.revision + 1 })).status).toBe('stale')
    expect((await catalog.revalidate(applicationId, intent.candidateSet)).status).toBe('missing')
    expect(classifyApplicationIntent(intent, 'notes')).not.toHaveProperty('token')
  })

  it('keeps production imports limited to Zod and the type-only catalog view', () => {
    const source = readFileSync(new URL('./application-intents.ts', import.meta.url), 'utf8')
    expect([...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]).sort()).toEqual(['./application-catalog-view', 'zod'])
    expect(source).not.toMatch(/\b(?:require|import)\s*\(/)
    expect(source).not.toMatch(/\b(?:child_process|electron|fetch|setTimeout|setInterval)\b/)
  })
})
