import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

interface SelftestEnvironment {
  METIS_SELFTEST_KIND?: string
  METIS_SELFTEST_OUTPUT?: string
}

interface ResolvedModel {
  id: string
  sha256: string
  absolutePath: string
}

interface SelftestController {
  start(): Promise<{ pid: number }>
  generate(
    request: {
      id: string
      modelPath: string
      prompt: string
      maxTokens: number
    },
    onToken?: (text: string) => void,
    onProgress?: (count: number) => void
  ): Promise<{
    tokenCount: number
    backend: 'metal' | 'vulkan' | 'cpu'
    workerPath: string
    modulePath: string
    bindingPath: string
    networkAttempts: number
  }>
  forceKillForSelfTest(): Promise<{ previousPid: number; pid: number }>
  dispose(): Promise<void>
}

interface PackagedSelftestOptions {
  env: SelftestEnvironment
  isPackaged: boolean
  platform: string
  arch: string
  appResourcesPath: string
  resourcesRoot: string
  workerPath: string
  bindingPath: string
  installNetworkDeny: () => void
  getNetworkAttempts: () => number
  getWindowCount: () => number
  resolveModel: () => Promise<ResolvedModel> | ResolvedModel
  createController: (model: ResolvedModel) => SelftestController
  writeResult: (outputPath: string, result: PackagedSelftestResult) => Promise<void> | void
  now: () => number
}

export interface PackagedSelftestResult {
  version: 1
  status: 'passed' | 'failed'
  packaged: boolean
  platform: string
  arch: string
  modelId: string | null
  modelSha256: string | null
  backend: 'metal' | 'vulkan' | 'cpu' | null
  resourcesRoot: string
  workerPath: string
  modulePath: string | null
  bindingPath: string
  firstTokenCount: number | null
  postRespawnTokenCount: number | null
  previousPid: number | null
  pid: number | null
  respawnCount: number
  networkAttempts: number
  windowCount: number
  timingsMs: Record<string, number>
  error: string | null
}

class SelftestFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function containedPath(root: string, candidate: string, strict = false): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false
  const contained = relative(root, candidate)
  if (strict && !contained) return false
  return !contained.startsWith('..') && !isAbsolute(contained)
}

function baseResult(options: PackagedSelftestOptions): PackagedSelftestResult {
  return {
    version: 1,
    status: 'failed',
    packaged: options.isPackaged,
    platform: options.platform,
    arch: options.arch,
    modelId: null,
    modelSha256: null,
    backend: null,
    resourcesRoot: options.resourcesRoot,
    workerPath: options.workerPath,
    modulePath: null,
    bindingPath: options.bindingPath,
    firstTokenCount: null,
    postRespawnTokenCount: null,
    previousPid: null,
    pid: null,
    respawnCount: 0,
    networkAttempts: 0,
    windowCount: 0,
    timingsMs: {},
    error: null
  }
}

function assertResultBound(result: PackagedSelftestResult): void {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16 * 1024) {
    throw new SelftestFailure('RESULT_TOO_LARGE')
  }
}

function safeCounter(read: () => number): number {
  try {
    const value = read()
    return Number.isSafeInteger(value) && value >= 0 ? value : -1
  } catch {
    return -1
  }
}

export function isLocalAiNativeSelftest(env: SelftestEnvironment): boolean {
  return env.METIS_SELFTEST_KIND === 'local-ai-native'
}

export async function writePackagedSelftestResult(
  outputPath: string,
  result: PackagedSelftestResult
): Promise<void> {
  if (!isAbsolute(outputPath)) throw new Error('Self-test result path must be absolute.')
  assertResultBound(result)
  const parent = dirname(outputPath)
  await fs.mkdir(parent, { recursive: true })
  const existing = await fs.lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw new Error('Self-test result destination must be a non-hardlinked regular file.')
  }
  const temporary = join(
    parent,
    `.${basename(outputPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  )
  try {
    await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    await fs.rename(temporary, outputPath)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function runPackagedLocalAiSelftest(
  options: PackagedSelftestOptions
): Promise<PackagedSelftestResult> {
  const outputPath = options.env.METIS_SELFTEST_OUTPUT
  if (typeof outputPath !== 'string' || !isAbsolute(outputPath)) {
    throw new Error('METIS_SELFTEST_OUTPUT must be absolute.')
  }

  const result = baseResult(options)
  const timings: Record<string, number> = {}
  const startedAt = options.now()
  let controller: SelftestController | null = null

  try {
    options.installNetworkDeny()
    if (!options.isPackaged) throw new SelftestFailure('NOT_PACKAGED')
    if (!containedPath(options.appResourcesPath, options.resourcesRoot, true)) {
      throw new SelftestFailure('RESOURCES_OUTSIDE_APP')
    }

    const normalizedWorker = options.workerPath.replaceAll('\\', '/')
    const normalizedBinding = options.bindingPath.replaceAll('\\', '/')
    if (
      !containedPath(options.appResourcesPath, options.workerPath, true) ||
      !normalizedWorker.includes('/app.asar/') ||
      normalizedWorker.includes('/app.asar.unpacked/')
    ) {
      throw new SelftestFailure('WORKER_PATH_INVALID')
    }
    if (
      !containedPath(options.appResourcesPath, options.bindingPath, true) ||
      !normalizedBinding.includes('/app.asar.unpacked/')
    ) {
      throw new SelftestFailure('BINDING_PATH_INVALID')
    }

    const resolveStarted = options.now()
    const model = await options.resolveModel()
    timings.resolveModel = options.now() - resolveStarted
    if (
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(model.id) ||
      !/^[0-9a-f]{64}$/.test(model.sha256) ||
      !containedPath(options.resourcesRoot, model.absolutePath, true)
    ) {
      throw new SelftestFailure('MODEL_RECORD_INVALID')
    }
    result.modelId = model.id
    result.modelSha256 = model.sha256

    const createStarted = options.now()
    controller = options.createController(model)
    const started = await controller.start()
    timings.initialize = options.now() - createStarted

    const firstStarted = options.now()
    const first = await controller.generate({
      id: 'selftest-first',
      modelPath: model.absolutePath,
      prompt: 'Reply with a sequence of short words.',
      maxTokens: 5
    })
    timings.firstGeneration = options.now() - firstStarted
    if (first.tokenCount !== 5) throw new SelftestFailure('FIRST_TOKEN_COUNT')
    const normalizedModule = first.modulePath.replaceAll('\\', '/')
    const normalizedActualBinding = first.bindingPath.replaceAll('\\', '/')
    const expectedNativePackage =
      options.platform === 'darwin'
        ? '/@node-llama-cpp/mac-arm64-metal/'
        : first.backend === 'vulkan'
          ? '/@node-llama-cpp/win-x64-vulkan/'
          : '/@node-llama-cpp/win-x64/'
    if (
      first.workerPath !== options.workerPath ||
      !containedPath(options.appResourcesPath, first.modulePath, true) ||
      !normalizedModule.includes('/app.asar/node_modules/node-llama-cpp/') ||
      normalizedModule.includes('/app.asar.unpacked/') ||
      !containedPath(options.appResourcesPath, first.bindingPath, true) ||
      !normalizedActualBinding.includes('/app.asar.unpacked/') ||
      !normalizedActualBinding.includes(expectedNativePackage) ||
      !normalizedActualBinding.endsWith('/llama-addon.node') ||
      first.networkAttempts !== 0
    ) {
      throw new SelftestFailure('RUNTIME_PROOF_INVALID')
    }
    result.firstTokenCount = first.tokenCount
    result.backend = first.backend
    result.workerPath = first.workerPath
    result.modulePath = first.modulePath
    result.bindingPath = first.bindingPath

    let observeFirstToken!: () => void
    const firstToken = new Promise<void>((resolve) => {
      observeFirstToken = resolve
    })
    const interrupted = controller.generate(
      {
        id: 'selftest-interrupt',
        modelPath: model.absolutePath,
        prompt: 'Continue producing numbered words without stopping.',
        maxTokens: 128
      },
      undefined,
      (count) => {
        if (count > 0) observeFirstToken()
      }
    )
    const interruptedOutcome = interrupted.then(
      () => false,
      () => true
    )
    await Promise.race([
      firstToken,
      interrupted.then(
        () => Promise.reject(new SelftestFailure('INTERRUPT_COMPLETED_EARLY')),
        () => Promise.reject(new SelftestFailure('INTERRUPT_FAILED_BEFORE_TOKEN'))
      )
    ])

    const respawnStarted = options.now()
    const respawn = await controller.forceKillForSelfTest()
    if (respawn.previousPid !== started.pid || respawn.pid === respawn.previousPid) {
      throw new SelftestFailure('RESPAWN_PID_INVALID')
    }
    if (!(await interruptedOutcome)) throw new SelftestFailure('INTERRUPT_DID_NOT_REJECT')
    timings.respawn = options.now() - respawnStarted
    result.previousPid = respawn.previousPid
    result.pid = respawn.pid
    result.respawnCount = 1

    const secondStarted = options.now()
    const second = await controller.generate({
      id: 'selftest-second',
      modelPath: model.absolutePath,
      prompt: 'Reply with a different sequence of short words.',
      maxTokens: 5
    })
    timings.secondGeneration = options.now() - secondStarted
    if (second.tokenCount !== 5) throw new SelftestFailure('SECOND_TOKEN_COUNT')
    if (second.backend !== first.backend) throw new SelftestFailure('BACKEND_CHANGED')
    if (
      second.workerPath !== first.workerPath ||
      second.modulePath !== first.modulePath ||
      second.bindingPath !== first.bindingPath ||
      second.networkAttempts !== 0
    ) {
      throw new SelftestFailure('RESPAWN_RUNTIME_PROOF_CHANGED')
    }
    result.postRespawnTokenCount = second.tokenCount

    await controller.dispose()
    controller = null
    result.networkAttempts = safeCounter(options.getNetworkAttempts)
    result.windowCount = safeCounter(options.getWindowCount)
    if (result.networkAttempts !== 0) throw new SelftestFailure('NETWORK_ATTEMPTED')
    if (result.windowCount !== 0) throw new SelftestFailure('WINDOW_CREATED')

    timings.total = options.now() - startedAt
    result.timingsMs = timings
    result.status = 'passed'
    assertResultBound(result)
    await options.writeResult(outputPath, result)
    return result
  } catch (error) {
    try {
      await controller?.dispose()
    } catch {
      // Preserve the primary failure while still attempting native cleanup.
    }
    result.networkAttempts = safeCounter(options.getNetworkAttempts)
    result.windowCount = safeCounter(options.getWindowCount)
    timings.total = options.now() - startedAt
    result.timingsMs = timings
    result.status = 'failed'
    result.error = error instanceof SelftestFailure ? error.code : 'LOCAL_AI_NATIVE_SELFTEST_FAILED'
    assertResultBound(result)
    try {
      await options.writeResult(outputPath, result)
    } catch {
      // Missing output remains a hard failure for the outer smoke process.
    }
    throw new Error('Local AI native self-test failed.')
  }
}
