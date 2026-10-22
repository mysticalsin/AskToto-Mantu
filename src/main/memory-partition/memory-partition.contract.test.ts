import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../test-helpers/module-source'

const here = dirname(fileURLToPath(import.meta.url))
const source = (specifier: string): string => readModuleSource(here, specifier).text.replace(/\r\n/g, '\n')

/**
 * G19 contract: where the partition is applied and where it is wired. These pin the seams, so a later edit that
 * hard-codes the single-owner root again, or drops the boot, fails here instead of silently reading across owners.
 */
describe('G19 memory partition seams', () => {
  it('no brain store path names the single-owner root any more; they all resolve it through the partition', () => {
    for (const specifier of [
      '../brain/store',
      '../brain/human-marks',
      '../brain/inputs',
      '../brain/rebuild-quarantine',
      '../brain/corrections'
    ]) {
      const text = source(specifier)
      expect(text, specifier).not.toMatch(/join\([^)]*'\.brain'/)
      expect(text, specifier).not.toMatch(/'\.brain-preserved'/)
      expect(text, specifier).not.toMatch(/\['\.brain'/)
    }
  })

  it('every brain write path refuses while no partition is open', () => {
    expect(source('../brain/store')).toMatch(/function ensureDirs[^]*?assertMemoryOpen\(\)/)
    expect(source('../brain/human-marks')).toMatch(/assertMemoryOpen\(\)[^]*?mkdir\(/)
  })

  it('the answer context is only built from the verified owner’s partition', () => {
    const text = source('../brain/context')
    expect(text).toMatch(/const recallStatus = await brainRecallStatus\(s\)/)
    expect(text.indexOf('brainRecallStatus(s)')).toBeLessThan(text.indexOf('tokenString(text)'))
  })

  it('main boots the partitions with the owner-session authority, before any handler exists', () => {
    const wiring = source('../lifecycle/owner-session-wiring')
    expect(wiring).toMatch(/activeOwnerSession = ownerSession\n\s*bootMainMemoryPartitions\(ownerSession\)/)
    const boot = source('../lifecycle/memory-partition-wiring')
    expect(boot).toContain('bootMemoryPartitions(')
    expect(boot).toContain('resetDustConversation()')
    expect(boot).toContain('clearHistoryReadCache()')
  })

  it('the follow-up memory is fenced by the partition and a sign-out ends it', () => {
    const index = source('../index')
    expect(index).toMatch(/if \(!followUpMemoryContinues\(\) \|\|/)
    expect(index).toMatch(/reconcileMemoryAccess\(\)/)
    expect(index).toContain('createBrainContextOwner({ inputContext: currentInputSessionContext })')
  })

  it('the Intelligence status reports the typed recall status, signed out included', () => {
    const ipc = source('../ipc/brain-ipc')
    expect(ipc).toContain("recallStatus: 'signed-out' as const")
    expect(ipc).toMatch(/recallStatus: await brainRecallStatus\(s\)/)
  })
})
