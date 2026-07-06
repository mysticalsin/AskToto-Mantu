import { app, type BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log'
import { IPC } from '@shared/ipc'
import { trustedAdminManagedPath } from './win-security'

/** Enterprise governance: IT can freeze the version fleet-wide by deploying an admin managed-config with
 *  `{ "disableAutoUpdate": true }`. Only the ADMIN (machine) policy is honored — and on Windows only via
 *  the ACL-trusted path — so a standard user cannot turn their own updates on or off. */
/** Pure: does this managed-config JSON text set `disableAutoUpdate: true`? Exported for tests. Any
 *  non-true value, missing key, or malformed JSON = not disabled (fail-open to updates on garbage). */
export function configDisablesAutoUpdate(configText: string): boolean {
  try {
    return JSON.parse(configText)?.disableAutoUpdate === true
  } catch {
    return false
  }
}

function autoUpdateDisabledByPolicy(): boolean {
  const p = trustedAdminManagedPath()
  if (!p) return false
  try {
    return configDisablesAutoUpdate(readFileSync(p, 'utf8'))
  } catch {
    return false
  }
}

/** A 404 means the releases repo/feed doesn't exist (yet) — distinct from a transient network/server
 *  error, which should keep logging normally so a real outage stays visible. */
const isNotFound = (e: unknown): boolean =>
  (e as { statusCode?: number } | null)?.statusCode === 404 || /\b404\b/.test(String((e as Error)?.message ?? e))

/** Enterprise auto-update. Only runs in the packaged app; needs a real `publish` host (electron-builder.yml). */
export function initAutoUpdate(win: BrowserWindow | null): void {
  if (!app.isPackaged) return
  // IT kill-switch: a managed-config policy can freeze the version fleet-wide (staged-rollout control).
  if (autoUpdateDisabledByPolicy()) {
    log.info('[updater] auto-update disabled by managed-config policy')
    return
  }
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
    // Lazy-required: electron-updater's require tree costs real time at every process boot even though
    // both early returns above already skip this function entirely in dev and in any unconfigured build
    // — only a packaged build with a real update host ever needs it loaded.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { autoUpdater } = require('electron-updater')
    autoUpdater.logger = log
    log.transports.file.level = 'info'
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    // AppUpdater's own constructor registers a default 'error' listener that unconditionally logs the
    // full stack via its logger, regardless of cause — on a 404 that's a full HttpError stack PLUS our
    // own warn below PLUS the checkForUpdatesAndNotify() rejection below (electron-updater both emits
    // 'error' AND rethrows into the promise), three lines for the exact same failure every launch.
    // Replace the default listener with our own so a 404 — the releases repo not existing yet, an
    // already-diagnosed, expected state — logs just one short line, while every other error keeps its
    // current (full-stack) visibility. Safe: an EventEmitter only throws on an unhandled 'error' emit
    // when there are NO listeners at all, and we always add one right after removing the default.
    autoUpdater.removeAllListeners('error')
    autoUpdater.on('error', (e: Error) => {
      if (isNotFound(e)) {
        log.warn('[updater] update feed not available (404)')
        return
      }
      // Non-404: keep the same full-stack visibility the removed default listener used to provide.
      log.warn('[updater] error', e?.stack || e?.message || e)
    })
    autoUpdater.on('update-available', (i: { version?: string }) => log.info('[updater] update-available', i?.version))
    autoUpdater.on('update-downloaded', (i: { version?: string }) => {
      log.info('[updater] downloaded', i?.version)
      // In-app banner (UpdateReadyToast) alongside the OS notification checkForUpdatesAndNotify already shows.
      win?.webContents.send(IPC.updateDownloaded, { version: i?.version })
    })
    // checkForUpdatesAndNotify shows the OS notification when an update is ready. The 'error' listener
    // above always fires first for the same failure and already logs it (short for 404, full for anything
    // else) — swallow it here silently rather than logging the identical failure a second time. Cadence
    // is untouched: this runs once per app launch, no interval.
    void autoUpdater.checkForUpdatesAndNotify().catch(() => {
      /* already logged by the 'error' listener above */
    })
  } catch (e) {
    log.warn('[updater] init failed', e)
  }
}
