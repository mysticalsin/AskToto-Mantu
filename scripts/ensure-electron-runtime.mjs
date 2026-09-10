#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_PROBE = 'JSON.stringify({electron:process.versions.electron,platform:process.platform,arch:process.arch})'
const VERIFY_ONLY_ARGS = new Set(['--check-only', '--offline'])
const INSTALL_TIMEOUT_MS = 600_000
const PROBE_TIMEOUT_MS = 15_000
const MAX_BUFFER_BYTES = 1_048_576
const UNSAFE_CHILD_ENV = new Set([
  'node_options',
  'node_path',
  'electron_run_as_node'
])
const UNSAFE_INSTALL_ENV = new Set([
  'electron_override_dist_path',
  'electron_use_remote_checksums',
  'npm_config_electron_use_remote_checksums',
  'node_tls_reject_unauthorized',
  'npm_config_strict_ssl'
])

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function hostExecutablePath(platform) {
  switch (platform) {
    case 'darwin': return 'Electron.app/Contents/MacOS/Electron'
    case 'win32': return 'electron.exe'
    case 'linux':
    case 'freebsd':
    case 'openbsd': return 'electron'
    default: throw new Error(`Electron has no host runtime for platform ${platform}.`)
  }
}

function inside(parent, child) {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

function containedPathIfPresent(actualPackageDir, candidate, failureMessage) {
  try {
    lstatSync(candidate)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  }

  let actual
  try {
    actual = realpathSync(candidate)
  } catch {
    throw new Error(failureMessage)
  }
  if (!inside(actualPackageDir, actual)) throw new Error(failureMessage)
  return actual
}

function locateRuntime(electronDir, actualPackageDir, hostPlatform) {
  const pathFile = join(electronDir, 'path.txt')
  const dist = resolve(electronDir, 'dist')
  const realDist = containedPathIfPresent(
    actualPackageDir,
    dist,
    'Electron dist must resolve inside the actual node_modules/electron package directory.'
  )
  let pathFileMetadata
  try {
    pathFileMetadata = lstatSync(pathFile)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  }
  if (pathFileMetadata.isSymbolicLink() || !pathFileMetadata.isFile()) {
    throw new Error('Electron path.txt must be a package-local regular file, not a symlink.')
  }
  const selected = readFileSync(pathFile, 'utf8')
  const executable = resolve(dist, selected)
  if (!inside(dist, executable)) {
    throw new Error('Electron path.txt must resolve inside node_modules/electron/dist.')
  }
  const expectedPath = hostExecutablePath(hostPlatform)
  if (selected !== expectedPath) {
    throw new Error(`Electron path.txt does not select the ${hostPlatform} host executable.`)
  }
  if (!existsSync(executable)) return null
  if (!realDist) return null
  const realExecutable = realpathSync(executable)
  if (!inside(realDist, realExecutable)) {
    throw new Error('Electron executable must resolve inside node_modules/electron/dist.')
  }
  return executable
}

function detail(result) {
  if (result?.error instanceof Error) return result.error.message
  const stderr = typeof result?.stderr === 'string' ? result.stderr.trim() : ''
  return stderr || (result?.signal ? `signal ${result.signal}` : 'no diagnostic output')
}

function exitLabel(result) {
  return typeof result?.status === 'number' ? String(result.status) : 'unknown'
}

function environmentValues(env, requestedKey) {
  return Object.entries(env)
    .filter(([key]) => key.toLowerCase() === requestedKey.toLowerCase())
    .map(([, value]) => value)
}

function childEnvironment(env) {
  const clean = { ...env }
  for (const key of Object.keys(clean)) {
    if (UNSAFE_CHILD_ENV.has(key.toLowerCase())) delete clean[key]
  }
  return clean
}

function installerEnvironment(env, hostPlatform, hostArch) {
  const clean = childEnvironment(env)
  for (const key of Object.keys(clean)) {
    if (UNSAFE_INSTALL_ENV.has(key.toLowerCase())) delete clean[key]
  }
  // Electron 43's installer gives these variables precedence. Setting both also prevents its
  // Rosetta probe or an inherited npm cross-build setting from selecting a non-host runtime.
  clean.ELECTRON_INSTALL_PLATFORM = hostPlatform
  clean.ELECTRON_INSTALL_ARCH = hostArch
  clean.npm_config_platform = hostPlatform
  clean.npm_config_arch = hostArch
  return clean
}

function verificationOnly(args, env) {
  return args.some((arg) => VERIFY_ONLY_ARGS.has(arg)) || environmentValues(env, 'npm_config_offline')
    .some((value) => /^(?:1|true)$/i.test(String(value || '')))
}

function timedOut(result) {
  return result?.error && typeof result.error === 'object' && result.error.code === 'ETIMEDOUT'
}

/**
 * Ensure the exact Electron npm wrapper selected by package.json has a package-local host runtime.
 * The wrapper's own pinned install.js is the only allowed installer; importing `electron` here would
 * itself trigger Electron 43's lazy downloader before this code could enforce the version and host.
 */
export async function ensureElectronRuntime(options = {}) {
  const root = resolve(options.root || SCRIPT_ROOT)
  const args = options.args || []
  const env = options.env || process.env
  const hostPlatform = options.hostPlatform || process.platform
  const hostArch = options.hostArch || process.arch
  const nodePath = options.nodePath || process.execPath
  const run = options.run || spawnSync

  const unknown = args.filter((arg) => !VERIFY_ONLY_ARGS.has(arg))
  if (unknown.length) throw new Error(`Unknown ensure-electron-runtime option: ${unknown[0]}`)
  if (environmentValues(env, 'ELECTRON_EXEC_PATH').some((value) => value !== undefined && String(value).length > 0)) {
    throw new Error('Unset ELECTRON_EXEC_PATH; electron-vite would bypass the verified package runtime.')
  }

  const rootPackage = readJson(join(root, 'package.json'), 'root package.json')
  const expected = rootPackage?.devDependencies?.electron
  if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+$/.test(expected)) {
    throw new Error('package.json must pin devDependencies.electron to an exact stable version.')
  }

  const lockfile = readJson(join(root, 'package-lock.json'), 'root package-lock.json')
  const rootLock = lockfile?.packages?.['']?.devDependencies?.electron
  const resolvedLock = lockfile?.packages?.['node_modules/electron']?.version
  if (rootLock !== expected || resolvedLock !== expected) {
    throw new Error(
      `Electron lockfile mismatch: package.json ${expected}, root lock pin ${String(rootLock)}, resolved ${String(resolvedLock)}.`
    )
  }

  const electronDir = join(root, 'node_modules', 'electron')
  const electronPackage = readJson(join(electronDir, 'package.json'), 'installed Electron package.json')
  if (electronPackage.version !== expected) {
    throw new Error(`Electron npm package version mismatch: locked ${expected}, installed ${String(electronPackage.version)}.`)
  }
  if (electronPackage?.bin?.['install-electron'] !== 'install.js') {
    throw new Error(`Electron ${expected} does not expose the reviewed install-electron -> install.js interface.`)
  }
  const actualPackageDir = realpathSync(electronDir)

  let executable = locateRuntime(electronDir, actualPackageDir, hostPlatform)
  let installed = false
  if (!executable) {
    if (verificationOnly(args, env)) {
      throw new Error(`Electron ${expected} host runtime is missing in verification-only mode.`)
    }
    const installer = join(electronDir, 'install.js')
    if (!existsSync(installer)) throw new Error(`Electron ${expected} package is missing its official install.js.`)
    const actualInstaller = containedPathIfPresent(
      actualPackageDir,
      installer,
      'Electron install.js must resolve inside the actual node_modules/electron package directory.'
    )
    if (!actualInstaller) throw new Error(`Electron ${expected} package is missing its official install.js.`)
    const result = run(nodePath, [actualInstaller], {
      cwd: root,
      encoding: 'utf8',
      env: installerEnvironment(env, hostPlatform, hostArch),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      killSignal: 'SIGKILL',
      windowsHide: true
    })
    if (timedOut(result)) {
      throw new Error(`Official Electron installer timed out after ${INSTALL_TIMEOUT_MS}ms.`)
    }
    if (result?.status !== 0) {
      throw new Error(`Official Electron installer failed (exit ${exitLabel(result)}): ${detail(result)}`)
    }
    installed = true
    executable = locateRuntime(electronDir, actualPackageDir, hostPlatform)
    if (!executable) {
      throw new Error('Official Electron installer exited successfully but the host runtime is still missing.')
    }
  }

  const probe = run(executable, ['-p', VERSION_PROBE], {
    cwd: root,
    encoding: 'utf8',
    env: { ...childEnvironment(env), ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    killSignal: 'SIGKILL',
    windowsHide: true
  })
  if (timedOut(probe)) {
    throw new Error(`Electron runtime probe timed out after ${PROBE_TIMEOUT_MS}ms.`)
  }
  if (probe?.status !== 0) {
    throw new Error(`Electron runtime probe failed (exit ${exitLabel(probe)}): ${detail(probe)}`)
  }
  let reported
  try {
    reported = JSON.parse(String(probe.stdout || '').trim())
  } catch {
    throw new Error('Electron runtime probe returned malformed version data.')
  }
  if (reported?.electron !== expected || reported?.platform !== hostPlatform || reported?.arch !== hostArch) {
    throw new Error(
      `Electron runtime mismatch: expected ${expected}/${hostPlatform}/${hostArch}, reported ` +
      `${String(reported?.electron)}/${String(reported?.platform)}/${String(reported?.arch)}.`
    )
  }

  return { version: expected, executable, installed }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  ensureElectronRuntime({ args: process.argv.slice(2) })
    .then(({ version, installed }) => {
      console.log(`[ensure-electron-runtime] OK Electron ${version} host runtime ${installed ? 'installed and verified' : 'verified'}`)
    })
    .catch((error) => {
      console.error(`[ensure-electron-runtime] FAIL ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
}
