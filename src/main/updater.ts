import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pkg from 'electron-updater'
import log from 'electron-log'

const { autoUpdater } = pkg

/** Enterprise auto-update. Only runs in the packaged app; needs a real `publish` host (electron-builder.yml). */
export function initAutoUpdate(): void {
  if (!app.isPackaged) return
  // Skip if no real update host is configured (placeholder) — avoids failing checks every launch.
  try {
    const yml = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')
    if (yml.includes('REPLACE-WITH')) {
      log.info('[updater] no update host configured — skipping auto-update')
      return
    }
  } catch {
    return // no app-update.yml → updates not set up
  }
  try {
    autoUpdater.logger = log
    log.transports.file.level = 'info'
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('error', (e) => log.warn('[updater] error', e?.message ?? e))
    autoUpdater.on('update-downloaded', (i) => log.info('[updater] downloaded', i?.version))
    // checkForUpdatesAndNotify shows the OS notification when an update is ready.
    void autoUpdater.checkForUpdatesAndNotify().catch((e) => log.warn('[updater] check failed', e?.message ?? e))
  } catch (e) {
    log.warn('[updater] init failed', e)
  }
}
