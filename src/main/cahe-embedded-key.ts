import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getApiKey, getSettings, setApiKey, setSettings } from './store'
import { isCaheEdition } from './cahe-edition'
import { mainLog, auditLog } from './logger'
import { decryptEmbeddedBlob, type EncryptedCloudflareKeyBlob } from './embedded-cloudflare-crypto'

// Extract the sk-kimi- token from whatever the operator placed in the field, tolerating an accidental
// label prefix (e.g. "Metis: sk-kimi-..."), surrounding quotes, or stray whitespace, so a paste slip
// can't silently ship a key that the coding endpoint would 401.
const KIMI_KEY_PATTERN = /sk-kimi-[A-Za-z0-9_-]{16,}/

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
 * extraResources copies the ENCRYPTED blob from build/cahe-embed/kimi.json (produced by
 * scripts/embed-cahe-kimi-key.mjs from the operator's gitignored build/cahe-kimi.local.json) to
 * resources/cahe/kimi.json. scripts/check-cahe-package.mjs only lets it through when a build explicitly
 * opts in via METIS_CAHE_EMBED_KEY=1, and refuses a plaintext kimiApiKey field. Bundling it means the
 * pilot works with zero setup: no onboarding key-entry screen, no key to paste in.
 *
 * SECURITY HONESTY: the blob is AES-256-GCM under material that ALSO ships in the app (same
 * encryptProxyKey / decryptEmbeddedBlob path as the Cloudflare embed). That is OBFUSCATION, not secrecy —
 * a determined attacker with the binary can re-derive the key. It raises the bar over a plaintext
 * resources/cahe/kimi.json that `npx asar extract` (or a raw file read of the extraResource) handed you
 * in seconds. Fail-closed: a plaintext `kimiApiKey` bundle is refused and never seeded.
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

  // Only default the provider to Kimi and burn the one-time marker once we ACTUALLY have a Kimi key —
  // seeded from the bundle here, or already present from a previous run / a manual import. A build that
  // shipped no key (or a malformed bundle) must NOT strand the pilot user on a keyless "kimi" provider,
  // and must NOT write the marker: leaving it unwritten lets a corrected build (or a bundle that only
  // appears on a later launch) still seed, instead of one broken first launch disabling the seed forever.
  let haveKey = false
  try {
    if (getApiKey('kimi')) {
      haveKey = true // user already has a Kimi key (e.g. a manual import) — respect it, nothing to seed
    } else {
      const bundlePath = join(process.resourcesPath, 'cahe', 'kimi.json')
      if (!existsSync(bundlePath)) {
        // Keyless build: no bundle to seed. Leave the app unconfigured for normal onboarding (do NOT force
        // provider:'kimi' with no key) and leave the marker unwritten so a later keyed build can still seed.
        mainLog.warn(`[cahe-embedded-key] no embedded Kimi key bundle at ${bundlePath}; leaving normal onboarding in place`)
        return
      }
      const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as EncryptedCloudflareKeyBlob & {
        kimiApiKey?: unknown
      }
      // Fail-closed: plaintext must never ship. A regression to {"kimiApiKey":"sk-kimi-…"} is refused.
      if (bundle && typeof bundle === 'object' && 'kimiApiKey' in bundle) {
        mainLog.warn(
          '[cahe-embedded-key] embedded Kimi bundle carries plaintext kimiApiKey — refusing (must be AES-256-GCM blob)'
        )
        return
      }
      const plaintext = decryptEmbeddedBlob(bundle)
      const extracted = plaintext?.match(KIMI_KEY_PATTERN)?.[0]
      if (extracted) {
        setApiKey('kimi', extracted)
        auditLog('key.set', { provider: 'kimi', source: 'cahe-embedded' })
        mainLog.info('[cahe-embedded-key] seeded the embedded Kimi API key for the Cahê pilot')
        haveKey = true
      } else {
        // Malformed / undecryptable / wrong-format: a corrected build should still get a chance, so
        // return without writing the marker or forcing a keyless Kimi provider.
        mainLog.warn(
          '[cahe-embedded-key] embedded Kimi key bundle is missing a valid encrypted sk-kimi- key; leaving normal onboarding in place'
        )
        return
      }
    }
  } catch (e) {
    // Best-effort — a corrupt bundle or keystore error must never block startup, and must not burn the
    // marker (so the next launch can retry a corrected build).
    mainLog.warn('[cahe-embedded-key] embedded key import failed', e)
    return
  }

  if (!haveKey) return

  // We have a Kimi key. Default the provider to Kimi ONCE — setSettings persists into the user's own
  // settings.json layer, so a user who later picks Claude CLI/Codex CLI/Dust/another key overwrites it,
  // and the marker below guarantees we never come back and clobber that choice.
  try {
    setSettings({ provider: 'kimi' })
  } catch (e) {
    // Best-effort — e.g. disk full or encryption unavailable must never block startup.
    mainLog.warn('[cahe-embedded-key] could not seed the default Kimi provider', e)
  }

  // Marker written now that a key is in place: this is a ONE-TIME seed. A later "change the key", "switch
  // provider", or "remove the key" then sticks — the guard at the top skips this whole function next launch.
  try {
    writeFileSync(marker, new Date().toISOString(), { mode: 0o600 })
  } catch (e) {
    mainLog.warn('[cahe-embedded-key] could not write the seed marker', e)
  }
}
