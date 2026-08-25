import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const STORE = readFileSync(join(__dirname, 'store.ts'), 'utf8')
const SEED = readFileSync(join(__dirname, 'embedded-cloudflare-key.ts'), 'utf8')

/**
 * MQA-260 — the profile-repair button produced a profile that could never hold the shipped key.
 *
 * The installer-embedded Cloudflare key seeds once per profile, guarded by a `.cloudflare-key-seeded`
 * marker. That guard has a real job and it is not this one: it stops a later launch silently
 * overwriting a key the USER chose, so their removal or replacement sticks across updates.
 *
 * "Create new local profile & retry" fires when `secret-key.bin` cannot be unwrapped — which means
 * every `key-<provider>.bin` in that profile is already undecryptable, so archiving them destroys
 * nothing that still worked. But the markers were left behind, carrying the OLD profile's "already
 * seeded" verdict into the rebuilt one. The repair therefore handed back a profile with no Cloudflare
 * key and no path to one.
 *
 * On a build that ships an embedded key, that is not a cosmetic gap: with no cloud key the default
 * provider is gone and every ask falls to the on-device model — measured at 12.2s against 1.0s through
 * the Worker. The button advertised as a repair silently downgraded the product by an order of
 * magnitude.
 *
 * Pinned as source text because archiveEncryptedProfile's behaviour is a module-level Set consulted
 * during a filesystem sweep, with no injectable seam.
 */
describe('MQA-260 — a rebuilt profile must be able to seed the embedded key again', () => {
  it('clears both one-shot seed markers when the encrypted profile is archived', () => {
    // Cahê's Kimi key uses the identical one-shot pattern (cahe-embedded-key.ts) and has the identical
    // failure, so both markers move together or the next one to matter is missed.
    for (const marker of ["'.cloudflare-key-seeded'", "'.cahe-key-seeded'"]) {
      expect(
        STORE.includes(marker),
        `${marker} must be in PROFILE_RECOVERY_FIXED_FILES, or a repaired profile inherits "already seeded" and can never hold the shipped key`
      ).toBe(true)
    }
  })

  it('keeps the markers inside PROFILE_RECOVERY_FIXED_FILES specifically', () => {
    // Guards against the strings surviving only in a comment after a refactor.
    const start = STORE.indexOf('const PROFILE_RECOVERY_FIXED_FILES')
    expect(start).toBeGreaterThan(-1)
    const block = STORE.slice(start, STORE.indexOf('])', start))
    expect(block).toContain("'.cloudflare-key-seeded'")
    expect(block).toContain("'.cahe-key-seeded'")
  })

  it('does NOT weaken the marker itself — a user key must still win on an ordinary launch', () => {
    // The fix is scoped to profile REBUILD. Re-seeding on every launch would overwrite a key the user
    // deliberately removed or replaced, which is the exact behaviour the marker exists to prevent.
    expect(SEED).toMatch(/if \(existsSync\(marker\)\) return/)
    expect(SEED).toMatch(/if \(getApiKey\('cloudflare'\)\) \{/)
  })
})
