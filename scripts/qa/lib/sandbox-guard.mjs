// W0-HERMETIC (M2-0190) — e2e-workflows.mjs's own header has documented, since it was written, that it
// must be pointed at an isolated profile ("ASKTOTO_USERDATA=<dir> ... — the only reliable isolation
// switch"), but nothing ever checked that the operator actually did it. This harness drives a REAL
// running app over CDP and, per its own doc comment, exercises "real settings on disk" — an app
// launched without ASKTOTO_USERDATA set falls back to the developer's real profile, and this suite
// would then mutate meetings folders, provider keys and brain state there. `assertSandboxedUserData`
// is the check that was missing: called once, at the top of any harness that relies on that prerequisite,
// before it touches anything.
import { join, resolve } from 'node:path'

/**
 * Throws a descriptive error unless `userDataDir` is set and does not resolve under `homeDir`'s real
 * cloud-synced folders (`Library/CloudStorage`, `OneDrive`) — the same two hazards M2-0001 closed for
 * vitest. `homeDir` is a parameter (not read internally via `os.homedir()`) so a test can exercise both
 * the safe and unsafe cases without needing a real home directory at all.
 *
 * @param {{ userDataDir: string | undefined, homeDir: string }} args
 * @returns {true}
 */
export function assertSandboxedUserData({ userDataDir, homeDir }) {
  if (!userDataDir) {
    throw new Error(
      'ASKTOTO_USERDATA is unset. This harness drives a REAL running app and mutates its settings/brain ' +
        'on disk — launch the app with ASKTOTO_USERDATA=<an isolated dir> set (see this file\'s own header), ' +
        'or it falls back to the real developer profile.'
    )
  }
  const resolvedUserData = resolve(userDataDir)
  const realCloudStorage = resolve(join(homeDir, 'Library', 'CloudStorage'))
  const realOneDrive = resolve(join(homeDir, 'OneDrive'))
  const underRealCloudStorage = resolvedUserData === realCloudStorage || resolvedUserData.startsWith(realCloudStorage + '/')
  const underRealOneDrive = resolvedUserData === realOneDrive || resolvedUserData.startsWith(realOneDrive + '/')
  if (underRealCloudStorage || underRealOneDrive) {
    throw new Error(`ASKTOTO_USERDATA (${userDataDir}) resolves inside the real synced meetings store — point it at an isolated directory instead.`)
  }
  return true
}
