import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NO_PROVIDER_INDEX_COPY,
  SIGN_IN_INDEX_COPY,
  intelligenceUpdateError,
  runIntelligenceUpdateClick
} from './intelligence-update'

describe('dashboard Update Intelligence click', () => {
  it('surfaces no-provider and sign-in copy', async () => {
    expect(intelligenceUpdateError({ deferred: 'no-provider' })).toBe(NO_PROVIDER_INDEX_COPY)
    await expect(
      runIntelligenceUpdateClick(async () => ({ queued: 0, error: SIGN_IN_INDEX_COPY }))
    ).resolves.toEqual({ error: SIGN_IN_INDEX_COPY })
    await expect(runIntelligenceUpdateClick(async () => ({ queued: 2 }))).resolves.toEqual({ error: null })
  })

  it('NavBar mounts the Update Intelligence button', () => {
    const nav = readFileSync(join(__dirname, '../components/NavBar.tsx'), 'utf8')
    expect(nav).toMatch(/IntelligenceUpdateButton/)
    const btn = readFileSync(join(__dirname, '../components/IntelligenceUpdateButton.tsx'), 'utf8')
    expect(btn).toMatch(/Updating…/)
    expect(btn).toMatch(/runIntelligenceUpdateClick/)
    expect(btn).toMatch(/window\.intelligence/)
  })
})
