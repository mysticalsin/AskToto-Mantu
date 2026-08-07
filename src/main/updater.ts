import { app, net, type BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log'
import { IPC, type UpdateCheckResult } from '@shared/ipc'
import { shouldDisableAutoUpdate } from './cahe-edition'
import { readTrustedAdminManaged } from './win-security'

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
  // readTrustedAdminManaged() reads through the same held fd that verified win32 admin-trust, closing
  // the check-path/read-path TOCTOU a `trustedAdminManagedPath() ? readFileSync(path) : ...` pattern
  // would reopen.
  const content = readTrustedAdminManaged()
  return content ? configDisablesAutoUpdate(content) : false
}

// ── Manual "Check for updates" (Settings → About) ────────────────────────────────────────────────
// electron-updater's silent flow above covers signed builds; this explicit check exists so EVERY build
// — including unsigned macOS ones, where electron-updater cannot install — can still tell the user a
// newer version was published and point them at the download page. Keep owner/repo in sync with
// electron-builder.yml's `publish` block (the public Metis-Releases feed).
const RELEASES_API = 'https://api.github.com/repos/mysticalsin/Metis-Releases/releases/latest'
const RELEASES_PAGE = 'https://github.com/mysticalsin/Metis-Releases/releases/latest'
const CHECK_TIMEOUT_MS = 8000

/** Plain numeric semver compare ('1.10.0' > '1.9.2'), leading 'v' tolerated, missing parts = 0.
 *  Prerelease suffixes are ignored on purpose — the releases feed only ever carries plain x.y.z tags. */
export function isNewerVersion(latest: string, current: string): boolean {
  const norm = (v: string): number[] =>
    v.trim().replace(/^v/i, '').split('.').map((p) => Number.parseInt(p, 10) || 0)
  const a = norm(latest)
  const b = norm(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

/** Pure: turn a GitHub "latest release" API payload into an UpdateCheckResult. Exported for tests. */
export function parseLatestRelease(payload: unknown, current: string): UpdateCheckResult {
  const tag = (payload as { tag_name?: unknown } | null)?.tag_name
  const htmlUrl = (payload as { html_url?: unknown } | null)?.html_url
  if (typeof tag !== 'string' || !tag.trim()) {
    return { ok: false, current, error: 'The release feed returned no version tag.' }
  }
  const latest = tag.trim().replace(/^v/i, '')
  return {
    ok: true,
    current,
    latest,
    available: isNewerVersion(latest, current),
    // Only ever open an https URL the feed itself provided; anything else falls back to the fixed page.
    url: typeof htmlUrl === 'string' && /^https:\/\//i.test(htmlUrl) ? htmlUrl : RELEASES_PAGE
  }
}

/** One on-demand check against the public releases feed. Never throws — every failure comes back as a
 *  short human-readable `error` for the Settings row. Uses Electron's net.fetch (honors the system
 *  proxy/PAC; plain fetch() in the main process does not — the exact bug behind commit 2a565de). */
export async function checkForUpdateNow(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS)
  try {
    const resp = await net.fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: ctrl.signal
    })
    if (!resp.ok) {
      return {
        ok: false,
        current,
        error: resp.status === 404 ? 'No published release found yet.' : `The release feed answered HTTP ${resp.status}.`
      }
    }
    return parseLatestRelease(await resp.json(), current)
  } catch {
    return { ok: false, current, error: 'Could not reach the update feed. Check your connection and try again.' }
  } finally {
    clearTimeout(timer)
  }
}

/** A 404 means the releases repo/feed doesn't exist (yet) — distinct from a transient network/server
 *  error, which should keep logging normally so a real outage stays visible. */
const isNotFound = (e: unknown): boolean =>
  (e as { statusCode?: number } | null)?.statusCode === 404 || /\b404\b/.test(String((e as Error)?.message ?? e))

/** Enterprise auto-update. Only runs in the packaged app; needs a real `publish` host (electron-builder.yml).
 *  Takes a GETTER rather than a captured window reference: if createWindow() threw during boot, the
 *  captured value would be permanently null even after ensureWindow() later self-heals and reassigns the
 *  module-level `win` — the update-downloaded toast would then be dead for the rest of the process life.
 *  Reading through the getter at send time always sees the live window. */
export function initAutoUpdate(getWin: () => BrowserWindow | null): void {
  if (shouldDisableAutoUpdate()) {
    log.info('[updater] Cahê edition uses its own distribution channel, skipping shared auto-update feed')
    return
  }
  // A portable .exe has no fixed install location electron-updater can replace — it's just a file the
  // user launched directly. Bail before any wiring so we never download an update we can't install and
  // never show UpdateReadyToast promising an install that will never happen.
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) {
    log.info('[updater] portable build — auto-update unavailable, skipping')
    return
  }
  if (!app.isPackaged) return
  if ((process as NodeJS.Process & { mas?: boolean }).mas) return
  // The Store (MSIX/AppX) build must never self-update: updating a packaged app is the Store's job,
  // and a packaged app installing software outside its own package is a certification violation.
  // Electron sets process.windowsStore for any MSIX/AppX package. Without this the only thing keeping
  // the updater quiet is that electron-builder happens not to write app-update.yml for an appx-only
  // target — and that does not hold when the nsis and appx targets share release/win-unpacked (which
  // both CI and the documented Store flow do), because AppXTarget packs the whole directory. The Store
  // copy would then download the 1.4 GB NSIS installer and either promise a restart that never
  // installs, or lay down a second non-Store copy alongside itself.
  if ((process as NodeJS.Process & { windowsStore?: boolean }).windowsStore) {
    log.info('[updater] Store package — updates are the Store\'s job, skipping')
    return
  }
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
    autoUpdater.on(
      'update-downloaded',
      (i: { version?: string; releaseNotes?: string | Array<{ note?: string | null }> | null }) => {
        log.info('[updater] downloaded', i?.version)
        // Ship the release notes (the GitHub release body) with the version so the in-app UpdateReadyToast
        // can show a "What's new" panel — the user sees what changed before choosing to restart & apply.
        const raw = i?.releaseNotes
        const notes =
          typeof raw === 'string'
            ? raw.trim() || undefined
            : Array.isArray(raw)
              ? raw.map((x) => String(x?.note ?? '')).filter(Boolean).join('\n\n').trim() || undefined
              : undefined
        // In-app banner (UpdateReadyToast) alongside the OS notification checkForUpdatesAndNotify already shows.
        getWin()?.webContents.send(IPC.updateDownloaded, { version: i?.version, notes })
      }
    )
    // Stream download progress to the renderer so the update UI can show a "Downloading… X%" state rather
    // than a silent wait before the ready toast appears.
    autoUpdater.on('download-progress', (p: { percent?: number }) => {
      getWin()?.webContents.send(IPC.updateProgress, { percent: Math.round(p?.percent ?? 0) })
    })
    // checkForUpdatesAndNotify shows the OS notification when an update is ready; the 'error' listener above
    // already logs any failure (short for 404, full otherwise), so swallow the duplicate rejection here.
    const check = (): void => {
      void autoUpdater.checkForUpdatesAndNotify().catch(() => {
        /* already logged by the 'error' listener above */
      })
    }
    check()
    // Re-check every 6h so a long-running app picks up a release the SAME day, not only at the next launch.
    // Cleared on will-quit: an update check resolving over the network mid-teardown is exactly the
    // shutdown-race that can SIGTRAP a killed/driven process (see backgroundTimers in index.ts).
    const recheck = setInterval(check, 6 * 60 * 60 * 1000)
    app.on('will-quit', () => clearInterval(recheck))
  } catch (e) {
    log.warn('[updater] init failed', e)
  }
}
