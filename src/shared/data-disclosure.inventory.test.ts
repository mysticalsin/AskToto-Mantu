import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROUTER_CAPABILITIES } from './capability-router'
import { SpeechEngineIdSchema } from './contracts/capability'
import { DATA_DISCLOSURES } from './data-disclosure'

const mainRoot = join(__dirname, '..', 'main')

// Exclusions: tests and fixtures name throwaway entries; qa-hooks.ts writes only to the QA profile.
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__fixtures__') out.push(...sourceFiles(full))
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !/^qa-hooks\.tsx?$/.test(entry.name)
    ) {
      out.push(full)
    }
  }
  return out
}

const USER_DATA_ENTRY = [
  /getPath\(\s*'userData'\s*\)\s*,\s*'([^']+)'/g,
  /\buserData(?:Dir|Path)?(?:\(\))?\s*,\s*'([^']+)'/g
]

function userDataEntriesInMain(): Set<string> {
  const names = new Set<string>()
  for (const file of sourceFiles(mainRoot)) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of USER_DATA_ENTRY) for (const m of text.matchAll(pattern)) names.add(m[1] as string)
  }
  return names
}

function rowsClaiming(name: string): string[] {
  return DATA_DISCLOSURES.filter((row) =>
    row.userDataEntries.some((e) => (e.endsWith('*') ? name.startsWith(e.slice(0, -1)) : e === name))
  ).map((row) => row.id)
}

describe('disclosure inventory (G83)', () => {
  const found = userDataEntriesInMain()

  it('every userData entry named in src/main has exactly one row', () => {
    expect(found.size).toBeGreaterThan(10)
    const missing = [...found].filter((name) => rowsClaiming(name).length === 0)
    const doubled = [...found].filter((name) => rowsClaiming(name).length > 1)
    expect(missing, 'userData entries with no disclosure row').toEqual([])
    expect(doubled, 'userData entries claimed by more than one row').toEqual([])
  })

  it('no row claims a userData entry that main never writes', () => {
    const stale = DATA_DISCLOSURES.flatMap((row) =>
      row.userDataEntries
        .filter((e) => ![...found].some((name) => (e.endsWith('*') ? name.startsWith(e.slice(0, -1)) : e === name)))
        .map((e) => `${row.id}:${e}`)
    )
    expect(stale).toEqual([])
  })

  it('every router capability has exactly one row', () => {
    for (const cap of ROUTER_CAPABILITIES) {
      expect(DATA_DISCLOSURES.filter((r) => r.routerCapabilities.includes(cap)).length, cap).toBe(1)
    }
  })

  it('every speech engine has exactly one row', () => {
    for (const engine of SpeechEngineIdSchema.options) {
      expect(DATA_DISCLOSURES.filter((r) => r.speechEngines.includes(engine)).length, engine).toBe(1)
    }
  })

  it('the meetings folder has a row', () => {
    expect(DATA_DISCLOSURES.filter((r) => r.meetingsFolder).length).toBe(1)
  })
})
