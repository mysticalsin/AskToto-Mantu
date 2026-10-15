import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isProfileRecoveryFileName } from './profile-recovery-files'

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
  it('clears the one-shot seed marker when the encrypted profile is archived', () => {
    const marker = "'.cloudflare-key-seeded'"
    expect(
      isProfileRecoveryFileName('.cloudflare-key-seeded') && STORE.includes('isProfileRecoveryFileName(entry.name)'),
      `${marker} must be recognized by the shared profile-recovery predicate used by archive and fresh-profile checks`
    ).toBe(true)
  })

  it('keeps known profile artifacts in the shared recovery classifier', () => {
    expect(isProfileRecoveryFileName('settings.json')).toBe(true)
    expect(isProfileRecoveryFileName('key-openai.bin')).toBe(true)
    expect(isProfileRecoveryFileName('ordinary-user-file.txt')).toBe(false)
  })

  it('does NOT weaken the marker itself — a user key must still win on an ordinary launch', () => {
    // The fix is scoped to profile REBUILD. Re-seeding on every launch would overwrite a key the user
    // deliberately removed or replaced, which is the exact behaviour the marker exists to prevent.
    expect(SEED).toMatch(/if \(existsSync\(marker\)\) return/)
    expect(SEED).toMatch(/if \(getApiKey\('cloudflare'\)\) \{/)
  })
})
