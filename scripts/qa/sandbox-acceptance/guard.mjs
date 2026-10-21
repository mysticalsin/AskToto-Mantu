// WP14 sandbox acceptance guard. Pure refusal logic for installed-app acceptance of the QA-identity build
// ("Metis QA.app", com.mantu.asktoto.qa). Nothing here launches, installs or writes: every function either
// returns a verdict or throws GuardError, so the CLIs can run the same checks in --dry-run and for real.
//
// Owner decision 2026-10-21: installed acceptance happens ONLY inside <repo>/_relay/goal-loop/sandbox-home/,
// launched only through _relay/goal-loop/isolate.sh, QA identity only, synthetic audio only. The checks below
// are an allow-list: a path, bundle id or environment value that cannot be PROVEN inside the sandbox is refused.
//
// Refused outright (the launchd/LaunchServices/AppleScript routes that leak into the owner's real session):
// `open`, `launchctl`, `osascript`. scripts/qa/packaged-smoke.mjs and fault-fatal-relaunch.mjs use them and
// must never be reused from here.
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const QA_BUNDLE_ID = 'com.mantu.asktoto.qa'
export const REAL_BUNDLE_ID = 'com.mantu.asktoto'
export const FORBIDDEN_COMMANDS = Object.freeze(['open', 'launchctl', 'osascript'])
/** Trailing path segments of the only sandbox root this tooling accepts. */
export const SANDBOX_TAIL = Object.freeze(['_relay', 'goal-loop', 'sandbox-home'])
/** Environment variables whose resolved value must sit inside the sandbox when set. */
export const SANDBOXED_ENV_REQUIRED = Object.freeze(['HOME', 'TMPDIR', 'ASKTOTO_USERDATA'])
export const SANDBOXED_ENV_OPTIONAL = Object.freeze([
  'TMP',
  'TEMP',
  'CFFIXED_USER_HOME',
  'MAC_CHROMIUM_TMPDIR',
  'METIS_TEST_HOME',
  'XDG_CONFIG_HOME'
])
/** Same families isolate.sh strips, plus generic secret-shaped names. */
export const CREDENTIAL_ENV =
  /^(CLOUDFLARE_|CF_|WRANGLER_|METIS_CLOUDFLARE_|OPENAI_|ANTHROPIC_|DEEPGRAM_|ELEVENLABS_|AWS_|AZURE_|DUST_)|^(METIS_PROXY_KEY|GH_TOKEN|GITHUB_TOKEN)$|(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/i
export const ONEDRIVE_ENV = Object.freeze(['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer'])

export class GuardError extends Error {
  /** @param {string} message @param {{ id: string, ok: boolean, detail: string }[]} [checks] */
  constructor(message, checks = []) {
    super(message)
    this.name = 'GuardError'
    this.checks = checks
  }
}

/**
 * Resolve symlinks for the longest existing prefix of `path`, then re-append the unresolved tail, so a path that
 * does not exist yet (a meetings folder before first launch) is still judged by where it would really land.
 * @param {string} path
 * @param {(p: string) => string} [realpath]
 */
export function realpathDeep(path, realpath = realpathSync) {
  const absolute = resolve(path)
  const tail = []
  let probe = absolute
  for (;;) {
    try {
      return join(realpath(probe), ...tail.reverse())
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return absolute
      tail.push(basename(probe))
      probe = parent
    }
  }
}

/** True when `child` is `parent` or below it, compared as path segments (never a string prefix). */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * True for the installed-app location /Applications (or anything below it). Compared on forward-slash form with an
 * optional drive prefix, so the answer does not depend on the host's path separator or on `resolve` adding a drive.
 * @param {string} path
 */
export function isInstalledAppsPath(path) {
  return /^(?:[A-Za-z]:)?\/Applications(?:\/|$)/.test(String(path).replaceAll('\\', '/'))
}

const pass = (id, detail) => ({ id, ok: true, detail })
const fail = (id, detail) => ({ id, ok: false, detail })

/**
 * The sandbox root derived from a HOME (or any path) under `<root>/run-*`: the nearest ancestor named
 * `sandbox-home` whose parent is `goal-loop`. Null when there is none, never a guess.
 * @param {string | undefined} path
 */
export function deriveSandboxRoot(path) {
  if (!path || !isAbsolute(path)) return null
  let probe = resolve(path)
  for (;;) {
    if (basename(probe) === SANDBOX_TAIL[2] && basename(dirname(probe)) === SANDBOX_TAIL[1]) return probe
    const parent = dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
}

/** @param {string | undefined} sandboxRoot @param {{ realpath?: (p: string) => string }} [deps] */
export function checkSandboxRoot(sandboxRoot, { realpath = realpathSync } = {}) {
  if (!sandboxRoot || !isAbsolute(sandboxRoot))
    return fail('sandbox-root', 'sandbox root is missing or not an absolute path')
  let real
  try {
    real = realpath(sandboxRoot)
  } catch {
    return fail('sandbox-root', 'sandbox root does not exist')
  }
  const parts = real.split(sep).filter(Boolean)
  const tail = parts.slice(-SANDBOX_TAIL.length)
  if (tail.length !== SANDBOX_TAIL.length || tail.some((segment, index) => segment !== SANDBOX_TAIL[index])) {
    return fail('sandbox-root', `sandbox root must end in ${SANDBOX_TAIL.join('/')}`)
  }
  return pass('sandbox-root', 'resolves to a sandbox-home under _relay/goal-loop')
}

/**
 * The app bundle: a real path strictly inside the sandbox, never under /Applications.
 * @param {string | undefined} appPath @param {string} sandboxRoot @param {{ realpath?: (p: string) => string }} [deps]
 */
export function checkAppPath(appPath, sandboxRoot, { realpath = realpathSync } = {}) {
  if (!appPath || !isAbsolute(appPath)) return fail('app-path', 'app path is missing or not absolute')
  if (!appPath.endsWith('.app')) return fail('app-path', 'app path must name an .app bundle')
  const raw = resolve(appPath)
  if (isInstalledAppsPath(appPath) || isInstalledAppsPath(raw)) {
    return fail('app-path', 'refusing an app under /Applications (the installed Métis lives there)')
  }
  let real
  try {
    real = realpath(raw)
  } catch {
    return fail('app-path', 'app bundle does not exist')
  }
  if (isInstalledAppsPath(real)) {
    return fail('app-path', 'app resolves under /Applications (symlink into the installed Métis)')
  }
  if (!isInside(realpathDeep(sandboxRoot, realpath), real)) return fail('app-path', 'app resolves outside the sandbox')
  return pass('app-path', 'app bundle resolves inside the sandbox')
}

/**
 * CFBundleIdentifier must be exactly the QA identity.
 * @param {string | null | undefined} bundleId
 */
export function checkBundleId(bundleId) {
  if (bundleId === REAL_BUNDLE_ID) return fail('bundle-id', `refusing the real identity ${REAL_BUNDLE_ID}`)
  if (bundleId !== QA_BUNDLE_ID)
    return fail('bundle-id', `CFBundleIdentifier is ${JSON.stringify(bundleId ?? null)}, expected ${QA_BUNDLE_ID}`)
  return pass('bundle-id', `CFBundleIdentifier is ${QA_BUNDLE_ID}`)
}

/**
 * Every launch-affecting variable must resolve inside the sandbox; no credentials, no OneDrive, local keystore
 * on (so safeStorage never touches the login Keychain). `env` is the CHILD environment the app will receive.
 * @param {Record<string, string | undefined>} env @param {string} sandboxRoot @param {{ realpath?: (p: string) => string }} [deps]
 */
export function checkChildEnv(env, sandboxRoot, { realpath = realpathSync } = {}) {
  const checks = []
  const root = realpathDeep(sandboxRoot, realpath)
  for (const name of SANDBOXED_ENV_REQUIRED) {
    const value = env[name]
    if (!value || !isAbsolute(value)) checks.push(fail(`env-${name}`, `${name} is missing or not absolute`))
    else if (!isInside(root, realpathDeep(value, realpath)))
      checks.push(fail(`env-${name}`, `${name} resolves outside the sandbox`))
    else checks.push(pass(`env-${name}`, `${name} resolves inside the sandbox`))
  }
  for (const name of SANDBOXED_ENV_OPTIONAL) {
    const value = env[name]
    if (value === undefined || value === '') continue
    if (!isAbsolute(value) || !isInside(root, realpathDeep(value, realpath)))
      checks.push(fail(`env-${name}`, `${name} resolves outside the sandbox`))
  }
  const leaked = Object.keys(env).filter((name) => CREDENTIAL_ENV.test(name) && env[name])
  checks.push(
    leaked.length
      ? fail('env-credentials', `credential-shaped variables present: ${leaked.join(', ')}`)
      : pass('env-credentials', 'no credential-shaped variables')
  )
  const oneDrive = ONEDRIVE_ENV.filter((name) => env[name])
  checks.push(
    oneDrive.length
      ? fail('env-onedrive', `OneDrive variables set: ${oneDrive.join(', ')}`)
      : pass('env-onedrive', 'no OneDrive variables')
  )
  checks.push(
    env.ASKTOTO_LOCAL_KEYSTORE === '1'
      ? pass('env-keystore', 'ASKTOTO_LOCAL_KEYSTORE=1 (no Keychain)')
      : fail('env-keystore', 'ASKTOTO_LOCAL_KEYSTORE must be 1 so the app never touches the Keychain')
  )
  return checks
}

/**
 * The harness process itself must have been started through isolate.sh and from inside the sandbox.
 * @param {Record<string, string | undefined>} parentEnv @param {string} sandboxRoot @param {{ realpath?: (p: string) => string }} [deps]
 */
export function checkParentEnv(parentEnv, sandboxRoot, { realpath = realpathSync } = {}) {
  const checks = []
  checks.push(
    parentEnv.METIS_LOOP_ISOLATED === '1'
      ? pass('isolate-wrapper', 'started through isolate.sh (METIS_LOOP_ISOLATED=1)')
      : fail('isolate-wrapper', 'not started through _relay/goal-loop/isolate.sh (METIS_LOOP_ISOLATED is not 1)')
  )
  const root = realpathDeep(sandboxRoot, realpath)
  for (const name of ['HOME', 'TMPDIR', 'ASKTOTO_USERDATA']) {
    const value = parentEnv[name]
    checks.push(
      value && isAbsolute(value) && isInside(root, realpathDeep(value, realpath))
        ? pass(`parent-${name}`, `${name} of the harness is inside the sandbox`)
        : fail(`parent-${name}`, `${name} of the harness is missing or outside the sandbox`)
    )
  }
  return checks
}

/** @param {string | undefined} folder @param {string} sandboxRoot @param {{ realpath?: (p: string) => string }} [deps] */
export function checkMeetingsFolder(folder, sandboxRoot, { realpath = realpathSync } = {}) {
  if (!folder || !isAbsolute(folder)) return fail('meetings-folder', 'meetings folder is missing or not absolute')
  if (!isInside(realpathDeep(sandboxRoot, realpath), realpathDeep(folder, realpath)))
    return fail('meetings-folder', 'meetings folder resolves outside the sandbox')
  return pass('meetings-folder', 'meetings folder resolves inside the sandbox')
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'env', 'xargs', 'nohup', 'sudo', 'arch'])
const FORBIDDEN_WORD = new RegExp(`(^|[\\s;&|()\`'"/])(${FORBIDDEN_COMMANDS.join('|')})(?=$|[\\s;&|()\`'"])`)

/**
 * A command about to be spawned. `open`, `launchctl` and `osascript` are refused by basename, and also when
 * named inside the arguments of a shell/launcher wrapper (`sh -c "open -a ..."`, `env launchctl ...`).
 * @param {string} file @param {readonly string[]} [args]
 */
export function checkCommand(file, args = []) {
  const name = basename(String(file))
  if (FORBIDDEN_COMMANDS.includes(name))
    return fail('command', `refusing ${name}: it launches through launchd/LaunchServices or AppleScript`)
  if (SHELLS.has(name)) {
    const joined = args.map(String).join(' ')
    const hit = FORBIDDEN_WORD.exec(joined)
    if (hit) return fail('command', `refusing ${hit[2]} named in the arguments of ${name}`)
  }
  return pass('command', `${name} is allowed`)
}

/**
 * Evaluate every launch guard. Never throws: the returned checks are what --dry-run prints.
 * @param {{ sandboxRoot: string, appPath?: string, bundleId?: string | null, childEnv?: Record<string, string | undefined>,
 *   parentEnv?: Record<string, string | undefined>, meetingsFolder?: string, requireIsolateWrapper?: boolean }} config
 * @param {{ realpath?: (p: string) => string }} [deps]
 * @returns {{ ok: boolean, checks: { id: string, ok: boolean, detail: string }[] }}
 */
export function evaluateGuards(config, deps = {}) {
  const checks = [checkSandboxRoot(config.sandboxRoot, deps)]
  if (checks[0].ok) {
    if (config.appPath !== undefined) checks.push(checkAppPath(config.appPath, config.sandboxRoot, deps))
    if (config.bundleId !== undefined) checks.push(checkBundleId(config.bundleId))
    if (config.childEnv) checks.push(...checkChildEnv(config.childEnv, config.sandboxRoot, deps))
    if (config.meetingsFolder !== undefined)
      checks.push(checkMeetingsFolder(config.meetingsFolder, config.sandboxRoot, deps))
    if (config.requireIsolateWrapper !== false && config.parentEnv)
      checks.push(...checkParentEnv(config.parentEnv, config.sandboxRoot, deps))
  }
  return { ok: checks.every((check) => check.ok), checks }
}

/** Throws a GuardError naming every failed check; returns the checks when all pass. */
export function assertGuards(config, deps = {}) {
  const result = evaluateGuards(config, deps)
  if (!result.ok) {
    const failed = result.checks.filter((check) => !check.ok)
    throw new GuardError(
      `sandbox guard refused: ${failed.map((check) => `${check.id}: ${check.detail}`).join('; ')}`,
      result.checks
    )
  }
  return result.checks
}

/** @param {string} file @param {readonly string[]} [args] */
export function assertCommandAllowed(file, args = []) {
  const check = checkCommand(file, args)
  if (!check.ok) throw new GuardError(`sandbox guard refused: ${check.detail}`, [check])
}

/** Refuse to delete or overwrite anything outside the sandbox. */
export function assertWritableInSandbox(path, sandboxRoot, { realpath = realpathSync } = {}) {
  if (!isInside(realpathDeep(sandboxRoot, realpath), realpathDeep(path, realpath))) {
    throw new GuardError(`sandbox guard refused: ${path} is outside the sandbox`)
  }
}
