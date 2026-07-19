#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { constants, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkElectronFuses } from './check-electron-fuses.mjs'
import { checkNodeLlamaPackage } from './check-node-llama-package.mjs'

const RESULT_KEYS = [
  'arch',
  'backend',
  'bindingPath',
  'error',
  'firstTokenCount',
  'modelId',
  'modelSha256',
  'modulePath',
  'networkAttempts',
  'packaged',
  'pid',
  'platform',
  'postRespawnTokenCount',
  'previousPid',
  'resourcesRoot',
  'respawnCount',
  'status',
  'timingsMs',
  'version',
  'windowCount',
  'workerPath'
].sort()

function fail(message) {
  throw new Error(`smoke-packaged-local-ai: ${message}`)
}

export function parseSmokeArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help') return { help: true }
    if (arg !== '--app' && arg !== '--result') fail(`unknown argument ${arg}`)
    const value = args[++index]
    const key = arg.slice(2)
    if (!value || value.startsWith('--') || options[key]) fail(`${arg} requires one value`)
    if (!isAbsolute(value)) fail(`${arg} must be absolute`)
    options[key] = value
  }
  if (!options.app || !options.result) fail('--app and --result are required')
  return options
}

function contained(root, candidate) {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false
  const value = relative(root, candidate)
  return value !== '' && !value.startsWith('..') && !isAbsolute(value)
}

export function validateSelftestResult(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('result must be an object')
  const keys = Object.keys(value).sort()
  if (JSON.stringify(keys) !== JSON.stringify(RESULT_KEYS)) fail('result fields are not strict')
  const mac = expected.platform === 'darwin-arm64'
  if (
    value.version !== 1 ||
    value.status !== 'passed' ||
    value.packaged !== true ||
    value.platform !== (mac ? 'darwin' : 'win32') ||
    value.arch !== (mac ? 'arm64' : 'x64') ||
    value.modelId !== expected.modelId ||
    value.modelSha256 !== expected.modelSha256 ||
    value.firstTokenCount !== 5 ||
    value.postRespawnTokenCount !== 5 ||
    value.respawnCount !== 1 ||
    !Number.isSafeInteger(value.previousPid) ||
    !Number.isSafeInteger(value.pid) ||
    value.previousPid === value.pid ||
    value.networkAttempts !== 0 ||
    value.windowCount !== 0 ||
    value.error !== null ||
    (mac ? value.backend !== 'metal' : !['cpu', 'vulkan'].includes(value.backend))
  ) {
    fail('result values do not prove the native lifecycle')
  }
  if (
    value.resourcesRoot !== join(expected.resourcesPath, 'local-ai') ||
    !contained(expected.resourcesPath, value.workerPath) ||
    !value.workerPath.replaceAll('\\', '/').includes('/app.asar/out/local-ai-worker/index.mjs') ||
    !contained(expected.resourcesPath, value.modulePath) ||
    !value.modulePath.replaceAll('\\', '/').includes('/app.asar/node_modules/node-llama-cpp/') ||
    value.modulePath.replaceAll('\\', '/').includes('/app.asar.unpacked/') ||
    !contained(expected.resourcesPath, value.bindingPath) ||
    !value.bindingPath.replaceAll('\\', '/').includes('/app.asar.unpacked/') ||
    !value.bindingPath.replaceAll('\\', '/').endsWith('/llama-addon.node')
  ) {
    fail('result paths do not stay inside the detached app')
  }
  if (
    !value.timingsMs ||
    typeof value.timingsMs !== 'object' ||
    Array.isArray(value.timingsMs) ||
    Object.values(value.timingsMs).some((duration) => typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)
  ) {
    fail('result timings are invalid')
  }
  return value
}

async function copyTree(source, destination) {
  const stats = await fs.lstat(source)
  if (stats.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), destination)
    return
  }
  if (stats.isDirectory()) {
    await fs.mkdir(destination, { mode: stats.mode & 0o777 })
    for (const entry of await fs.readdir(source)) {
      await copyTree(join(source, entry), join(destination, entry))
    }
    return
  }
  if (!stats.isFile()) fail('source app contains a non-file entry')
  await fs.copyFile(source, destination, constants.COPYFILE_FICLONE)
  await fs.chmod(destination, stats.mode & 0o777)
}

async function sourceLayout(executable) {
  const file = resolve(executable)
  const stats = await fs.lstat(file)
  if (!stats.isFile() || stats.isSymbolicLink()) fail('--app executable must be a real file')
  let current = dirname(file)
  while (dirname(current) !== current && !current.toLowerCase().endsWith('.app')) current = dirname(current)
  if (current.toLowerCase().endsWith('.app')) {
    return {
      platform: 'darwin-arm64',
      appRoot: current,
      executableRelative: relative(current, file),
      resourcesRelative: join('Contents', 'Resources')
    }
  }
  return {
    platform: 'win32-x64',
    appRoot: dirname(file),
    executableRelative: basename(file),
    resourcesRelative: 'resources'
  }
}

async function ensureNoAncestorNodeModules(directory) {
  let current = resolve(directory)
  for (;;) {
    const modules = join(current, 'node_modules')
    if (await fs.lstat(modules).then(() => true, () => false)) fail('detached app has an ancestor node_modules')
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

function smokeEnvironment(userData, resultPath) {
  const env = {}
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'ComSpec',
    'COMSPEC',
    'PATHEXT'
  ]) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key]
  }
  return {
    ...env,
    ASKTOTO_USERDATA: userData,
    METIS_SELFTEST_KIND: 'local-ai-native',
    METIS_SELFTEST_OUTPUT: resultPath,
    METIS_LOCAL_AI_DENY_NETWORK: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  }
}

async function launch(executable, cwd, env, timeoutMs = 300_000) {
  await new Promise((resolveLaunch, reject) => {
    const child = spawn(executable, [], { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let capturedBytes = 0
    const consume = (chunk) => {
      capturedBytes += chunk.length
      if (capturedBytes > 64 * 1024) child.kill('SIGKILL')
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && signal === null && capturedBytes <= 64 * 1024) resolveLaunch()
      else reject(
        new Error(
          `packaged process failed (code=${String(code)}, signal=${String(signal)}, capturedBytes=${capturedBytes}); captured output withheld`
        )
      )
    })
  })
}

async function packagedModel(resourcesPath) {
  const raw = await fs.readFile(join(resourcesPath, 'local-ai', 'manifest.json'), 'utf8')
  const manifest = JSON.parse(raw)
  const selected = manifest.selected?.text?.id
  const weights = manifest.assets?.filter(
    (asset) => asset.variantId === selected && asset.component === 'weights'
  )
  if (typeof selected !== 'string' || weights?.length !== 1) fail('detached manifest text model is invalid')
  return { id: selected, sha256: weights[0].sha256 }
}

export async function smokePackagedLocalAi({ app, result }) {
  const layout = await sourceLayout(app)
  const detachedParent = await fs.mkdtemp(join(tmpdir(), 'metis-detached-smoke-'))
  const detachedApp = join(detachedParent, basename(layout.appRoot))
  const userData = join(detachedParent, 'user-data')
  await fs.rm(result, { force: true })
  try {
    await ensureNoAncestorNodeModules(detachedParent)
    await copyTree(layout.appRoot, detachedApp)
    await fs.mkdir(userData, { recursive: true })
    const executable = join(detachedApp, layout.executableRelative)
    const resources = await fs.realpath(join(detachedApp, layout.resourcesRelative))
    await checkNodeLlamaPackage({
      app: detachedApp,
      platform: layout.platform,
      allowEvaluation: process.env.METIS_ALLOW_EVALUATION_PAYLOAD === '1'
    })
    await checkElectronFuses({ app: detachedApp, requireRunAsNode: true })
    const model = await packagedModel(resources)
    await launch(executable, detachedParent, smokeEnvironment(userData, result))

    const resultStats = await fs.lstat(result)
    if (
      !resultStats.isFile() ||
      resultStats.isSymbolicLink() ||
      resultStats.nlink !== 1 ||
      resultStats.size <= 0 ||
      resultStats.size > 16 * 1024
    ) {
      fail('self-test result is not a bounded regular file')
    }
    const parsed = JSON.parse(await fs.readFile(result, 'utf8'))
    return validateSelftestResult(parsed, {
      platform: layout.platform,
      resourcesPath: resources,
      modelId: model.id,
      modelSha256: model.sha256
    })
  } finally {
    await fs.rm(detachedParent, { recursive: true, force: true })
  }
}

async function runCli(args = process.argv.slice(2)) {
  const options = parseSmokeArgs(args)
  if (options.help) {
    console.log('Usage: node scripts/smoke-packaged-local-ai.mjs --app <absolute-executable> --result <absolute-json>')
    return
  }
  const result = await smokePackagedLocalAi(options)
  console.log(`[smoke-packaged-local-ai] PASS ${result.modelId} ${result.backend}`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
