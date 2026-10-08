/** Import-safe, built-in-only admission checks. No executable or app is launched on import. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { sha256File } from '../provenance.mjs'

const BROKERS = Object.freeze([
  'com.apple.SecurityServer',
  'com.apple.securityd',
  'com.apple.securityd.xpc',
  'com.apple.securityd.systemkeychain',
  'com.apple.securityd.aps',
  'com.apple.securityd.ckks',
  'com.apple.securityd.general',
  'com.apple.securityd.sos',
  'com.apple.security.octagon',
  'com.apple.security.escrow-update',
  'com.apple.security.kcsharing'
])
export const BROKER_PROBE_OUTPUT = `${BROKERS.map((name) => `${name} 1100 0\n`).join('')}BROKER_LOOKUP_DENIED\n`

export function requireBrokerDenial(result) {
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    result.stdout !== BROKER_PROBE_OUTPUT ||
    result.stderr !== ''
  ) {
    throw new Error('Security broker lookup denial not established')
  }
}

/** Execute only the immutable libSystem probe, already inside this launch's outer policy. */
export function observeSecurityBrokers(env, spawnProbe = spawnSync) {
  const control = env.OWNER_QA_CONTROL_DIR
  const probe = env.QA_CHECK_PATH
  const digest = env.QA_CHECK_SHA256
  const root = env.OWNER_SANDBOX_JOB_ROOT
  const expectedRoot =
    env.RUNNER_TEMP &&
    join(env.RUNNER_TEMP, `metis-owner-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.GITHUB_JOB}`)
  if (
    !control ||
    !root ||
    root !== expectedRoot ||
    !isAbsolute(control) ||
    !isAbsolute(root) ||
    realpathSync(control) !== control ||
    realpathSync(root) !== root ||
    dirname(dirname(control)) !== root ||
    !/^invocation\.[A-Za-z0-9]+$/.test(basename(dirname(control))) ||
    !/^broker-control\.[A-Za-z0-9]+$/.test(basename(control)) ||
    probe !== join(control, 'check-security-brokers') ||
    !/^[a-f0-9]{64}$/.test(digest ?? '')
  ) {
    throw new Error('invalid pinned Security broker probe configuration')
  }
  const info = lstatSync(probe)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (process.getuid && info.uid !== process.getuid()) ||
    realpathSync(probe) !== probe ||
    createHash('sha256').update(readFileSync(probe)).digest('hex') !== digest
  ) {
    throw new Error('Security broker probe identity or digest mismatch')
  }
  const profile = join(env.GITHUB_WORKSPACE, 'scripts', 'hermetic', 'owner-runner.sb')
  if (realpathSync(profile) !== profile) throw new Error('redirected strict profile')
  const profileSha256 = createHash('sha256').update(readFileSync(profile)).digest('hex')
  if (profileSha256 !== env.OWNER_SANDBOX_PROFILE_SHA256) throw new Error('strict profile digest mismatch')
  const result = spawnProbe(probe, [], {
    env: {},
    timeout: 12_000,
    maxBuffer: 32 * 1024,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  requireBrokerDenial(result)
  return Object.freeze({
    lookupStatus: 1100,
    services: BROKERS.length,
    profileSha256,
    probeSha256: digest,
    namedServiceAbsence: 'not-observed'
  })
}

export function trackCandidateSpawn(child, observation) {
  child.once('spawn', () => {
    observation.processSpawned = true
  })
}

export function trackInspectorConnection(socket, observation) {
  socket.addEventListener(
    'open',
    () => {
      observation.inspectorConnected = true
    },
    { once: true }
  )
}

export async function verifyCandidate(installerPath, provenancePath) {
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
  const name = basename(installerPath)
  const matches = provenance.builds.flatMap((build) =>
    build.assets.filter((asset) => asset.name === name).map((asset) => ({ asset, variant: build.variant }))
  )
  if (matches.length !== 1) {
    throw new Error(`expected one provenance asset named ${name}, found ${matches.length}`)
  }
  const { asset, variant } = matches[0]
  const actual = await sha256File(installerPath)
  if (actual !== asset.sha256) throw new Error(`sha256 mismatch for ${name}`)
  return Object.freeze({ build_run_id: provenance.run.id, artifact_sha256: actual, variant })
}

/** Read only root package.json from a bounded ASAR header and packed entry. */
export function readPackagedName(archive) {
  const fd = openSync(archive, 'r')
  try {
    const total = fstatSync(fd).size
    const read = (size, offset) => {
      if (
        !Number.isSafeInteger(size) ||
        !Number.isSafeInteger(offset) ||
        size < 0 ||
        offset < 0 ||
        offset + size > total
      ) {
        throw new Error('invalid or truncated ASAR range')
      }
      const bytes = Buffer.alloc(size)
      let count = 0
      while (count < size) {
        const n = readSync(fd, bytes, count, size - count, offset + count)
        if (n === 0) throw new Error('truncated ASAR read')
        count += n
      }
      return bytes
    }
    const prefix = read(16, 0)
    const headerSize = prefix.readUInt32LE(4)
    const jsonSize = prefix.readUInt32LE(12)
    if (
      prefix.readUInt32LE(0) !== 4 ||
      headerSize < 8 ||
      headerSize > 16 * 1024 * 1024 ||
      prefix.readUInt32LE(8) !== headerSize - 4 ||
      jsonSize > headerSize - 8
    ) {
      throw new Error('invalid ASAR header')
    }
    const header = JSON.parse(read(jsonSize, 16).toString('utf8'))
    const entry = header.files?.['package.json']
    if (
      !entry ||
      entry.link !== undefined ||
      entry.unpacked ||
      entry.files ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      entry.size > 1024 * 1024 ||
      typeof entry.offset !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(entry.offset)
    ) {
      throw new Error('invalid packed package.json')
    }
    const offset = Number(entry.offset)
    if (!Number.isSafeInteger(offset)) throw new Error('invalid package offset')
    return JSON.parse(read(entry.size, 8 + headerSize + offset).toString('utf8')).name
  } finally {
    closeSync(fd)
  }
}

function within(root, path) {
  const child = relative(root, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

/** The wrapper owns/baselines this canary. Denials prove only these two operations. */
export function observeCanary(env, io = { readFileSync, openSync, closeSync }) {
  const canary = env.OWNER_SANDBOX_CANARY
  const temp = env.OWNER_SANDBOX_TEMP
  if (
    !canary ||
    !temp ||
    !isAbsolute(canary) ||
    !isAbsolute(temp) ||
    dirname(canary) !== temp ||
    basename(canary) !== '.sandbox-canary'
  ) {
    throw new Error('missing wrapper-owned canary configuration')
  }
  const root = env.OWNER_SANDBOX_JOB_ROOT
  const expected =
    env.RUNNER_TEMP &&
    join(env.RUNNER_TEMP, `metis-owner-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.GITHUB_JOB}`)
  if (
    !root ||
    root !== expected ||
    realpathSync(root) !== root ||
    realpathSync(temp) !== temp ||
    dirname(temp) !== root ||
    !/^invocation\.[A-Za-z0-9]+$/.test(basename(temp))
  ) {
    throw new Error('canary temp root is not the canonical wrapper job child')
  }
  const denied = (operation) => {
    try {
      operation()
      return false
    } catch (error) {
      return error?.code === 'EPERM' || error?.code === 'EACCES'
    }
  }
  const readDenied = denied(() => io.readFileSync(canary))
  let fd
  const writeDenied = denied(() => {
    fd = io.openSync(canary, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
  })
  // A close failure is an error, not evidence that opening for write was denied.
  if (fd !== undefined) io.closeSync(fd)
  const observation = Object.freeze({ readDenied, writeDenied })
  if (!observation.readDenied || !observation.writeDenied) {
    throw new Error('canary read/write permission denial not established')
  }
  return observation
}

export function validateRestrictedExecutable({
  plan,
  env,
  exe,
  unzipDir,
  canaryIO,
  readBundleId = (path) =>
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path], {
      encoding: 'utf8',
      timeout: 5000
    }).trim()
}) {
  if (!plan.restricted) return null
  if (!unzipDir) throw new Error('restricted launch requires a fresh extracted ZIP')
  const root = realpathSync(unzipDir)
  const executable = realpathSync(exe)
  if (!within(root, executable)) throw new Error('executable escapes the extracted ZIP')
  const app = dirname(dirname(dirname(executable)))
  if (!app.endsWith('.app') || !within(root, app) || dirname(executable) !== join(app, 'Contents', 'MacOS')) {
    throw new Error('restricted executable is not in the extracted application bundle')
  }
  const plist = realpathSync(join(app, 'Contents', 'Info.plist'))
  const archive = realpathSync(join(app, 'Contents', 'Resources', 'app.asar'))
  if (!within(app, plist) || !within(app, archive)) throw new Error('bundle identity escapes the application')
  const bundleId = readBundleId(plist)
  const packageName = readPackagedName(archive)
  if (bundleId !== 'com.mantu.asktoto.qa' || packageName !== 'asktoto-qa') {
    throw new Error('packaged QA bundle/package identity mismatch')
  }
  return Object.freeze({
    canary: observeCanary(env, canaryIO),
    identity: Object.freeze({ bundleId, packageName })
  })
}
