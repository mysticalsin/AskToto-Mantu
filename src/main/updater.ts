import { app, net, Notification, type BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Via logger.ts, never `electron-log` directly: logger.ts is where the app's logging policy lives,
// including the redirect that keeps a non-app process (a vitest worker) out of the installed app's
// %APPDATA%/asktoto/logs/main.log. That redirect is a module-load side effect, so a module that reaches
// the electron-log singleton without loading logger.ts silently writes into the real user's log.
import { mainLog as log } from './logger'
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

/** Pure: the admin managed-config's private update feed URL, or null. Only an https:// URL is honored —
 *  anything else (http, a path, garbage, malformed JSON) means "use the built-in feed". Exported for
 *  tests. */
export function configUpdateFeedUrl(configText: string): string | null {
  try {
    const v = (JSON.parse(configText) as { updateFeedUrl?: unknown })?.updateFeedUrl
    return typeof v === 'string' && /^https:\/\//i.test(v.trim()) ? v.trim() : null
  } catch {
    return null
  }
}

/**
 * Enterprise: point electron-updater at an internally hosted feed instead of the public GitHub repo.
 * Deliberately ADMIN-policy only (same ACL-trusted path as disableAutoUpdate) — a per-user or
 * user-writable config must never be able to redirect the update channel, because whoever controls the
 * feed controls what binary gets offered. Signature verification (verifyUpdateCodeSignature) still
 * applies to whatever the feed serves; this is routing, not trust. The feed is a `generic` provider:
 * an HTTPS directory serving latest.yml + the installer, which IT can host on any internal static host.
 */
function applyAdminUpdateFeed(autoUpdater: { setFeedURL: (opts: { provider: string; url: string }) => void }): void {
  const content = readTrustedAdminManaged()
  const url = content ? configUpdateFeedUrl(content) : null
  if (url) {
    autoUpdater.setFeedURL({ provider: 'generic', url })
    log.info(`[updater] using the org's private update feed (admin policy): ${url}`)
  }
}

/** Which channel rule forbids this install from consuming the shared Métis release feed, or null. */
export type BlockedUpdateChannel = 'cahe' | 'store' | 'policy'

/**
 * ONE predicate, because BOTH entry points have to honor it: the silent electron-updater flow below and
 * the manual Settings → About check, which auto-fires whenever the About tab mounts. While these lived
 * only inside initAutoUpdate, the manual check queried the shared feed unconditionally and offered a
 * Cahê pilot the standard Métis installer — a different app (appId com.mantu.asktoto, profile
 * %APPDATA%\Metis) with none of the pilot's state — plus an out-of-band download link to a Store package
 * and to a fleet its own IT had frozen.
 * - Cahê is an isolated pilot package distributed as its own installer (see cahe-edition.ts).
 * - The Store (MSIX/AppX) build must never self-update: updating a packaged app is the Store's job, and
 *   a packaged app installing software outside its own package is a certification violation. Electron
 *   sets process.windowsStore for any MSIX/AppX package. Without this the only thing keeping the updater
 *   quiet is that electron-builder happens not to write app-update.yml for an appx-only target — and that
 *   does not hold when the nsis and appx targets share release/win-unpacked (which both CI and the
 *   documented Store flow do), because AppXTarget packs the whole directory. The Store copy would then
 *   download the 1.4 GB NSIS installer and either promise a restart that never installs, or lay down a
 *   second non-Store copy alongside itself.
 * - The IT kill-switch freezes the version fleet-wide (staged-rollout control).
 */
export function blockedUpdateChannel(): BlockedUpdateChannel | null {
  if (shouldDisableAutoUpdate()) return 'cahe'
  if ((process as NodeJS.Process & { windowsStore?: boolean }).windowsStore) return 'store'
  if (autoUpdateDisabledByPolicy()) return 'policy'
  return null
}

const BLOCKED_LOG: Record<BlockedUpdateChannel, string> = {
  cahe: 'Cahê edition uses its own distribution channel, skipping shared auto-update feed',
  store: "Store package — updates are the Store's job, skipping",
  policy: 'auto-update disabled by managed-config policy'
}

/** What the Settings → About row says instead of linking to a feed this install must not install from. */
const BLOCKED_MESSAGE: Record<BlockedUpdateChannel, string> = {
  cahe: 'This pilot is updated with a new Cahê installer, not from the shared Métis release feed.',
  store: 'Updates for this package come from the Microsoft Store.',
  policy: 'Updates are managed by your organisation.'
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

/** Latest must be a published, non-prerelease tag. Draft / prerelease is not QA-approved. */
export function latestReleaseIsOfferable(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
  if (typeof p.tag_name !== 'string' || !p.tag_name.trim()) return false
  if (p.draft === true || p.prerelease === true) return false
  return true
}

/** Filenames a public Latest must carry (EXE + DMG + Native). Publish only after Bob QA + Ultron. */
export const LATEST_REQUIRED_ASSET_PATTERNS = [
  /^Metis-\d+\.\d+\.\d+\.dmg$/,
  /^Metis-Setup-\d+\.\d+\.\d+\.exe$/,
  /^Metis-Native-\d+\.\d+\.\d+\.zip$/
] as const

/** True when the GitHub Latest payload lists all three customer installers. */
export function latestReleaseHasApprovedInstallers(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const assets = (payload as { assets?: unknown }).assets
  if (!Array.isArray(assets)) return false
  const names = assets.map((a) =>
    a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string'
      ? (a as { name: string }).name
      : ''
  )
  return LATEST_REQUIRED_ASSET_PATTERNS.every((re) => names.some((n) => re.test(n)))
}

/** Pure: turn a GitHub "latest release" API payload into an UpdateCheckResult. Exported for tests. */
export function parseLatestRelease(payload: unknown, current: string): UpdateCheckResult {
  if (!latestReleaseIsOfferable(payload)) {
    return {
      ok: false,
      current,
      error: 'No QA-approved Latest release is published yet.'
    }
  }
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
  // Answer from the channel's own rule BEFORE touching the network: this runs on every About open, so an
  // unguarded check both contacts the shared feed from installs that must never consume it and renders a
  // download link to the wrong installer. Reported as a plain message rather than a version comparison —
  // there is nothing on that feed this install is allowed to follow.
  const blocked = blockedUpdateChannel()
  if (blocked) return { ok: false, current, error: BLOCKED_MESSAGE[blocked] }
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

/** True only while a download THIS process started (Settings → "Download & install") is running.
 *  electron-updater emits one 'error' event for every failure — the silent boot / 6-hourly check
 *  included — and turning an untouched Settings row into a scary failure the user never asked for is
 *  worse than staying quiet, so only an in-flight download may raise a user-facing error. */
let downloadInFlight = false

/** Result of asking the app to download-and-install an update in place (Settings → Update now). */
export interface UpdateDownloadStart {
  /** True when the electron-updater download was kicked off; progress/ready then arrive via IPC events. */
  started: boolean
  /** Why it could not start in-app (channel blocked, portable, or not the installed app) — the UI then
   *  falls back to the download-page link. Absent when started. */
  reason?: string
}

/**
 * Trigger the in-app download+install (Settings "Update now" button). electron-updater's autoDownload is
 * on and initAutoUpdate (same guards, on boot) already registered the download-progress / update-downloaded
 * listeners that stream to the renderer — this just kicks a fresh find-and-download, so the Settings row can
 * show "Downloading… X%" and then "Restart & install" (quitAndInstall via IPC.updateInstall). Only the
 * installed, non-blocked build can self-install; every other case returns a reason so the UI shows the
 * download-page link instead of a button that could never finish.
 */
export async function startUpdateDownload(): Promise<UpdateDownloadStart> {
  const blocked = blockedUpdateChannel()
  if (blocked) return { started: false, reason: BLOCKED_MESSAGE[blocked] }
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) {
    return { started: false, reason: 'This portable build cannot self-install — use the installer from the releases page.' }
  }
  if (!app.isPackaged) return { started: false, reason: 'In-app update is only available in the installed app.' }
  if ((process as NodeJS.Process & { mas?: boolean }).mas) {
    return { started: false, reason: 'Updates for this build come from the App Store.' }
  }
  // The macOS build is ad-hoc signed, not Developer ID. Squirrel.Mac only swaps in an update whose
  // signature satisfies the running bundle's designated requirement, and an ad-hoc signature never
  // does — but electron-updater cannot tell us that: MacUpdater dispatches 'update-downloaded' (which
  // pops UpdateReadyToast and flips this row to "Restart & install now") BEFORE it hands anything to
  // Squirrel, and quitAndInstall() then just waits on an 'update-downloaded' from the native updater
  // that never arrives. Without this guard a Mac user downloads ~1.09 GB and clicks a dead button.
  // Send them to the DMG instead, which is the only route that actually installs today.
  // DELETE THIS GUARD in the same commit that enrols CSC_LINK / APPLE_ID / APPLE_TEAM_ID and moves
  // release.yml's signing mode to developer-id — see docs/ENTERPRISE_RELEASE.md, Operator Setup step 7.
  if (process.platform === 'darwin') {
    return {
      started: false,
      reason: 'This macOS build must be installed from the .dmg — open the download page.'
    }
  }
  // Same GitHub Latest gate as Settings → Check. electron-updater reads latest.yml; this call
  // refuses draft / prerelease / "not newer" so the button cannot start a download the feed
  // must not offer. Bob QA + Ultron stamp is what publishes Latest.
  const feed = await checkForUpdateNow()
  if (!feed.ok) return { started: false, reason: feed.error }
  if (!feed.available) {
    return { started: false, reason: 'No QA-approved update is available.' }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { autoUpdater } = require('electron-updater')
    applyAdminUpdateFeed(autoUpdater)
    // checkForUpdates() resolves as soon as the FEED answers — the download it kicked off is still
    // running behind `downloadPromise`, so "started" can only mean "there is a download to watch".
    const downloadPromise = (await autoUpdater.checkForUpdates())?.downloadPromise
    if (!downloadPromise) return { started: false, reason: 'No update is available to download right now.' }
    downloadInFlight = true
    // Own the promise electron-updater hands back. Its failure is reported to the renderer by the 'error'
    // listener in initAutoUpdate; left unheld it also reaches index.ts's unhandledRejection hook, which
    // persists an app.crash audit line and a crash-*.log for a download that merely failed.
    const settle = (): void => {
      downloadInFlight = false
    }
    void downloadPromise.then(settle, settle)
    return { started: true }
  } catch (e) {
    return { started: false, reason: (e as Error)?.message || 'Could not start the update download.' }
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
  const blocked = blockedUpdateChannel()
  if (blocked) {
    log.info(`[updater] ${BLOCKED_LOG[blocked]}`)
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
  // Same reason as the darwin guard in startUpdateDownload: Squirrel.Mac cannot install over an
  // ad-hoc-signed bundle, and electron-updater announces success before it finds that out. Bail
  // before any wiring so no background download runs and UpdateReadyToast never promises an install
  // that cannot happen. Delete alongside that guard when Developer ID signing lands.
  if (process.platform === 'darwin') {
    log.info('[updater] ad-hoc signed macOS build — in-app install unavailable, skipping')
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
    applyAdminUpdateFeed(autoUpdater)
    autoUpdater.logger = log
    log.transports.file.level = 'info'
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    // Latest is the only channel. A prerelease or draft must never be offered or installed, even if
    // someone uploaded latest.yml beside one. QA + Ultron stamp is what makes a tag Latest.
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    // AppUpdater's own constructor registers a default 'error' listener that unconditionally logs the
    // full stack via its logger, regardless of cause — on a 404 that's a full HttpError stack PLUS our
    // own warn below PLUS the check() rejection below (electron-updater both emits 'error' AND rethrows
    // into the promise), three lines for the exact same failure every launch.
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
      // A download the user is watching just died. Tell the renderer so the Settings row leaves its
      // progress bar and offers the download page — the message is ours, never electron-updater's, whose
      // text embeds the feed URL and request context (nothing crosses the bridge unredacted).
      if (downloadInFlight) {
        downloadInFlight = false
        getWin()?.webContents.send(IPC.updateError, {
          message: 'The update download failed. Open the download page to install manually.'
        })
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
        getWin()?.webContents.send(IPC.updateDownloaded, { version: i?.version, notes })
        // The OS notification checkForUpdatesAndNotify used to raise (see check() below for why it is
        // gone). Skipped for a download the user started from Settings — they are already watching that
        // row, and the in-app UpdateReadyToast lands either way.
        if (!downloadInFlight && Notification.isSupported()) {
          new Notification({
            title: 'A new update is ready to install',
            body: `${app.name} version ${i?.version} has been downloaded and will be automatically installed on exit`
          }).show()
        }
      }
    )
    // Stream download progress to the renderer so the update UI can show a "Downloading… X%" state rather
    // than a silent wait before the ready toast appears.
    autoUpdater.on('download-progress', (p: { percent?: number }) => {
      getWin()?.webContents.send(IPC.updateProgress, { percent: Math.round(p?.percent ?? 0) })
    })
    // NOT checkForUpdatesAndNotify: it fires its OS notification from `void it.downloadPromise.then(…)`,
    // a derived promise it never handles and we cannot reach, so every failed background download became
    // an unhandledRejection — i.e. a crash-*.log and an `app.crash` audit line for a failed download. Hold
    // the download promise ourselves; the notification now comes from the update-downloaded listener above.
    // The 'error' listener already logs any failure (short for 404, full otherwise), so swallow the
    // duplicate rejection here.
    const check = (): void => {
      void autoUpdater
        .checkForUpdates()
        .then((r: { downloadPromise?: Promise<unknown> | null } | null) => {
          void r?.downloadPromise?.catch(() => {
            /* already logged by the 'error' listener above */
          })
        })
        .catch(() => {
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
