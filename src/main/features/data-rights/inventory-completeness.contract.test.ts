import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DATA_STORES, dataStoresFor } from '@shared/data-store-inventory'
import { readModuleSource } from '../../../test-helpers/module-source'
import { createProductionErasers, type ErasureHost } from './erasers'

const MAIN = join(__dirname, '..', '..')

/** Folders and files under userData that are not owner data, reviewed one by one (model packs, installs, licence, keys, run state). */
const NOT_OWNER_DATA: ReadonlyMap<string, string> = new Map([
  ['local-llm', 'model packs and the local model runtime'],
  ['asr-models', 'speech model packs'],
  ['speech-packs', 'speech model packs'],
  ['managed-node', 'managed Node install'],
  ['managed-cli', 'managed CLI installs'],
  ['skills-overrides', 'mode skill overlay shipped with the app'],
  ['run', 'sidecar run state, no content'],
  ['vcredist', 'installer redistributable'],
  ['key-mcp-', 'tool credentials, owned by the credential inventory (G20)'],
  ['auth-session.bin', 'credential inventory (G20)'],
  ['msal-cache.bin', 'credential inventory (G20)'],
  ['license-cache.bin', 'licence cache, credential inventory (G20)'],
  ['identity.json', 'install identity, not owner content'],
  ['machine-id.txt', 'machine id, not owner content'],
  ['managed-config.json', 'organisation configuration, not owner content'],
  ['auth-configured.flag', 'sign-in configuration flag'],
  ['auth-lkg-config.json', 'sign-in configuration'],
  ['task-browser-disclosure.txt', 'a one-line acknowledgement flag, no content'],
  ['smoke-park-state.json', 'smoke test state'],
  ['boot-incomplete.json', 'boot sentinel, no content'],
  ['.cloudflare-key-seeded', 'install marker']
])

const topSegment = (path: string): string => path.split('/')[0] ?? path

function inventoriedNames(): Set<string> {
  const names = new Set<string>()
  for (const entry of DATA_STORES) {
    for (const value of [...(entry.names ?? []), ...(entry.paths ?? []), ...(entry.partitionPaths ?? [])]) {
      names.add(value)
      names.add(topSegment(value))
      names.add(value.split('/').at(-1) ?? value)
    }
  }
  return names
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__fixtures__' && name !== 'node_modules') out.push(...sourcesUnder(path))
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec|contract\.test)\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

describe('data store inventory completeness (G82)', () => {
  it('every userData folder named in lifecycle/*-wiring is inventoried', () => {
    const inventoried = inventoriedNames()
    const wiringDir = join(MAIN, 'lifecycle')
    const found: Array<{ file: string; folder: string }> = []
    for (const file of sourcesUnder(wiringDir).filter((f) => /-wiring\.ts$/.test(f))) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/(?:userDataPath\(\)|getPath\('userData'\)),\s*'([^']+)'/g)) {
        found.push({ file: relative(MAIN, file), folder: match[1] as string })
      }
    }
    expect(found.length).toBeGreaterThan(3)
    const missing = found.filter(
      ({ folder }) => !inventoried.has(folder) && ![...NOT_OWNER_DATA.keys()].some((k) => folder.startsWith(k))
    )
    expect(missing).toEqual([])
  })

  it('every persisted filename literal under features, tasks and brain is inventoried or on the reviewed non-owner list', () => {
    const inventoried = inventoriedNames()
    const literal = /['"`]([A-Za-z0-9_.${}-]+\.(?:bin|jsonl?|um1|dd1|dj1|log|flag))['"`]/g
    const missing: string[] = []
    for (const area of ['features', 'tasks', 'brain']) {
      for (const file of sourcesUnder(join(MAIN, area))) {
        const rel = relative(MAIN, file)
        // Inside the brain root (erased whole by the `brain` row), the speech model packs (not owner data) and this
        // feature's own export and receipt files.
        if (/^(?:brain\/|features\/components\/speech-pack\/|features\/data-rights\/)/.test(rel)) continue
        const text = readFileSync(file, 'utf8')
        for (const match of text.matchAll(literal)) {
          const name = match[1] as string
          const ext = name.replace(/^.*\}/, '')
          const covered =
            inventoried.has(name) ||
            (name.startsWith('${') && [...inventoried].some((n) => n.endsWith(ext))) ||
            [...inventoried].some((n) => n.length > 3 && (name.endsWith(n) || n.endsWith(name))) ||
            [...NOT_OWNER_DATA.keys()].some((k) => name.startsWith(k)) ||
            REVIEWED_FILE_LITERALS.has(name)
          if (!covered) missing.push(`${relative(MAIN, file)}: ${name}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('every inventoried name is still defined by its owning module', () => {
    for (const entry of DATA_STORES.filter((e) => e.owner && e.names)) {
      const { text } = readModuleSource(MAIN, `./${(entry.owner as string).replace(/\.ts$/, '')}`)
      for (const name of entry.names ?? []) expect(text, `${entry.id}: ${name}`).toContain(name)
    }
  })

  it('every delete row has a production eraser, and only delete rows do', () => {
    const noop = (): never => {
      throw new Error('not called')
    }
    const host = new Proxy({}, { get: () => noop }) as unknown as ErasureHost
    const erasers = createProductionErasers(host)
    const deletable = dataStoresFor('delete').map((e) => e.id)
    expect(Object.keys(erasers).sort()).toEqual([...deletable].sort())
  })

  it('every delete row names where it is erased from: a path, a partition path, or its own module hook', () => {
    const hooked = new Set([
      'meetings',
      'meeting-drafts',
      'brain',
      'brain-backup',
      'brain-preserved',
      'wiki',
      'artifacts-registry',
      'task-browser-profile',
      'operator-outbox',
      'history-cache',
      'crash-logs',
      'main-log',
      'credentials'
    ])
    for (const entry of dataStoresFor('delete')) {
      const paths = (entry.paths?.length ?? 0) + (entry.partitionPaths?.length ?? 0)
      expect(paths > 0 || hooked.has(entry.id), entry.id).toBe(true)
    }
  })
})

/** Filename literals in feature code that are not stores of owner data: reviewed, with the reason. */
const REVIEWED_FILE_LITERALS: ReadonlyMap<string, string> = new Map([
  ['key.v1', 'sealing key of the user-memory / dictation stores, not owner content'],
  ['receipts.v1.json', 'the file inside the transcript-receipts folder the save-receipts row erases'],
  ['${id}.dj1', 'a file inside the dictation-memory/journal folder the dictation-memory row erases'],
  ['${scopeKey}.json', 'a file inside the connector-accounts folder the connector-accounts row erases'],
  ['package.json', 'a manifest read, not written'],
  ['tsconfig.json', 'a manifest read, not written']
])
