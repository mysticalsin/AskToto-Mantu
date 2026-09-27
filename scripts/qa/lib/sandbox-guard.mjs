// W0-HERMETIC (M2-0190) — any harness that drives a REAL running app over CDP (e2e-workflows.mjs,
// exhaustion-sim.mjs) must confirm the ATTACHED APP is sandboxed before it touches that app's
// settings/brain/API-keys on disk.
//
// The only source of truth for "is THIS app sandboxed" is what the ATTACHED APP itself reports —
// getSettings().resolvedMeetingsFolder — never this harness's own process.env.ASKTOTO_USERDATA: the
// documented launch (`ASKTOTO_USERDATA=<dir> ./electron ...`) sets that variable only on the spawned app
// process, so a harness shell can disagree with the app it drives in either direction. A
// resolvedMeetingsFolder is accepted ONLY when it resolves inside the OS temp dir (where an
// ASKTOTO_USERDATA-launched profile lives): an explicit settings.meetingsFolder can point anywhere — a
// mounted volume, a network share, a moved OneDrive root — while every other real setting, API key and
// brain index on that profile is still the real one, so "outside the home directory" is never itself
// proof of isolation. Both harnesses already read and delete files from underneath this folder, which is
// why the check runs before either touches settings, brain or API keys.
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * True when `child` resolves inside (or equal to) `parent`, compared as real path segments via
 * `path.relative` — a string-prefix compare would treat `<parent> - Other` as inside `<parent>`, and
 * needs a separate `sep`-aware case for every platform; `path.relative` handles both for free.
 *
 * `rel === '..' || rel.startsWith('..' + sep)` (not a bare `rel.startsWith('..')`) so a real subdirectory
 * of `parent` that happens to be named e.g. `..foo` is never misread as a `..` traversal segment and
 * reported as outside `parent`.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/**
 * Throws unless `meetingsFolder` — the ATTACHED APP's own reported
 * `getSettings().resolvedMeetingsFolder`, never a launching shell's environment — resolves under
 * `tmpDir`. This is a necessary condition that fails closed: it rejects every profile whose
 * meetingsFolder was never redirected under `tmpDir` at all, including one that merely resolves outside
 * `homeDir` (an explicit settings.meetingsFolder can point anywhere — a mounted volume, a network share —
 * so that alone is never proof of isolation). It is not sufficient: resolveMeetingsFolder honors an
 * explicit settings.meetingsFolder before any ASKTOTO_USERDATA-derived default, so a real, unsandboxed
 * profile whose meetingsFolder happens to already be set under `tmpDir` still passes this check with
 * every other real setting, API key and brain index on it untouched.
 *
 * `homeDir` and `tmpDir` are parameters (never read internally via `os.homedir()`/`os.tmpdir()`) so a
 * test can exercise every case without a real home or temp directory.
 *
 * @param {{ meetingsFolder: string | undefined, homeDir: string, tmpDir: string }} args
 * @returns {void}
 */
export function assertSandboxedMeetingsFolder({ meetingsFolder, homeDir, tmpDir }) {
  if (!meetingsFolder) {
    throw new Error(
      'The attached app reported no resolvedMeetingsFolder. This harness drives a REAL running app and ' +
        'mutates its settings/brain/API-keys on disk — launch it with ASKTOTO_USERDATA=<a dir under the ' +
        "OS temp dir> set (see this harness's own header), or it falls back to the real developer profile."
    )
  }
  const resolved = resolve(meetingsFolder)
  if (isInside(tmpDir, resolved)) return
  if (isInside(homeDir, resolved)) {
    throw new Error(
      `The attached app's resolvedMeetingsFolder (${meetingsFolder}) resolves inside the real home ` +
        `directory (${homeDir}) — the real synced meetings store, the real Métis userData profile and ` +
        'other real user state can all live there. Relaunch the app with ASKTOTO_USERDATA pointed at a ' +
        'directory under the OS temp dir instead.'
    )
  }
  throw new Error(
    `The attached app's resolvedMeetingsFolder (${meetingsFolder}) does not resolve under the OS temp ` +
      `directory (${tmpDir}). Resolving outside the home directory (${homeDir}) is not proof of an ` +
      'isolated profile by itself — an explicit settings.meetingsFolder can point anywhere (a mounted ' +
      'volume, a network share, a moved OneDrive root) while every other real setting, API key and brain ' +
      'index on that profile is still the real one. Relaunch the app with ASKTOTO_USERDATA pointed at a ' +
      'directory under the OS temp dir instead.'
  )
}

/**
 * Queries the CDP-attached app for its own `resolvedMeetingsFolder` and throws unless it is sandboxed.
 * The one call both e2e-workflows.mjs and exhaustion-sim.mjs make right after connecting — before either
 * touches that app's settings, API keys or brain on disk — so both harnesses check the same live app
 * state instead of each keeping (or skipping) its own copy of this guard.
 *
 * @param {{ evaluate: (fn: () => unknown) => Promise<unknown> }} page a Playwright page connected to the app over CDP
 * @param {{ homeDir?: string, tmpDir?: string }} [overrides] test-only escape hatch; production callers take the defaults
 * @returns {Promise<void>}
 */
export async function assertAttachedAppIsSandboxed(page, { homeDir = homedir(), tmpDir = tmpdir() } = {}) {
  const meetingsFolder = await page.evaluate(async () => (await window.toto.getSettings()).resolvedMeetingsFolder)
  assertSandboxedMeetingsFolder({ meetingsFolder, homeDir, tmpDir })
}
