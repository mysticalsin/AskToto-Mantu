import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const appSource = readFileSync(join(__dirname, '../renderer/src/App.tsx'), 'utf8')

describe('recovered draft count stays within its active profile boundary', () => {
  it('publishes a new empty revision after a confirmed profile recovery', () => {
    expect(mainSource).toMatch(
      /const archive = archiveEncryptedProfile\(\)[\s\S]{0,220}recoveredDraftsThisLaunch = 0[\s\S]{0,100}recoveredDraftCountRevision \+= 1[\s\S]{0,100}publishRecoveredDraftCount\(\)/
    )
  })

  it('ignores orphan recovery work that began under the previous profile revision', () => {
    expect(mainSource).toMatch(
      /const recoveryRevision = recoveredDraftCountRevision[\s\S]{0,180}recoverOrphanDrafts\(getSettings\(\)\)[\s\S]{0,160}if \(recoveryRevision !== recoveredDraftCountRevision\) return/
    )
  })

  it('versions renderer snapshots and clears the visible count when auth or profile ownership changes', () => {
    expect(appSource).toMatch(/recoveredDraftOwnerRef\.current !== owner[\s\S]{0,160}setRecoveredDraftCount\(0\)/)
    expect(appSource).toMatch(/revision >= recoveredDraftRevisionRef\.current/)
    expect(appSource).toMatch(/\[auth\.status\?\.signedIn, settings\?\.profile\?\.name\]/)
  })
})
