import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getApiKey, setApiKey } from './store'
import { isCaheEdition } from './cahe-edition'
import { mainLog, auditLog } from './logger'

// Extract the sk-kimi- token from whatever the operator placed in the field, tolerating an accidental
// label prefix (e.g. "Metis: sk-kimi-..."), surrounding quotes, or stray whitespace, so a paste slip
// can't silently ship a key that the coding endpoint would 401.
const KIMI_KEY_PATTERN = /sk-kimi-[A-Za-z0-9_-]{16,}/

interface CaheKeyBundle {
  kimiApiKey?: string
}

/** Per-profile marker recording that the one-time embedded-key seed has already run (see below). */
function seededMarkerPath(): string {
  return join(app.getPath('userData'), '.cahe-key-seeded')
}

/**
 * Cahê pilot builds ship with a Kimi API key baked into the installer — this is an intentional,
 * user-authorized embed for the Cahê pilot only, disclosed (not sneaky): electron-builder.cahe.win.yml's
 * extraResources copies the locally-provided build/cahe-kimi.local.json to resources/cahe/kimi.json, and
 * scripts/check-cahe-package.mjs's packaging-time scan only lets it through when a build explicitly opts
 * in via METIS_CAHE_EMBED_KEY=1 (printing a loud warning when it does). Bundling it means the pilot works
 * with zero setup: no onboarding key-entry screen, no key to paste in.
 *
 * This seeds that key into the normal per-provider keystore (store.ts's setApiKey/getApiKey — encrypted
 * at rest via the unsigned build's AES file keystore, exactly like a key the user pastes in themselves)
 * EXACTLY ONCE per profile, tracked by a marker file in userData. Once that one seed attempt has run —
 * successful or not — this is permanently a no-op for the life of the profile, so a pilot user who later
 * changes or clears the Kimi key in Settings has that decision stick across every future launch; we never
 * come back and silently re-overwrite it. `provider` itself doesn't need setting here: caheEditionPolicy
 * already forces it to 'kimi' as a managed default and locks it, so getSettings().provider is always
 * 'kimi' in this edition regardless of this module.
 *
 * Best-effort only — never throws, and never logs the key value itself.
 */
export function importEmbeddedCaheKey(): void {
  if (!isCaheEdition()) return

  let marker: string
  try {
    marker = seededMarkerPath()
    if (existsSync(marker)) return // already seeded (or attempted) once for this profile — never redo
  } catch (e) {
    mainLog.warn('[cahe-embedded-key] could not check the seed marker; skipping embedded key import', e)
    return
  }

  try {
    if (!getApiKey('kimi')) {
      const bundlePath = join(process.resourcesPath, 'cahe', 'kimi.json')
      if (!existsSync(bundlePath)) {
        mainLog.warn(`[cahe-embedded-key] no embedded Kimi key bundle found at ${bundlePath}`)
      } else {
        const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as CaheKeyBundle
        const extracted = bundle.kimiApiKey?.match(KIMI_KEY_PATTERN)?.[0]
        if (extracted) {
          setApiKey('kimi', extracted)
          auditLog('key.set', { provider: 'kimi', source: 'cahe-embedded' })
          mainLog.info('[cahe-embedded-key] seeded the embedded Kimi API key for the Cahê pilot')
        } else {
          mainLog.warn('[cahe-embedded-key] embedded Kimi key bundle is missing a valid kimiApiKey')
        }
      }
    }
  } catch (e) {
    // Best-effort — a missing/corrupt/malformed bundle must never block startup.
    mainLog.warn('[cahe-embedded-key] embedded key import failed', e)
  } finally {
    // Written unconditionally once we get here — whether the key was already present, the bundle was
    // missing/malformed, or an error was thrown above. This is a ONE-TIME seed attempt, not an ongoing
    // sync: writing the marker regardless of outcome is what lets a user's later "change the key" or
    // "remove the key" action stick — without it we'd re-seed the embedded key back in on every launch
    // and silently undo their choice.
    try {
      writeFileSync(marker, new Date().toISOString(), { mode: 0o600 })
    } catch (e) {
      mainLog.warn('[cahe-embedded-key] could not write the seed marker', e)
    }
  }
}
