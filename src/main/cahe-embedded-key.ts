import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getApiKey, getSettings, setApiKey, setSettings } from './store'
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

/** Separate one-time marker for the background-screen-context Local-AI seed (M13). Deliberately NOT the
 *  same marker as the key seed: an existing pilot profile (upgraded from 1.0.7, whose key marker already
 *  exists) must still receive this migration exactly once, so the background reader turns on for them too. */
function localAiSeededMarkerPath(): string {
  return join(app.getPath('userData'), '.cahe-localai-seeded')
}

/**
 * Cahê M13: enable the bundled ON-DEVICE model so background screen preprocessing works out of the box —
 * it pre-analyzes the screen locally so "What's on my screen" answers fast. Runs ONCE per profile (its own
 * marker), independent of the key seed, so both fresh installs AND 1.0.7→ upgrades get it.
 *
 * Deliberately sets localLlm.useFor.{suggest,summary,vision} = false: enabling the local model must NOT
 * silently reroute live suggestions/summaries/vision answers off Kimi (quality) onto the small on-device
 * model. The local model is here ONLY to power the silent background screen reader; the user can still flip
 * any use-for toggle on in Settings afterward, and — sharing the one-time marker — that choice sticks.
 * Best-effort; never throws.
 */
export function seedCaheLocalAiForBackgroundScreen(): void {
  if (!isCaheEdition()) return
  let marker: string
  try {
    marker = localAiSeededMarkerPath()
    if (existsSync(marker)) return
  } catch (e) {
    mainLog.warn('[cahe-embedded-key] could not check the local-ai seed marker; skipping', e)
    return
  }
  try {
    const cur = getSettings()
    setSettings({
      localLlm: { ...cur.localLlm, enabled: true, useFor: { suggest: false, summary: false, vision: false } },
      backgroundScreenContext: true
    })
    auditLog('cahe.localai.seeded', {})
    mainLog.info('[cahe-embedded-key] enabled on-device model for background screen context (Cahê pilot)')
  } catch (e) {
    mainLog.warn('[cahe-embedded-key] could not seed Local AI for background screen context', e)
  }
  try {
    writeFileSync(marker, new Date().toISOString(), { mode: 0o600 })
  } catch (e) {
    mainLog.warn('[cahe-embedded-key] could not write the local-ai seed marker', e)
  }
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
 * come back and silently re-overwrite it.
 *
 * `provider` DOES need setting here (unlike before): caheEditionPolicy() no longer locks or force-defaults
 * it — Cahê's implicit policy is now identical to a non-Cahê build (no allowlist, no locked keys, no
 * managed defaults), specifically so the pilot user can freely connect/switch to Claude Code CLI, Codex
 * CLI, Dust, or any API-key provider. "Kimi works out of the box" therefore has to come from an ordinary
 * one-time user-layer write via store.ts's setSettings — gated by the exact same marker as the key import
 * above — rather than from a policy override. Because it shares the marker, it also only ever runs once:
 * a later user switch to another provider persists across restarts exactly like a key change does.
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
  }

  // Out-of-box default: activate Kimi as the current provider, once. setSettings persists this into the
  // user's own settings.json layer (no lock stands in the way anymore), so it reads back on every future
  // getSettings() call — and a user who later picks Claude CLI/Codex CLI/Dust/another key simply
  // overwrites this same layer, which the marker below ensures we never come back and clobber again.
  try {
    setSettings({ provider: 'kimi' })
  } catch (e) {
    // Best-effort — e.g. disk full or encryption unavailable must never block startup.
    mainLog.warn('[cahe-embedded-key] could not seed the default Kimi provider', e)
  }

  // Written unconditionally once we get here — whether the key/provider seed above succeeded, partially
  // failed, or threw. This is a ONE-TIME seed attempt, not an ongoing sync: writing the marker regardless
  // of outcome is what lets a user's later "change the key", "switch provider", or "remove the key" action
  // stick — without it we'd re-seed both the embedded key and the default provider back in on every
  // launch and silently undo their choice.
  try {
    writeFileSync(marker, new Date().toISOString(), { mode: 0o600 })
  } catch (e) {
    mainLog.warn('[cahe-embedded-key] could not write the seed marker', e)
  }
}
