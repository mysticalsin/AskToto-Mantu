// W0-HERMETIC (M2-0190) — any harness that drives a REAL running app over CDP (e2e-workflows.mjs,
// exhaustion-sim.mjs) must confirm the ATTACHED APP is sandboxed before it touches that app's
// settings/brain/API-keys on disk.
//
// Round-2 finding: the previous version of this guard checked the HARNESS's own process.env.
// ASKTOTO_USERDATA, not the app it is about to mutate. The documented launch
// (`ASKTOTO_USERDATA=<dir> ./electron ...`) sets that variable only on the spawned app process, so a
// harness shell that never exported it was refused with a message telling the operator to do what they
// already did — and a harness shell that happened to have it set (e.g. inherited from a parent shell)
// passed even while the attached app ran on the real, unsandboxed profile. The only source of truth for
// "is THIS app sandboxed" is what the app itself reports: getSettings().resolvedMeetingsFolder resolves
// inside ASKTOTO_USERDATA when that variable was set on the app (main/index.ts), and both harnesses
// already read and delete files from underneath it.
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
 * `tmpDir`, or outside `homeDir` entirely.
 *
 * `homeDir` and `tmpDir` are parameters (never read internally via `os.homedir()`/`os.tmpdir()`) so a
 * test can exercise every case without a real home or temp directory.
 *
 * @param {{ meetingsFolder: string | undefined, homeDir: string, tmpDir: string }} args
 * @returns {true}
 */
export function assertSandboxedMeetingsFolder({ meetingsFolder, homeDir, tmpDir }) {
  if (!meetingsFolder) {
    throw new Error(
      'The attached app reported no resolvedMeetingsFolder. This harness drives a REAL running app and ' +
        'mutates its settings/brain/API-keys on disk — launch it with ASKTOTO_USERDATA=<an isolated dir> ' +
        'set (see this harness\'s own header), or it falls back to the real developer profile.'
    )
  }
  const resolved = resolve(meetingsFolder)
  if (isInside(tmpDir, resolved)) return true
  if (isInside(homeDir, resolved)) {
    throw new Error(
      `The attached app's resolvedMeetingsFolder (${meetingsFolder}) resolves inside the real home ` +
        `directory (${homeDir}) — the real synced meetings store, the real Métis userData profile and ` +
        'other real user state can all live there. Relaunch the app with ASKTOTO_USERDATA pointed at a ' +
        'directory under the OS temp dir instead.'
    )
  }
  return true
}

/**
 * Queries the CDP-attached app for its own `resolvedMeetingsFolder` and throws unless it is sandboxed.
 * The one call both e2e-workflows.mjs and exhaustion-sim.mjs make right after connecting — before either
 * touches that app's settings, API keys or brain on disk — so both harnesses check the same live app
 * state instead of each keeping (or skipping) its own copy of this guard.
 *
 * @param {{ evaluate: (fn: () => unknown) => Promise<unknown> }} page a Playwright page connected to the app over CDP
 * @param {{ homeDir?: string, tmpDir?: string }} [overrides] test-only escape hatch; production callers take the defaults
 * @returns {Promise<true>}
 */
export async function assertAttachedAppIsSandboxed(page, { homeDir = homedir(), tmpDir = tmpdir() } = {}) {
  const meetingsFolder = await page.evaluate(async () => (await window.toto.getSettings()).resolvedMeetingsFolder)
  return assertSandboxedMeetingsFolder({ meetingsFolder, homeDir, tmpDir })
}
