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
 *
 * M2-0031: the merge itself moved into store.ts's loadEntityDisplayNames (gateway-backed, so a mount
 * racing a cloud-only/kernel-blocked entity file can't freeze the main thread — see
 * store.test.ts's "loadEntityDisplayNames" suite for the behavioral coverage). The IPC handler is now a
 * thin call-site delegate; this file only pins that it stays one, so the merge logic can't drift back
 * into index.ts (and out of the gateway) unnoticed.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const ipcSrc = readFileSync(join(__dirname, '..', 'shared', 'ipc.ts'), 'utf8')

describe('MQA-115 — brainEntityNames returns a flat { names }, not { people, accounts }', () => {
  it('the shared result type is exactly { names: string[] }', () => {
    expect(ipcSrc).toMatch(/export interface BrainEntityNamesResult \{\s*names: string\[\]\s*\}/)
    expect(ipcSrc).not.toMatch(/BrainEntityNamesResult \{[\s\S]*?\bpeople:/)
    expect(ipcSrc).not.toMatch(/BrainEntityNamesResult \{[\s\S]*?\baccounts:/)
  })

  it('the handler is a thin gateway-backed delegate, not an inline sync directory scan', () => {
    const handler = indexSrc.slice(
      indexSrc.indexOf('ipcMain.handle(IPC.brainEntityNames'),
      indexSrc.indexOf('ipcMain.handle(IPC.brainSetDealOutcome')
    )
    // Delegates the merge to the gateway-backed store function — never reads entities inline here.
    expect(handler).toMatch(/return loadBrainEntityDisplayNames\(getSettings\(\)\)/)
    expect(handler).not.toMatch(/readBrainPerson|readBrainAccount|listBrainEntities/)
    expect(handler).not.toMatch(/return \{\s*people,\s*accounts\s*\}/)
  })
})
