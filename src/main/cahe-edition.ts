import { app } from 'electron'
import { join } from 'node:path'
import { isPackagedBuild } from './dev-env'

// The pilot shows the standard Métis brand to the user (window, taskbar, shortcut) but keeps a fully
// isolated profile, updater identity, and executable name so it can never share state with — or
// overwrite — a normal Métis install. CAHE_APP_NAME is retained only as the isolated userData folder
// name (ASCII, never shown); CAHE_DISPLAY_NAME is what the user actually sees.
export const CAHE_APP_NAME = 'Metis Windows Cahe'
export const CAHE_DISPLAY_NAME = 'Métis'
export const CAHE_EXECUTABLE_NAME = 'Metis-Windows-Cahe.exe'

type Environment = Readonly<Record<string, string | undefined>>

export interface CaheRuntime {
  platform: NodeJS.Platform
  packaged: boolean
  executablePath: string
  environment: Environment
}

export interface CaheEditionPolicy {
  allowedProviders: string[] | null
  lockedKeys: string[]
  managedDefaults: Record<string, unknown>
}

/**
 * The Cahê edition is a separately packaged Windows executable. The environment switch is deliberately
 * limited to local test/build harnesses (it is user-writable, and honoring it in a shipped build would
 * repoint userData and park the install on the blocked 'cahe' update channel); installed copies identify
 * themselves from their executable name.
 */
export function detectCaheEdition({ platform, packaged, executablePath, environment }: CaheRuntime): boolean {
  if (!packaged && environment.METIS_CAHE_EDITION === '1') return true
  const executable = executablePath.split(/[\\/]/).at(-1)?.toLowerCase()
  return platform === 'win32' && packaged && executable === CAHE_EXECUTABLE_NAME.toLowerCase()
}

export function isCaheEdition(): boolean {
  return detectCaheEdition({
    platform: process.platform,
    // Fail-closed read: this runs at module load, before app ready (see dev-env.ts).
    packaged: isPackagedBuild(),
    executablePath: process.execPath,
    environment: process.env
  })
}

/** Must run before the first app.getPath('userData') call so Cahê receives an isolated profile. */
export function initializeCaheEditionIdentity(): void {
  if (!isCaheEdition()) return
  // Isolate the profile explicitly by PATH rather than via the app name, so the user-facing name can
  // stay "Métis" while the pilot's settings/transcripts/keystore live in their own dedicated folder.
  const isolatedUserData = join(app.getPath('appData'), CAHE_APP_NAME)
  // Freeze Electron's auto-generated default User-Agent BEFORE renaming the app. Electron derives that
  // default from app.getName(), and app.getName() is about to become the accented "Métis" — reading
  // userAgentFallback's getter after that rename embeds the 'é' in the UA string every future request
  // uses. That single non-ASCII byte then corrupts the Request/Headers object Electron's own
  // protocol.handle bridge builds for EVERY fetch() in the whole app (not just this scheme): the bridge's
  // internal reconstruction of the request headers mis-decodes that one byte as an incomplete UTF-8
  // sequence, producing a literal U+FFFD, which fails Node's ByteString validation deep inside Electron's
  // bundled code — before any registered protocol.handle callback ever runs, and with no exception surfaced
  // to app code to catch. The visible symptom was every asr-model:// fetch (and in fact every fetch in the
  // app) rejecting with a generic "TypeError: Failed to fetch". Reading the getter now, while
  // app.getName() is still the packaged ASCII product name, and writing it straight back turns it into a
  // fixed override that setName() below can no longer influence — the accented taskbar/window branding is
  // unaffected; only the invisible, purely informational UA header stays ASCII.
  app.userAgentFallback = app.userAgentFallback
  app.setName(CAHE_DISPLAY_NAME)
  app.setPath('userData', isolatedUserData)
}

/**
 * Cahê ships with Kimi pre-configured out-of-the-box (embedded key + active-provider seed, both applied
 * once by cahe-embedded-key.ts on first run) so the pilot works with zero setup. That is a DEFAULT, not a
 * lock: the pilot user must be free to connect and switch to any other provider — Claude Code CLI, Codex
 * CLI, Dust (including picking its base/thinking agent), or a pasted API key — exactly like the
 * non-Cahê build, and have that choice persist across restarts. So the edition itself imposes no
 * allowlist, no locked keys, and no forced managed defaults; it is policy-identical to a non-Cahê build.
 * A real IT-deployed managed-config.json can still lock things down — that mechanism is untouched and
 * layers on top of this via getLockedKeys()/validatedManaged() in store.ts.
 */
export function caheEditionPolicy(_active = isCaheEdition()): CaheEditionPolicy {
  return { allowedProviders: null, lockedKeys: [], managedDefaults: {} }
}

/** Cahê is an isolated pilot package and must never consume the shared Métis release feed. */
export function shouldDisableAutoUpdate(active = isCaheEdition()): boolean {
  return active
}
