import { app } from 'electron'
import { join } from 'node:path'

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
 * limited to local test/build harnesses; installed copies identify themselves from their executable name.
 */
export function detectCaheEdition({ platform, packaged, executablePath, environment }: CaheRuntime): boolean {
  if (environment.METIS_CAHE_EDITION === '1') return true
  const executable = executablePath.split(/[\\/]/).at(-1)?.toLowerCase()
  return platform === 'win32' && packaged && executable === CAHE_EXECUTABLE_NAME.toLowerCase()
}

export function isCaheEdition(): boolean {
  return detectCaheEdition({
    platform: process.platform,
    packaged: app.isPackaged,
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
  app.setName(CAHE_DISPLAY_NAME)
  app.setPath('userData', isolatedUserData)
}

/**
 * Cahê keeps Kimi as the active cloud provider for live questions and screenshot analysis. Dust stays
 * allowed so its CLI session and agent configuration can be connected without replacing Kimi.
 */
export function caheEditionPolicy(active = isCaheEdition()): CaheEditionPolicy {
  if (!active) return { allowedProviders: null, lockedKeys: [], managedDefaults: {} }
  return {
    allowedProviders: ['kimi', 'dust'],
    lockedKeys: ['provider', 'providerPriority'],
    managedDefaults: { provider: 'kimi', providerPriority: 'api' }
  }
}

/** Cahê is an isolated pilot package and must never consume the shared Métis release feed. */
export function shouldDisableAutoUpdate(active = isCaheEdition()): boolean {
  return active
}
