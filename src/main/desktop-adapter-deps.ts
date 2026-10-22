/**
 * Production wiring for the desktop adapters (V03): the real OS-facing pieces behind the injected interfaces.
 *
 * Everything that can raise a system prompt is absent here by design: the Accessibility read never asks
 * (`isTrustedAccessibilityClient(false)`), and the Automation read is the helper's `tcc-status` preflight (G10),
 * which cannot prompt either. A missing helper or any failure reads as unknown, never as granted.
 */
import { access, mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { DesktopAdapterDeps, NoteFileSystem } from './desktop-adapters'
import { createFrontmostVerifier } from './desktop-frontmost-verifier'
import { startForegroundWatcher } from './foreground-watcher'
import { createDesktopPermissionProbes } from './desktop-permission-probes'
import { mainLog } from './logger'

const noteFileSystem: NoteFileSystem = {
  async mkdir(directory) {
    await mkdir(directory, { recursive: true })
  },
  async writeNewFile(file, contents) {
    // `wx`: never overwrite an existing file. The adapter picks the next free name on EEXIST.
    await writeFile(file, contents, { flag: 'wx', encoding: 'utf8' })
  },
  async sizeOf(file) {
    return (await stat(file)).size
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function createProductionDesktopAdapterDeps(
  platform: NodeJS.Platform = process.platform
): Partial<DesktopAdapterDeps> {
  if (platform === 'win32') {
    return {
      documentsDir: () => {
        try {
          return app.getPath('documents')
        } catch {
          return null
        }
      },
      notesFs: noteFileSystem
    }
  }
  if (platform !== 'darwin') return {}
  const probes = createDesktopPermissionProbes(platform)
  return {
    frontmost: createFrontmostVerifier({
      start: (onChange) =>
        startForegroundWatcher(onChange, {
          onError: (message) => mainLog.warn(`[desktop-adapters] frontmost: ${message}`)
        })
    }),
    automationStatus: async (bundleId) => (await probes.automationStatus(bundleId, { ask: false })) ?? 'unknown',
    accessibilityTrusted: probes.accessibilityTrusted,
    macAppInstalled: async () =>
      (await exists('/Applications/Arc.app')) || (await exists(join(homedir(), 'Applications', 'Arc.app')))
  }
}
