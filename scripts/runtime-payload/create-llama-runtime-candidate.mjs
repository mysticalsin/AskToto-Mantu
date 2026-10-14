#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBeforeDeadline, readInferenceResponse } from './candidate-deadline.mjs'
import { assertNativeBinaryArchitecture } from './native-binary-architecture.mjs'
import { stopOwnedChild } from './owned-child-shutdown.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = process.env.RUNTIME_CANDIDATE_OUTPUT
const expectedPlatform = process.env.RUNTIME_EXPECTED_PLATFORM
const expectedArch = process.env.RUNTIME_EXPECTED_ARCH
const sourceCommit = process.env.GITHUB_SHA
const workflowMatch = /^mysticalsin\/AskToto-Mantu\/([a-z0-9./-]+\.yml)@/.exec(process.env.GITHUB_WORKFLOW_REF ?? '')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const LLAMA_COMMIT = 'c4ae9a88f8884ee5a155c8349ace9ea31a58007f'
const LLAMA_LICENSE_SHA256 = '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'
const LLAMA_LICENSE_URL = `https://raw.githubusercontent.com/ggml-org/llama.cpp/${LLAMA_COMMIT}/LICENSE`
const UPSTREAM = {
  'darwin-arm64': {
    file: 'llama-b9957-bin-macos-arm64.tar.gz',
    sha256: '7a43fd3c4ddd30f3c408da7c80975503f18b829da023a7d0e34bdb6f1b1a056f'
  },
  'darwin-x64': {
    file: 'llama-b9957-bin-macos-x64.tar.gz',
    sha256: 'f03f6669c7e34c2768ca4a318dd13e105dec46e1f87a2165d2be7fd6a0ee4716'
  },
  'win32-x64': {
    file: 'llama-b9957-bin-win-cpu-x64.zip',
    sha256: '422ad9b46f5ab60f7fd2e83783233eba2d9383e6f17d7ee916c80f19eb070e79'
  }
}

function fail(code) {
  throw new Error(code)
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function requireActionIdentity() {
  if (process.env.GITHUB_ACTIONS !== 'true' || !output || !workflowMatch) fail('RUNTIME_LLAMA_ACTION_CONTEXT_INVALID')
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '') || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_WORKFLOW_SHA ?? ''))
    fail('RUNTIME_LLAMA_SOURCE_IDENTITY_INVALID')
  if (!/^[0-9]{1,20}$/.test(process.env.GITHUB_RUN_ID ?? '')) fail('RUNTIME_LLAMA_RUN_IDENTITY_INVALID')
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT)
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1000) fail('RUNTIME_LLAMA_RUN_IDENTITY_INVALID')
  if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') fail('RUNTIME_LLAMA_RUNNER_NOT_HOSTED')
  if (process.platform !== expectedPlatform || process.arch !== expectedArch)
    fail('RUNTIME_LLAMA_NATIVE_TARGET_MISMATCH')
}

function electronExecutable() {
  if (process.platform === 'darwin')
    return resolve(repository, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  return resolve(repository, 'node_modules/electron/dist/electron.exe')
}

async function readElectronFacts(temporary) {
  const electron = JSON.parse(await readFile(resolve(repository, 'node_modules/electron/package.json'), 'utf8'))
  const locked = JSON.parse(await readFile(resolve(repository, 'package-lock.json'), 'utf8'))
  if (electron.version !== locked.packages?.['node_modules/electron']?.version || electron.version !== '43.6.0')
    fail('RUNTIME_LLAMA_ELECTRON_VERSION_MISMATCH')
  const probeDirectory = resolve(temporary, 'electron-probe')
  const factsPath = resolve(temporary, 'electron-facts.json')
  await mkdir(probeDirectory, { recursive: true })
  await writeFile(resolve(probeDirectory, 'package.json'), '{"name":"metis-runtime-facts-probe","main":"main.cjs"}\n', {
    flag: 'wx'
  })
  await writeFile(
    resolve(probeDirectory, 'main.cjs'),
    "const { app } = require('electron'); const fs = require('node:fs'); fs.writeFileSync(process.env.METIS_RUNTIME_FACTS_PATH, JSON.stringify(process.versions)); app.quit();\n",
    { flag: 'wx' }
  )
  const child = spawnSync(electronExecutable(), [probeDirectory], {
    env: { ...process.env, METIS_RUNTIME_FACTS_PATH: factsPath },
    timeout: 60_000,
    stdio: 'ignore'
  })
  if (child.error || child.status !== 0) fail('RUNTIME_LLAMA_ELECTRON_FACTS_PROBE_FAILED')
  const versions = JSON.parse(await readFile(factsPath, 'utf8'))
  if (
    versions.electron !== electron.version ||
    !/^\d+$/.test(versions.modules ?? '') ||
    !/^\d+$/.test(versions.napi ?? '') ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(versions.chrome ?? '')
  )
    fail('RUNTIME_LLAMA_ELECTRON_FACTS_INVALID')
  return {
    electronVersion: versions.electron,
    nodeAbi: versions.modules,
    napi: versions.napi,
    chromiumVersion: versions.chrome,
    hostProtocol: 1
  }
}

function cleanRuntimeEnvironment(directory) {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot
    if (!systemRoot || !/^[A-Za-z]:\\Windows$/.test(systemRoot)) fail('RUNTIME_LLAMA_WINDOWS_SYSTEM_ROOT_INVALID')
    return {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: `${directory};${resolve(systemRoot, 'System32')}`,
      TEMP: process.env.RUNNER_TEMP,
      TMP: process.env.RUNNER_TEMP
    }
  }
  return { HOME: process.env.RUNNER_TEMP, LANG: 'C', LC_ALL: 'C' }
}

async function smokeInfer(binary, model, directory) {
  const args = [
    '-m',
    model,
    '--no-mmproj',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '-c',
    '512',
    '--parallel',
    '1',
    '--cache-ram',
    '128',
    '-ngl',
    '0',
    '-t',
    '2',
    '-tb',
    '2',
    '--threads-http',
    '2',
    '--no-ui',
    '--jinja',
    '--reasoning',
    'off'
  ]
  const child = spawn(binary, args, {
    cwd: directory,
    env: cleanRuntimeEnvironment(directory),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let collected = ''
  let port = 0
  let timedOut = false
  let spawnFailed = false
  const start = performance.now()
  const deadline = start + 300_000
  let inferenceResult
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, 300_000)
  child.on('error', () => {
    spawnFailed = true
  })
  child.stdout.on('data', (chunk) => {
    collected = `${collected}${chunk.toString('utf8')}`.slice(-16_384)
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(collected)
    if (match) port = Number(match[1])
  })
  child.stderr.on('data', (chunk) => {
    collected = `${collected}${chunk.toString('utf8')}`.slice(-16_384)
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(collected)
    if (match) port = Number(match[1])
  })
  const ensureWithinDeadline = () => {
    if (timedOut) fail('RUNTIME_LLAMA_INFERENCE_TIMEOUT')
    assertBeforeDeadline(deadline)
  }
  try {
    const listenDeadline = Math.min(performance.now() + 180_000, deadline)
    while (!port && performance.now() < listenDeadline) {
      ensureWithinDeadline()
      if (spawnFailed) fail('RUNTIME_LLAMA_SERVER_SPAWN_FAILED')
      if (child.exitCode !== null) fail('RUNTIME_LLAMA_SERVER_EXITED_BEFORE_LISTEN')
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
    ensureWithinDeadline()
    if (!port) fail('RUNTIME_LLAMA_SERVER_LISTEN_FAILED')
    const healthDeadline = Math.min(performance.now() + 120_000, deadline)
    let healthy = false
    while (performance.now() < healthDeadline) {
      ensureWithinDeadline()
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
        ensureWithinDeadline()
        if (health.status === 200) {
          healthy = true
          break
        }
      } catch {
        if (child.exitCode !== null) fail('RUNTIME_LLAMA_SERVER_EXITED_BEFORE_HEALTH')
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
    ensureWithinDeadline()
    if (!healthy) fail('RUNTIME_LLAMA_SERVER_HEALTH_FAILED')
    const remainingMs = Math.floor(deadline - performance.now())
    if (remainingMs <= 0) fail('RUNTIME_LLAMA_INFERENCE_TIMEOUT')
    const result = await readInferenceResponse(
      fetch,
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'local',
          messages: [{ role: 'user', content: 'Reply with the word ready.' }],
          max_tokens: 8,
          temperature: 0,
          stream: false
        }),
        signal: AbortSignal.timeout(Math.min(90_000, remainingMs))
      },
      deadline
    )
    inferenceResult = { inferencePassed: true, cpuOnly: true, elapsedMs: Math.round(performance.now() - start) }
  } finally {
    clearTimeout(timer)
    await stopOwnedChild(child).catch(() => fail('RUNTIME_LLAMA_CHILD_EXIT_UNCONFIRMED'))
  }
  ensureWithinDeadline()
  return inferenceResult
}

async function downloadLicense(destination) {
  const response = await fetch(LLAMA_LICENSE_URL, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (!response.ok) fail('RUNTIME_LLAMA_LICENSE_FETCH_FAILED')
  if (!response.body) fail('RUNTIME_LLAMA_LICENSE_BODY_MISSING')
  const reader = response.body.getReader()
  const chunks = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = 1079 - totalBytes
    if (remaining <= 0 || value.byteLength > remaining) {
      if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)))
      totalBytes = 1079
      await reader.cancel()
      break
    }
    chunks.push(Buffer.from(value))
    totalBytes += value.byteLength
  }
  if (totalBytes > 1078) fail('RUNTIME_LLAMA_LICENSE_OVERSIZED')
  const bytes = Buffer.concat(chunks, totalBytes)
  if (bytes.length !== 1078 || sha256(bytes) !== LLAMA_LICENSE_SHA256) fail('RUNTIME_LLAMA_LICENSE_PIN_MISMATCH')
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
  return bytes
}

function upstreamFor(platform, arch) {
  return UPSTREAM[`${platform}-${arch}`]
}

async function main() {
  requireActionIdentity()
  if (!['darwin', 'win32'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch))
    fail('RUNTIME_LLAMA_TARGET_UNSUPPORTED')
  const platform = process.platform
  const arch = process.arch
  const target = `${platform}-${arch}`
  const upstream = upstreamFor(platform, arch)
  if (!upstream) fail('RUNTIME_LLAMA_UPSTREAM_PIN_MISSING')
  const sourceDirectory = resolve(
    repository,
    'resources/llama',
    platform === 'darwin' ? 'mac' : 'win',
    platform === 'darwin' ? arch : 'cpu'
  )
  const modelPath = resolve(repository, 'resources/local-llm/models/qwen3.5-0.8b/model.gguf')
  const temporary = await mkdtemp(resolve(tmpdir(), 'metis-llama-runtime-candidate-'))
  const payloadRoot = resolve(temporary, 'payload')
  const runtimeDirectory = resolve(payloadRoot, 'runtime')
  const licensesDirectory = resolve(payloadRoot, 'licenses')
  const candidateOutput = resolve(temporary, 'candidate')
  const metadataPath = resolve(temporary, 'metadata.json')
  try {
    const modelInfo = await stat(modelPath)
    const expectedModel = '3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5'
    if (modelInfo.size !== 558_772_480 || (await hashFile(modelPath)) !== expectedModel)
      fail('RUNTIME_LLAMA_SMOKE_MODEL_PIN_MISMATCH')
    await mkdir(runtimeDirectory, { recursive: true })
    await mkdir(licensesDirectory, { recursive: true })
    const fileNames = (await readdir(sourceDirectory))
      .filter((name) => {
        if (name === 'llama-server' || name === 'llama-server.exe') return true
        return platform === 'darwin' ? name.endsWith('.dylib') : name.endsWith('.dll')
      })
      .sort()
    const binaryName = platform === 'darwin' ? 'llama-server' : 'llama-server.exe'
    if (!fileNames.includes(binaryName) || fileNames.length < 1) fail('RUNTIME_LLAMA_UPSTREAM_CLOSURE_INCOMPLETE')
    for (const name of fileNames) {
      const source = resolve(sourceDirectory, name)
      const destination = resolve(runtimeDirectory, name)
      await copyFile(source, destination)
      if (name === binaryName && platform === 'darwin') await chmod(destination, 0o755)
      await assertNativeBinaryArchitecture(destination, platform, arch)
    }
    const noticePath = resolve(licensesDirectory, 'llama.cpp-LICENSE.txt')
    const notice = await downloadLicense(noticePath)
    const binary = resolve(runtimeDirectory, binaryName)
    const inference = await smokeInfer(binary, modelPath, runtimeDirectory)
    const runtimeFacts = await readElectronFacts(temporary)
    const lockBytes = await readFile(resolve(repository, 'package-lock.json'))
    const electronVersion = JSON.parse(lockBytes.toString('utf8')).packages['node_modules/electron'].version
    const archiveUri = `https://github.com/ggml-org/llama.cpp/releases/download/b9957/${upstream.file}`
    const licenseSourceUri = `https://github.com/ggml-org/llama.cpp/blob/${LLAMA_COMMIT}/LICENSE`
    const metadata = {
      schemaVersion: 1,
      kind: 'runtime',
      componentId: 'runtime.llama-server',
      artifactId: `runtime.llama-server-${target}`,
      target: { platform, arch },
      runtime: runtimeFacts,
      entrypoints: { 'llama-server': `runtime/${binaryName}` },
      models: [],
      source: {
        repositoryUri: 'https://github.com/mysticalsin/AskToto-Mantu',
        commit: sourceCommit,
        workflowPath: workflowMatch[1],
        workflowCommit: process.env.GITHUB_WORKFLOW_SHA,
        runId: process.env.GITHUB_RUN_ID,
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        lockSha256: sha256(lockBytes),
        ref: process.env.GITHUB_REF,
        runnerEnvironment: process.env.RUNNER_ENVIRONMENT
      },
      builder: {
        nodeVersion: process.version,
        npmVersion: process.env.RUNTIME_NPM_VERSION ?? '',
        zlibVersion: process.versions.zlib,
        packages: [{ name: 'electron', version: electronVersion }]
      },
      upstream: [
        {
          name: 'llama.cpp prebuilt native server archive',
          version: 'b9957',
          sourceUri: archiveUri,
          revision: LLAMA_COMMIT,
          digest: { algorithm: 'sha256', value: upstream.sha256 }
        }
      ],
      licenses: [
        {
          package: 'llama.cpp',
          version: 'b9957',
          spdx: 'MIT',
          sourceUri: 'https://github.com/ggml-org/llama.cpp',
          noticePath: 'licenses/llama.cpp-LICENSE.txt',
          noticeBytes: notice.length,
          noticeSha256: sha256(notice),
          sourceReceiptUri: licenseSourceUri
        }
      ]
    }
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    const build = spawnSync(
      process.execPath,
      [
        resolve(repository, 'scripts/runtime-payload/create-payload.mjs'),
        '--root',
        payloadRoot,
        '--metadata',
        metadataPath,
        '--output',
        candidateOutput
      ],
      { encoding: 'utf8', env: process.env, timeout: 120_000 }
    )
    if (build.error || build.status !== 0) fail('RUNTIME_LLAMA_PAYLOAD_BUILD_FAILED')
    const candidate = JSON.parse(await readFile(resolve(candidateOutput, 'candidate.json'), 'utf8'))
    await mkdir(output, { recursive: true })
    for (const filename of [candidate.archive.path, candidate.inventory.path, 'candidate.json']) {
      await writeFile(resolve(output, filename), await readFile(resolve(candidateOutput, filename)), {
        flag: 'wx',
        mode: 0o600
      })
    }
    await writeFile(
      resolve(output, 'runtime-inference.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          componentId: metadata.componentId,
          target,
          nativeFilesVerified: fileNames.length,
          modelId: 'qwen3.5-0.8b',
          modelSha256: expectedModel,
          modelIncludedInArchive: false,
          licenseCoverageComplete: false,
          ...inference
        },
        null,
        2
      )}\n`,
      { flag: 'wx', mode: 0o600 }
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

main().catch((error) => {
  const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'RUNTIME_LLAMA_CANDIDATE_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
