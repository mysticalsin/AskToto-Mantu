import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NO_PROVIDER_INDEX_COPY,
  SIGN_IN_INDEX_COPY,
  intelligenceUpdateError,
  ipcFailureMessage,
  runIntelligenceUpdateClick
} from './intelligence-update'

describe('intelligence update click contract', () => {
  it('surfaces no-provider and sign-in copy, never a silent empty string', () => {
    expect(intelligenceUpdateError({ deferred: 'no-provider' })).toBe(NO_PROVIDER_INDEX_COPY)
    expect(intelligenceUpdateError({ error: SIGN_IN_INDEX_COPY })).toBe(SIGN_IN_INDEX_COPY)
    expect(intelligenceUpdateError({ queued: 2 })).toBeNull()
    expect(intelligenceUpdateError({ preparing: true })).toBeNull()
    expect(NO_PROVIDER_INDEX_COPY).toMatch(/Connect an AI provider/)
    expect(NO_PROVIDER_INDEX_COPY).not.toMatch(/—/)
    expect(SIGN_IN_INDEX_COPY).toBe('Sign in with your Mantu account first.')
  })

  it('unwraps IPC throwables so a requireAuth failure is never swallowed', () => {
    expect(ipcFailureMessage(new Error(SIGN_IN_INDEX_COPY))).toBe(SIGN_IN_INDEX_COPY)
    expect(ipcFailureMessage({ message: SIGN_IN_INDEX_COPY })).toBe(SIGN_IN_INDEX_COPY)
    expect(ipcFailureMessage('Connect an AI provider in Settings → AI')).toMatch(/Connect an AI provider/)
    expect(ipcFailureMessage({})).toBe(SIGN_IN_INDEX_COPY)
  })

  it('runIntelligenceUpdateClick returns the loud error instead of throwing', async () => {
    await expect(
      runIntelligenceUpdateClick(async () => ({ queued: 0, deferred: 'no-provider' }))
    ).resolves.toEqual({ error: NO_PROVIDER_INDEX_COPY })
    await expect(
      runIntelligenceUpdateClick(async () => {
        throw new Error(SIGN_IN_INDEX_COPY)
      })
    ).resolves.toEqual({ error: SIGN_IN_INDEX_COPY })
    await expect(runIntelligenceUpdateClick(async () => ({ queued: 3, preparing: true }))).resolves.toEqual({
      error: null
    })
  })

  it('copies stay byte-identical to the main-process strings', () => {
    const main = readFileSync(join(__dirname, '../../../main/brain/intelligence-index.ts'), 'utf8')
    expect(main).toContain(`'${NO_PROVIDER_INDEX_COPY}'`)
    expect(main).toContain(`'${SIGN_IN_INDEX_COPY}'`)
  })
})
