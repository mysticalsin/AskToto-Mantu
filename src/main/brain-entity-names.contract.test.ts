import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source contract for the brainEntityNames IPC shape — MQA-115 (docs/qa/BUG-LEDGER.md).
 *
 * The bug was a consumer (the physical QA harness) reading a non-existent { people, accounts } shape
 * off this handler and therefore always seeing 0 names — masking whether entity extraction worked at
 * all. The handler in fact returns a FLAT { names: string[] } that MERGES people and account names
 * (BrainEntityNamesResult in shared/ipc.ts), because its only consumer, the ASR casing-bias feature,
 * wants one deduped name list. This pins that flat shape so a future refactor can't split it back into
 * { people, accounts } and silently break every reader again.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const ipcSrc = readFileSync(join(__dirname, '..', 'shared', 'ipc.ts'), 'utf8')

describe('MQA-115 — brainEntityNames returns a flat { names }, not { people, accounts }', () => {
  it('the shared result type is exactly { names: string[] }', () => {
    expect(ipcSrc).toMatch(/export interface BrainEntityNamesResult \{\s*names: string\[\]\s*\}/)
    expect(ipcSrc).not.toMatch(/BrainEntityNamesResult \{[\s\S]*?\bpeople:/)
    expect(ipcSrc).not.toMatch(/BrainEntityNamesResult \{[\s\S]*?\baccounts:/)
  })

  it('the handler merges people + accounts into one deduped names array', () => {
    const handler = indexSrc.slice(
      indexSrc.indexOf('ipcMain.handle(IPC.brainEntityNames'),
      indexSrc.indexOf('ipcMain.handle(IPC.brainSetDealOutcome')
    )
    // Both sources feed the one array…
    expect(handler).toMatch(/const people = listBrainEntities\(s, 'person'\)/)
    expect(handler).toMatch(/const accounts = listBrainEntities\(s, 'account'\)/)
    // …merged + deduped into a single { names } return, never a { people, accounts } object.
    expect(handler).toMatch(/return \{ names: Array\.from\(new Set\(\[\.\.\.people, \.\.\.accounts\]\)\)/)
    expect(handler).not.toMatch(/return \{\s*people,\s*accounts\s*\}/)
  })
})
