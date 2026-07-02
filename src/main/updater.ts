import { app, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log'
import { IPC } from '@shared/ipc'

// Backoff sidecar: a bare epoch-ms timestamp of the last 404 (releases repo/feed not found yet). One
// check runs per app launch (no interval — see initAutoUpdate below), so this must survive across
// restarts to actually skip anything; a module-level variable would reset every boot and never fire.
// Same userData-sidecar idiom as auth.ts's auth-configured.flag / msal-cache.bin.
const BACKOFF_HOURS = 24
const backoffPath = (): string => join(app.getPath('userData'), 'updater-404-backoff.txt')

function readBackoffUntil(): number {
  try {
    return Number(readFileSync(backoffPath(), 'utf8')) || 0
  } catch {
    return 0 // no sidecar yet — never backed off
  }
}

function writeBackoffUntil(untilMs: number): void {
  try {
    writeFileSync(backoffPath(), String(untilMs), 'utf8')
  } catch {
    /* best-effort — worst case a future 404 just logs once more than strictly needed */
  }
}

/** A 404 means the releases repo/feed doesn't exist (yet) — distinct from a transient network/server
 *  error, which should keep logging normally so a real outage stays visible. */
const isNotFound = (e: unknown): boolean =>
  (e as { statusCode?: number } | null)?.statusCode === 404 || /\b404\b/.test(String((e as Error)?.message ?? e))

/** Enterprise auto-update. Only runs in the packaged app; needs a real `publish` host (electron-builder.yml). */
export function initAutoUpdate(win: BrowserWindow | null): void {
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
  // A prior check already found the feed 404ing (repo not published yet) — skip the network round-trip
  // entirely rather than repeat a check guaranteed to fail the same way, until the backoff window lapses.
  const backoffUntil = readBackoffUntil()
  if (backoffUntil > Date.now()) {
    const hoursLeft = Math.ceil((backoffUntil - Date.now()) / 3_600_000)
    log.warn(`[updater] update feed not available (404) — next check in ${hoursLeft}h`)
    return
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
    autoUpdater.on('error', (e: Error) => {
      // A 404 is the expected, already-diagnosed "releases repo doesn't exist yet" case — one short line
      // instead of electron-updater's own default listener (a full stack dump) plus this handler plus the
      // checkForUpdatesAndNotify() rejection below, three log lines for the exact same failure every launch.
      if (isNotFound(e)) {
        writeBackoffUntil(Date.now() + BACKOFF_HOURS * 3_600_000)
        log.warn(`[updater] update feed not available (404) — next check in ${BACKOFF_HOURS}h`)
        return
      }
      log.warn('[updater] error', e?.message ?? e)
    })
    autoUpdater.on('update-available', (i: { version?: string }) => log.info('[updater] update-available', i?.version))
    autoUpdater.on('update-downloaded', (i: { version?: string }) => {
      log.info('[updater] downloaded', i?.version)
      // In-app banner (UpdateReadyToast) alongside the OS notification checkForUpdatesAndNotify already shows.
      win?.webContents.send(IPC.updateDownloaded, { version: i?.version })
    })
    // checkForUpdatesAndNotify shows the OS notification when an update is ready. The 'error' listener
    // above always fires first for the same failure and already logs it (short for 404, full for anything
    // else) — swallow it here silently rather than logging the identical failure a second time.
    void autoUpdater.checkForUpdatesAndNotify().catch(() => {
      /* already logged by the 'error' listener above */
    })
  } catch (e) {
    log.warn('[updater] init failed', e)
  }
}
