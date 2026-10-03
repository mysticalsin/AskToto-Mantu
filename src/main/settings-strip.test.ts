import { describe, expect, it } from 'vitest'
import { SERVER_AUTHORITATIVE_SETTINGS_KEYS } from '@shared/contracts/settings/server-authoritative'
import { stripServerAuthoritativeSettingsPatch } from './settings-strip'

describe('stripServerAuthoritativeSettingsPatch', () => {
  it('removes every server-authoritative key from a renderer settings patch', () => {
    const patch: Record<string, unknown> = Object.fromEntries(
      SERVER_AUTHORITATIVE_SETTINGS_KEYS.map((key) => [key, `hostile-${key}`])
    )
    patch.askFollowUpMemory = true

    const returned = stripServerAuthoritativeSettingsPatch(patch)

    expect(returned).toBe(patch)
    for (const key of SERVER_AUTHORITATIVE_SETTINGS_KEYS) {
      expect(patch[key], `${key} must be stripped`).toBeUndefined()
    }
    expect(patch.askFollowUpMemory).toBe(true)
  })
})
