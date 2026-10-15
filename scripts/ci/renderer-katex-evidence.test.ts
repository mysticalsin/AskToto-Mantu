import { createPackageWithOptions } from '@electron/asar'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import {
  cpSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { finished } from 'node:stream/promises'
import type { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EVIDENCE_CASES,
  GREEN_CASES,
  RendererAttemptReporter,
  checkAudit,
  checkGreenReport,
  checkEvidenceSuite,
  checkHarnessOrigins,
  checkNpmProducer,
  checkNpmInstalledGraph,
  checkRunErrors,
  checkSbom,
  validateLockDelta,
  validateRetainedSharpFallbackAmendment,
  validateRemediationPackageRecords,
  validateRemediationLineageFacts
} from './renderer-katex-provenance.mjs'
import {
  compareInventories,
  findEmbeddedOldKaTeX,
  validateLocalAssetReferences,
  validateBuildEvidence,
  validateGraph
} from './renderer-katex-build-evidence.mjs'
import { inspectCandidate } from './renderer-katex-shipping-evidence.mjs'
import { packageInventoryIdentity } from '../lib/package-inventory.mjs'

const roots: string[] = []
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const noticeText = readFileSync(resolve(process.cwd(), 'THIRD_PARTY_NOTICES.md'), 'utf8')
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'renderer-katex-evidence-'))
  roots.push(root)
  return root
}
function put(path: string, value: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}
function copyFixture(source: string, destination: string) {
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination)
}
function reject(call: () => unknown, code: string) {
  expect(call).toThrow(new RegExp(code.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env.METIS_PACKAGE_PROFILE
  delete process.env.GITHUB_RUN_ID
  delete process.env.GITHUB_RUN_ATTEMPT
  delete process.env.GITHUB_JOB
  delete process.env.GITHUB_SHA
  delete process.env.RUNNER_OS
  delete process.env.RENDERER_PACKAGE_TARGET
  delete process.env.ASKTOTO_MAC_UNIVERSAL
  delete process.env.RENDERER_ATTEMPT_REPORT
  delete process.env.REPORT_DIR
})

function validGraph(): {
  schema: number
  appEntries: string[]
  externalModules: string[]
  modules: Array<{ id: string; imports: string[]; dynamicImports: string[]; chunks: string[]; renderedLength: number }>
  chunks: Array<{
    fileName: string
    isEntry: boolean
    isWorkerOutput: boolean
    imports: string[]
    dynamicImports: string[]
    generatedAssets: string[]
    bytes: number
    sha256: string
    facadeModuleId: string | null
    moduleIds: string[]
    renderedModules: Array<{ id: string; renderedLength: number; renderedExports: string[] }>
  }>
  assets: Array<{
    fileName: string
    bytes: number
    sha256: string
    generatorModules?: string[]
    generatorChunks?: string[]
    source?: string
  }>
  workers: Array<{
    fileName: string
    entryModuleId: string
    bytes: number
    sha256: string
    chunks: Array<{ fileName: string; bytes: number; sha256: string; moduleIds: string[]; isEntry: boolean }>
  }>
  publicFiles: Array<{ path: string; source: string; bytes: number; sha256: string }>
  config: {
    command: string
    mode: string
    configFiles: Array<{ path: string }>
    outerConfig?: { path: string; files: Array<{ path: string; sha256: string }> }
  }
  buildRun: {
    schema: number
    sourceCommit: string
    runId: string
    runAttempt: string
    job: string
    runnerOs: string
    runnerPlatform: string
    runnerArch: string
    profile: string
    packageTarget: string
    macUniversal: string
    ordinaryBuildExitCode: number
    observedBuildExitCode: number
    configurationHashes: Record<string, string>
  }
} {
  const markdown = '/repo/src/renderer/src/components/Markdown.tsx'
  const streamdown = '/repo/node_modules/streamdown/index.js'
  const indexHtml = '/repo/src/renderer/index.html'
  const decoderHtml = '/repo/src/renderer/decoder.html'
  const lazy = '/repo/src/renderer/lazy.ts'
  const worker = '/repo/src/renderer/src/lib/whisper.worker.ts'
  const renderedLengths = new Map([
    [markdown, 120],
    [streamdown, 50],
    [indexHtml, 10],
    [decoderHtml, 10],
    [lazy, 30],
    [worker, 22]
  ])
  const chunk = (fileName: string, moduleIds: string[], isEntry: boolean, facadeModuleId?: string) => ({
    fileName,
    isEntry,
    isWorkerOutput: fileName === 'assets/whisper.worker-abc.js',
    imports: [],
    dynamicImports: [],
    generatedAssets: [],
    bytes: Buffer.byteLength(fileName),
    sha256: sha(fileName),
    facadeModuleId: facadeModuleId || null,
    moduleIds,
    renderedModules: moduleIds.map((id) => ({ id, renderedLength: renderedLengths.get(id)!, renderedExports: [] }))
  })
  const workerChunk = chunk('assets/whisper.worker-abc.js', [worker], true, worker)
  return {
    schema: 1,
    appEntries: ['src/renderer/index.html', 'src/renderer/decoder.html'],
    externalModules: [],
    modules: [
      { id: markdown, imports: [], dynamicImports: [], chunks: ['index.js'], renderedLength: 120 },
      { id: streamdown, imports: [], dynamicImports: [], chunks: ['index.js'], renderedLength: 50 },
      { id: indexHtml, imports: [], dynamicImports: [], chunks: ['index.js'], renderedLength: 10 },
      { id: decoderHtml, imports: [], dynamicImports: [], chunks: ['decoder.js'], renderedLength: 10 },
      { id: lazy, imports: [], dynamicImports: [], chunks: ['lazy.js'], renderedLength: 30 },
      { id: worker, imports: [], dynamicImports: [], chunks: ['assets/whisper.worker-abc.js'], renderedLength: 22 }
    ],
    chunks: [
      chunk('index.js', [markdown, streamdown, indexHtml], true, indexHtml),
      chunk('decoder.js', [decoderHtml], true, decoderHtml),
      chunk('lazy.js', [lazy], false),
      workerChunk
    ],
    assets: [
      {
        fileName: 'index.html',
        bytes: 1,
        sha256: sha('index.html'),
        generatorModules: [indexHtml],
        generatorChunks: ['index.js']
      },
      {
        fileName: 'decoder.html',
        bytes: 1,
        sha256: sha('decoder.html'),
        generatorModules: [decoderHtml],
        generatorChunks: ['decoder.js']
      }
    ],
    workers: [
      {
        fileName: 'assets/whisper.worker-abc.js',
        entryModuleId: worker,
        bytes: workerChunk.bytes,
        sha256: workerChunk.sha256,
        chunks: [
          {
            fileName: workerChunk.fileName,
            bytes: workerChunk.bytes,
            sha256: workerChunk.sha256,
            moduleIds: workerChunk.moduleIds,
            isEntry: true
          }
        ]
      }
    ],
    publicFiles: [],
    config: { command: 'build', mode: 'production', configFiles: [] },
    buildRun: {
      schema: 1,
      sourceCommit: '',
      runId: '',
      runAttempt: '',
      job: '',
      runnerOs: '',
      runnerPlatform: '',
      runnerArch: '',
      profile: 'full',
      packageTarget: 'win-x64',
      macUniversal: '0',
      ordinaryBuildExitCode: 0,
      observedBuildExitCode: 0,
      configurationHashes: {}
    }
  }
}

function validGreenReport() {
  const groups = new Map<
    string,
    {
      file: string
      suite: string
      assertions: Array<{
        title: string
        fullName: string
        ancestorTitles: string[]
        status: string
        failureMessages: string[]
      }>
    }
  >()
  for (const [file, suite, title] of GREEN_CASES) {
    const group = groups.get(file) || { file, suite, assertions: [] }
    group.assertions.push({
      title,
      fullName: `${suite} ${title}`,
      ancestorTitles: [suite],
      status: 'passed',
      failureMessages: []
    })
    groups.set(file, group)
  }
  const testResults = [...groups.values()].map(({ file, assertions }) => ({
    name: join(process.cwd(), file),
    status: 'passed',
    message: '',
    assertionResults: assertions
  }))
  return {
    success: true,
    numTotalTests: 30,
    numPassedTests: 30,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 10,
    numPassedTestSuites: 10,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults
  }
}

function validAttemptReport(cases: ReadonlyArray<readonly [string, string, string]>) {
  return {
    schema: 1,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    job: process.env.GITHUB_JOB || null,
    runnerOs: process.env.RUNNER_OS || process.platform,
    sourceCommit: process.env.GITHUB_SHA || null,
    reason: 'passed',
    unhandledErrorCount: 0,
    moduleResults: [...new Set(cases.map(([file]) => file))].map((file) => ({
      file: resolve(process.cwd(), file),
      state: 'passed',
      errors: 0,
      diagnosticAvailable: true
    })),
    testCases: cases.map(([file, suite, title]) => ({
      file: resolve(process.cwd(), file),
      ancestorTitles: [suite],
      title,
      state: 'passed',
      retryCount: 0,
      repeatCount: 0,
      flaky: false,
      retryOption: 0,
      repeatOption: 0
    }))
  }
}
function greenPaths(root: string, report = validGreenReport(), attempt = validAttemptReport(GREEN_CASES)) {
  const reportPath = join(root, 'green.json')
  const logPath = join(root, 'vitest.log')
  const attemptPath = join(root, 'attempt-evidence.json')
  put(reportPath, JSON.stringify(report))
  put(logPath, 'Test Files  5 passed (5)\nTests  30 passed (30)\n')
  put(attemptPath, JSON.stringify(attempt))
  return { reportPath, logPath, attemptPath }
}
function structuralRenderer(stage: string, indexBytes: Buffer, includeWorker = true) {
  const other = ['index.js', 'decoder.js', 'lazy.js', 'assets/whisper.worker-abc.js', 'decoder.html']
  const inventory = [{ path: 'index.html', bytes: indexBytes.length, sha256: sha(indexBytes) }]
  for (const path of other) {
    const bytes = Buffer.from(path)
    if (includeWorker || path !== 'assets/whisper.worker-abc.js') put(join(stage, 'out/renderer', path), bytes)
    inventory.push({ path, bytes: bytes.length, sha256: sha(bytes) })
  }
  return inventory.sort((a, b) => a.path.localeCompare(b.path))
}
function listFiles(root: string, prefix = ''): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? listFiles(join(root, entry.name), name) : [name]
  })
}
async function candidateBinding(
  root: string,
  resources: string,
  profile: 'full' | 'lean',
  arch: string,
  rendererInventory: Array<{ path: string; bytes: number; sha256: string }>,
  fontAttributions: Array<{
    origin: string
    path: string
    sha256: string
    licensePackage: string
    licenseSha256: string
    sourcePath: string
  }> = [],
  noticeOverride = noticeText
) {
  process.env.GITHUB_SHA = 'd'.repeat(40)
  process.env.GITHUB_RUN_ID = '71'
  process.env.GITHUB_RUN_ATTEMPT = '1'
  process.env.GITHUB_JOB = 'renderer-consumer'
  process.env.RUNNER_OS = arch === 'win-x64' ? 'Windows' : 'macOS'
  const sourceRoot = join(root, `candidate-source-${profile}-${arch}`)
  const builder = readFileSync(resolve(process.cwd(), 'electron-builder.yml'), 'utf8')
  put(join(sourceRoot, 'electron-builder.yml'), builder)
  copyFixture(resolve(process.cwd(), 'electron.vite.config.ts'), join(sourceRoot, 'electron.vite.config.ts'))
  for (const path of [
    'package.json',
    'package-lock.json',
    'electron-builder.win.yml',
    'scripts/before-pack.mjs',
    'scripts/design/renderer-inputs.ts'
  ])
    copyFixture(resolve(process.cwd(), path), join(sourceRoot, path))
  const licenseNames = ['katex', 'mermaid', 'streamdown']
  for (const name of licenseNames)
    copyFixture(
      resolve(process.cwd(), 'node_modules', name, 'LICENSE'),
      join(sourceRoot, 'node_modules', name, 'LICENSE')
    )
  copyFixture(
    resolve(process.cwd(), 'node_modules/typescript/LICENSE.txt'),
    join(sourceRoot, 'node_modules/typescript/LICENSE.txt')
  )
  copyFixture(
    resolve(process.cwd(), 'node_modules/@fontsource-variable/inter/LICENSE'),
    join(sourceRoot, 'node_modules/@fontsource-variable/inter/LICENSE')
  )
  copyFixture(
    resolve(process.cwd(), 'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2'),
    join(sourceRoot, 'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2')
  )
  for (const name of ['geist-sans.woff2', 'inter.woff2'])
    copyFixture(
      resolve(process.cwd(), 'src/renderer/src/assets/fonts', name),
      join(sourceRoot, 'src/renderer/src/assets/fonts', name)
    )
  const oldMember = 'node_modules/mermaid/dist/chunks/mermaid.esm/katex-HNBAO5SE.mjs'
  copyFixture(resolve(process.cwd(), oldMember), join(sourceRoot, oldMember))
  const oldBytes = readFileSync(join(sourceRoot, oldMember))
  const sourceByDestination = new Map<string, string>()
  if (profile === 'full') {
    const sections = [builder.slice(0, builder.search(/^mac:/mu))]
    sections.push(
      arch === 'win-x64'
        ? builder.slice(builder.search(/^win:/mu))
        : builder.slice(builder.search(/^mac:/mu), builder.search(/^win:/mu))
    )
    const mappings = sections.flatMap((section) =>
      [...section.matchAll(/^\s+- from: ([^\n]+)\n\s+to: ([^\n]+)/gmu)].map((match) => ({
        from: match[1].trim(),
        to: match[2].trim()
      }))
    )
    for (const mapping of mappings) {
      const fileDestination = /\.[A-Za-z0-9]+$/u.test(mapping.to)
      const destinations = fileDestination
        ? [mapping.to]
        : mapping.from === 'resources/local-llm/models'
          ? ['local-llm/models/qwen3.5-0.8b/model.gguf', 'local-llm/models/qwen3.5-0.8b/mmproj.gguf']
          : existsSync(join(resources, mapping.to)) && listFiles(join(resources, mapping.to)).length
            ? listFiles(join(resources, mapping.to)).map((path) => `${mapping.to}/${path}`)
            : [`${mapping.to}/fixture.bin`]
      for (const destination of destinations) {
        const suffix = destination === mapping.to ? '' : destination.slice(mapping.to.length + 1)
        const source = suffix ? `${mapping.from}/${suffix}` : mapping.from
        const value =
          destination === 'speech-pack-profile.json'
            ? '{"schema":1,"profile":"full"}\n'
            : destination === 'THIRD_PARTY_NOTICES.md'
              ? noticeOverride
              : statSync(join(resources, destination), { throwIfNoEntry: false })?.isFile()
                ? readFileSync(join(resources, destination))
                : `structural resource ${destination}`
        put(join(sourceRoot, source), value)
        put(join(resources, destination), value)
        sourceByDestination.set(destination, source)
      }
    }
  } else {
    put(join(resources, 'intelligence/index.html'), '<html>fixture intelligence</html>')
    for (const name of ['operator', 'license-lease', 'cloudflare-embed', 'skills', 'intelligence'])
      mkdirSync(join(resources, name), { recursive: true })
    const platform = arch === 'win-x64' ? 'win32' : 'darwin'
    const folder = `${platform}-${arch.split('-').at(-1)}`
    const managedFolder = platform === 'win32' ? 'win-x64' : folder
    const requiredFiles = [
      `ffmpeg/${folder}/${platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`,
      `managed-node/${managedFolder}/${platform === 'win32' ? 'node.exe' : 'bin/node'}`,
      platform === 'win32' ? 'vcredist/vc_redist.x64.exe' : 'mac-helper/metis-mac-helper',
      'ffmpeg/LICENSE.LGPL-2.1.txt',
      'skills/caveman/SKILL.md',
      'graphify_runner.py',
      'icon.png',
      'tray/tray.png',
      'speech-pack-fixtures/en.wav',
      'managed-config.example.json',
      'managed-config.enterprise.example.json'
    ]
    for (const path of requiredFiles)
      if (!existsSync(join(resources, path))) put(join(resources, path), `structural fixture ${path}`)
    copyFixture(resolve(process.cwd(), 'resources/ffmpeg/manifest.json'), join(resources, 'ffmpeg/manifest.json'))
    copyFixture(
      resolve(process.cwd(), 'resources/ffmpeg/manifest.json'),
      join(sourceRoot, 'resources/ffmpeg/manifest.json')
    )
    copyFixture(
      resolve(process.cwd(), 'src/shared/managed-node-manifest.json'),
      join(sourceRoot, 'src/shared/managed-node-manifest.json')
    )
    const resourcePaths = listFiles(resources).filter(
      (path) => path !== 'app.asar' && !path.startsWith('app.asar.unpacked/')
    )
    for (const destination of resourcePaths) {
      const source = `build/lean-stage/resources/${destination}`
      put(join(sourceRoot, source), readFileSync(join(resources, destination)))
      sourceByDestination.set(destination, source)
    }
    for (const path of listFiles(join(resources, 'intelligence')))
      copyFixture(join(resources, 'intelligence', path), join(sourceRoot, 'intelligence/dist', path))
    const stageRoot = join(sourceRoot, 'build/lean-stage/resources')
    const stageFiles = listFiles(stageRoot)
      .map((path) => {
        const bytes = readFileSync(join(stageRoot, path))
        return { path, bytes: bytes.length, sha256: sha(bytes) }
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const signedPayloads = new Set(requiredFiles.slice(0, 3))
    const manifest = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(join(sourceRoot, 'package-lock.json'), 'utf8'))
    const inventory = {
      schema: 1,
      profile: 'lean',
      platform: arch === 'win-x64' ? 'win32' : 'darwin',
      arch: arch.split('-').at(-1),
      appVersion: manifest.version,
      electronVersion: lock.packages['node_modules/electron'].version,
      sourceCommit: process.env.GITHUB_SHA,
      coreFiles: stageFiles.filter((entry) => !signedPayloads.has(entry.path)),
      identity: ''
    }
    inventory.identity = packageInventoryIdentity(inventory)
    const inventoryText = `${JSON.stringify(inventory)}\n`
    put(join(stageRoot, 'package-inventory.json'), inventoryText)
    put(join(resources, 'package-inventory.json'), inventoryText)
    sourceByDestination.set('package-inventory.json', 'build/lean-stage/resources/package-inventory.json')
  }
  const configurationHashes = Object.fromEntries(
    [
      'electron.vite.config.ts',
      'package.json',
      'package-lock.json',
      'electron-builder.yml',
      'electron-builder.win.yml',
      'scripts/before-pack.mjs',
      'scripts/design/renderer-inputs.ts'
    ].map((path) => [path, sha(readFileSync(join(sourceRoot, path)))])
  )
  const buildRun = {
    schema: 1,
    sourceCommit: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    job: 'renderer-build',
    runnerOs: process.env.RUNNER_OS,
    profile,
    packageTarget: arch,
    macUniversal: arch === 'mac-universal' ? '1' : '0',
    ordinaryBuildExitCode: 0,
    observedBuildExitCode: 0,
    configurationHashes
  }
  const buildPath = join(root, 'build.json')
  const normalizedInventory = rendererInventory
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const graph = validGraph()
  graph.config.outerConfig = {
    path: 'electron.vite.config.ts',
    files: [
      { path: 'electron.vite.config.ts', sha256: configurationHashes['electron.vite.config.ts'] },
      { path: 'scripts/design/renderer-inputs.ts', sha256: configurationHashes['scripts/design/renderer-inputs.ts'] }
    ]
  }
  graph.buildRun = { ...buildRun, runnerPlatform: process.platform, runnerArch: process.arch }
  for (const asset of graph.assets) {
    const identity = normalizedInventory.find((entry) => entry.path === asset.fileName)!
    asset.bytes = identity.bytes
    asset.sha256 = identity.sha256
  }
  const graphPath = join(root, 'renderer-graph.json')
  put(graphPath, JSON.stringify(graph))
  const buildReceipt = {
    schema: 2,
    evidence: 'PRODUCTION_RENDERER_GRAPH_AND_BYTES_VERIFIED',
    sourceCommit: process.env.GITHUB_SHA,
    profile,
    buildRun: graph.buildRun,
    graphSha256: sha(readFileSync(graphPath)),
    graph: await validateGraph(graph, normalizedInventory, sourceRoot),
    ordinaryObservedByteEquality: compareInventories(normalizedInventory, normalizedInventory),
    ordinaryInventory: normalizedInventory,
    observedInventory: normalizedInventory,
    katexArchive: {
      installedPackageBytesMatchSRIArchive: true,
      integrity: 'sha512-3snve4y0SXTMequLim1FMiPvLGElySam0blN5xQZBqEY3lOJz1TnuaaiugnBZBqHzlSAGmFTYL7MCQkORuLKCA==',
      archiveSha256: 'a71df261a7080b53a4be44ea1b40e8e73e84cdd5d3311239310568e76437c018'
    },
    mermaidResidue: {
      knownEmbeddedOldKaTeX: [{ path: oldMember, bytes: oldBytes.length, sha256: sha(oldBytes), version: '0.16.47' }],
      embeddedComponentAddendum: {
        advisory: 'GHSA-238p-pmpm-9mq7 / CVE-2026-103923',
        shippedStatus: 'UNKNOWN: structural fixture only',
        installedMembers: [{ path: oldMember, bytes: oldBytes.length, sha256: sha(oldBytes), version: '0.16.47' }]
      }
    }
  }
  put(buildPath, JSON.stringify(buildReceipt))
  const receiptPath = join(root, 'candidate-receipt.json')
  const executable = Buffer.alloc(1024)
  const executableRelativePath = arch === 'win-x64' ? '../Metis.exe' : '../MacOS/Metis'
  if (arch === 'win-x64') {
    executable.write('MZ', 0, 'ascii')
    executable.writeUInt32LE(128, 0x3c)
    executable.write('PE\0\0', 128, 'ascii')
    executable.writeUInt16LE(0x8664, 132)
    executable.writeUInt16LE(240, 148)
    executable.writeUInt16LE(0x20b, 152)
    executable.writeUInt32LE(16, 260)
  } else if (arch === 'mac-universal') {
    executable.writeUInt32BE(0xcafebabe, 0)
    executable.writeUInt32BE(2, 4)
    executable.writeUInt32BE(0x01000007, 8)
    executable.writeUInt32BE(0x0100000c, 28)
    executable.writeUInt32BE(512, 16)
    executable.writeUInt32BE(256, 20)
    executable.writeUInt32BE(768, 36)
    executable.writeUInt32BE(256, 40)
    executable.writeUInt32LE(0xfeedfacf, 512)
    executable.writeUInt32LE(0x01000007, 516)
    executable.writeUInt32LE(0xfeedfacf, 768)
    executable.writeUInt32LE(0x0100000c, 772)
  } else {
    executable.writeUInt32LE(0xfeedfacf, 0)
    executable.writeUInt32LE(arch === 'mac-arm64' ? 0x0100000c : 0x01000007, 4)
  }
  put(resolve(resources, executableRelativePath), executable)
  put(
    receiptPath,
    JSON.stringify({
      schema: 1,
      sourceCommit: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      job: 'renderer-package',
      runnerOs: process.env.RUNNER_OS,
      profile,
      packageTarget: arch,
      packageTool: 'electron-builder',
      signatureScope: 'pre-sign-source-equal-app-tree',
      packageExitCode: 0,
      executable: {
        relativePath: executableRelativePath,
        bytes: executable.length,
        sha256: sha(executable),
        signatureStatus: 'unsigned-executable-header'
      },
      appAsarSha256: sha(readFileSync(join(resources, 'app.asar'))),
      buildEvidenceSha256: sha(readFileSync(buildPath)),
      configurationHashes,
      fontAttributions,
      looseResources: [...sourceByDestination]
        .map(([path, source]) => {
          const bytes = readFileSync(join(resources, path))
          return { path, source, bytes: bytes.length, sha256: sha(bytes) }
        })
        .sort((a, b) => a.path.localeCompare(b.path))
    })
  )
  return { buildPath, receiptPath, sourceRoot }
}

describe('renderer remediation evidence validators', () => {
  it('accepts exact ordinary/observed byte identity and rejects changed, duplicate, or incomplete files', () => {
    const ordinary = [{ path: 'index.js', bytes: 3, sha256: sha('abc') }]
    expect(compareInventories(ordinary, structuredClone(ordinary)).fileCount).toBe(1)
    reject(
      () => compareInventories(ordinary, [{ ...ordinary[0], sha256: sha('abd') }]),
      'ORDINARY_OBSERVED_BYTES_DIFFER'
    )
    reject(() => compareInventories(ordinary, [...ordinary, ordinary[0]]), 'INVENTORY_DUPLICATE_PATH')
    reject(() => compareInventories(ordinary, []), 'INVENTORY_SCHEMA')
  })

  it('requires complete static, dynamic, asset, and worker output membership in the production graph', async () => {
    const files = ['index.js', 'lazy.js', 'assets/whisper.worker-abc.js', 'decoder.js']
      .map((path) => ({
        path,
        bytes: Buffer.byteLength(path),
        sha256: sha(path)
      }))
      .concat(['index.html', 'decoder.html'].map((path) => ({ path, bytes: 1, sha256: sha(path) })))
    expect((await validateGraph(validGraph(), files)).workerCount).toBe(1)
    const omittedWorker = validGraph()
    omittedWorker.workers = []
    await expect(validateGraph(omittedWorker, files)).rejects.toThrow('GRAPH_REQUIRED_WORKER_MISSING')
    const transformedOld = validGraph()
    transformedOld.modules.push({
      id: '/repo/node_modules/mermaid/dist/chunks/mermaid.esm/katex-HNBAO5SE.mjs',
      imports: [],
      dynamicImports: [],
      chunks: ['index.js'],
      renderedLength: 1
    })
    transformedOld.chunks[0].moduleIds.push(transformedOld.modules.at(-1)!.id)
    transformedOld.chunks[0].renderedModules.push({
      id: transformedOld.modules.at(-1)!.id,
      renderedLength: 1,
      renderedExports: []
    })
    await expect(validateGraph(transformedOld, files)).rejects.toThrow('OLD_MERMAID_RUNTIME_MODULE')
    const inconsistent = validGraph()
    inconsistent.chunks[0].renderedModules[0].renderedLength = 119
    await expect(validateGraph(inconsistent, files)).rejects.toThrow('GRAPH_MODULE_RENDERED_MEMBERSHIP')
    const missingDynamicTarget = validGraph()
    ;(missingDynamicTarget.modules[0] as { dynamicImports: string[] }).dynamicImports = ['/repo/not-in-graph.ts']
    await expect(validateGraph(missingDynamicTarget, files)).rejects.toThrow('GRAPH_MODULE_EDGE')
    await expect(
      validateGraph(
        validGraph(),
        files.filter((entry) => entry.path !== 'lazy.js')
      )
    ).rejects.toThrow('GRAPH_OUTPUT_MISSING')
    const wasmRoot = tempRoot()
    const wasmSource = 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm'
    const wasmBytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
    put(join(wasmRoot, wasmSource), wasmBytes)
    const wasmGraph = validGraph()
    wasmGraph.assets.push({
      fileName: 'assets/ort-wasm-simd-threaded.jsep.wasm',
      source: wasmSource,
      bytes: wasmBytes.length,
      sha256: sha(wasmBytes)
    })
    const wasmFiles = [
      ...files,
      { path: 'assets/ort-wasm-simd-threaded.jsep.wasm', bytes: wasmBytes.length, sha256: sha(wasmBytes) }
    ]
    expect((await validateGraph(wasmGraph, wasmFiles, wasmRoot)).assetCount).toBe(3)
    const unboundWasm = structuredClone(wasmGraph)
    delete unboundWasm.assets.at(-1)!.source
    unboundWasm.chunks[0].generatedAssets.push('assets/ort-wasm-simd-threaded.jsep.wasm')
    unboundWasm.assets.at(-1)!.generatorChunks = ['index.js']
    unboundWasm.assets.at(-1)!.generatorModules = unboundWasm.chunks[0].moduleIds
    await expect(validateGraph(unboundWasm, wasmFiles, wasmRoot)).rejects.toThrow('EXECUTABLE_ASSET_PROVENANCE_MISSING')
    put(join(wasmRoot, wasmSource), Buffer.from([0, 97, 115, 109, 2, 0, 0, 0]))
    await expect(validateGraph(wasmGraph, wasmFiles, wasmRoot)).rejects.toThrow('EXECUTABLE_ASSET_SOURCE_MISMATCH')
    const secondWorker = validGraph()
    const firstWorker = secondWorker.workers[0]
    const extraWorkerId = '/repo/src/renderer/src/lib/secondary.worker.ts'
    const extraWorkerPath = 'assets/secondary.worker-def.js'
    secondWorker.modules.push({
      id: extraWorkerId,
      imports: [],
      dynamicImports: [],
      chunks: [extraWorkerPath],
      renderedLength: 8
    })
    secondWorker.chunks.push({
      ...structuredClone(secondWorker.chunks[3]),
      fileName: extraWorkerPath,
      facadeModuleId: extraWorkerId,
      moduleIds: [extraWorkerId],
      renderedModules: [{ id: extraWorkerId, renderedLength: 8, renderedExports: [] }],
      bytes: extraWorkerPath.length,
      sha256: sha(extraWorkerPath)
    })
    secondWorker.workers.push({
      ...structuredClone(firstWorker),
      fileName: extraWorkerPath,
      entryModuleId: extraWorkerId,
      bytes: extraWorkerPath.length,
      sha256: sha(extraWorkerPath),
      chunks: [
        {
          fileName: extraWorkerPath,
          bytes: extraWorkerPath.length,
          sha256: sha(extraWorkerPath),
          moduleIds: [extraWorkerId],
          isEntry: true
        }
      ]
    })
    const twoWorkerFiles = [
      ...files,
      { path: extraWorkerPath, bytes: extraWorkerPath.length, sha256: sha(extraWorkerPath) }
    ]
    expect((await validateGraph(secondWorker, twoWorkerFiles)).workerCount).toBe(2)
  })

  it('resolves local HTML, CSS, and source-map references against the complete output inventory', () => {
    const root = tempRoot()
    const baseHtml = '<link href="assets/style.css">'
    const baseCss = '@font-face{src:url("./font.woff2")}'
    const baseJs = '//# sourceMappingURL=app.js.map'
    const basePairs = [
      { source: 'index.html', target: 'assets/style.css' },
      { source: 'assets/style.css', target: 'assets/font.woff2' },
      { source: 'assets/app.js', target: 'assets/app.js.map' }
    ]
    const inventory = [
      { path: 'index.html' },
      { path: '&' },
      { path: 'assets/style.css' },
      { path: 'assets/font.woff2' },
      { path: 'assets/app.js' },
      { path: 'assets/app.js.map' }
    ]
    const restoreBase = () => {
      put(join(root, 'index.html'), baseHtml)
      put(join(root, 'assets/style.css'), baseCss)
      put(join(root, 'assets/font.woff2'), Buffer.from([0, 1, 2]))
      put(join(root, 'assets/app.js'), baseJs)
      put(join(root, 'assets/app.js.map'), '{}')
      put(join(root, '&'), 'local ampersand path')
    }
    const expectThreeReferences = (htmlTarget = 'assets/style.css') => {
      const result = validateLocalAssetReferences(root, inventory)
      expect(result.scannedFileCount).toBe(3)
      expect(result.localReferenceCount).toBe(3)
      expect(result.references).toEqual([
        { source: 'index.html', target: htmlTarget },
        { source: 'assets/style.css', target: 'assets/font.woff2' },
        { source: 'assets/app.js', target: 'assets/app.js.map' }
      ])
      return result
    }

    restoreBase()
    expectThreeReferences()
    const slash = String.fromCharCode(92) + '/'
    const fraction = `.top-1${slash}2{top:50%}.left-1${slash}2{left:50%}`
    const bracket = `.border-${String.fromCharCode(92)}[var${String.fromCharCode(92)}(--cl-destructive${String.fromCharCode(92)})${String.fromCharCode(92)}]${slash}30{color:red}`
    const escapedLiteral = String.fromCharCode(92).repeat(2)
    const parity = `.literal-${escapedLiteral}name{color:red}.literal-${escapedLiteral}${slash}2{color:red}`
    for (const css of [baseCss + fraction + bracket + parity, '\ufeff' + baseCss + fraction]) {
      restoreBase()
      put(join(root, 'assets/style.css'), css)
      expectThreeReferences()
    }
    restoreBase()
    put(join(root, 'index.html'), baseHtml + `<style>${fraction}</style>`)
    expectThreeReferences()
    const whitespaceBackslash = String.fromCharCode(92)
    restoreBase()
    put(join(root, 'assets/style.css'), baseCss + '.broken' + whitespaceBackslash)
    reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED')
    for (const suffix of [' ', '\t', '\n', '\r\n', '\f']) {
      restoreBase()
      put(join(root, 'assets/style.css'), baseCss + `.broken${suffix}{color:red}`)
      expectThreeReferences()
      put(join(root, 'assets/style.css'), baseCss + `.broken${whitespaceBackslash}${suffix}{color:red}`)
      reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED')
    }
    for (const css of ['.broken' + String.fromCharCode(92) + '0 {color:red}', `.broken${slash}*closed*/{color:red}`]) {
      restoreBase()
      put(join(root, 'assets/style.css'), baseCss + css)
      reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED')
    }
    restoreBase()
    put(join(root, 'assets/style.css'), baseCss + fraction + 'a{background:url("https://unreviewed.invalid/x.png")}')
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    restoreBase()
    put(join(root, 'assets/style.css'), baseCss + fraction + 'a{background:u\\72l("https://unreviewed.invalid/x.png")}')
    reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED')
    restoreBase()
    put(join(root, 'index.html'), baseHtml + `<div style="color:red${slash}blue"></div>`)
    reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED')
    const compactDeclarations = [
      '--glass-fill:rgb(34 14 60/calc(.6 * var(--overlay-opacity-scale)))',
      '--glass-fill-strong:rgb(28 11 52/calc(.8 * var(--overlay-opacity-scale)))',
      '--glass-scrim-bar:rgb(13 4 28/calc(.68 * var(--overlay-opacity-scale)))',
      '--glass-fill-listening:rgb(20 8 40/calc(.82 * var(--overlay-opacity-scale)))',
      '--glass-fill-strong-listening:rgb(16 6 34/calc(.88 * var(--overlay-opacity-scale)))'
    ]
    for (const css of [
      'a{' + compactDeclarations.join(';') + '}',
      'a{--probe:calc(1px*var(--scale)/2)}',
      'a{--probe:calc(-.6e+2%/2 + 1.2E-3px);--name:éurl}',
      'a{--probe:1/*url("https://unreviewed.invalid/probe.woff2")*/}',
      'a{--probe:1/"url(https://unreviewed.invalid/probe.woff2)"}'
    ]) {
      restoreBase()
      put(join(root, 'assets/style.css'), baseCss + css)
      expectThreeReferences()
    }
    restoreBase()
    put(join(root, 'index.html'), baseHtml + '<div style="--probe:calc(1px*var(--scale)/2)"></div>')
    expectThreeReferences()
    for (const [css, code] of [
      ['a{--probe:1/url("https://unreviewed.invalid/probe.woff2")}', 'EXTERNAL_EXECUTABLE_REFERENCE'],
      ['a{--probe:1/u\\72l("https://unreviewed.invalid/probe.woff2")}', 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED'],
      ['a{--probe:1/image-set("https://unreviewed.invalid/probe.woff2")}', 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED'],
      ['a{--probe:1px(2)}', 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED'],
      ['a{--probe:1/éurl("https://unreviewed.invalid/probe.woff2")}', 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED']
    ]) {
      restoreBase()
      put(join(root, 'assets/style.css'), baseCss + css)
      reject(() => validateLocalAssetReferences(root, inventory), code)
    }
    restoreBase()
    reject(
      () =>
        validateLocalAssetReferences(
          root,
          inventory.filter((entry) => entry.path !== 'assets/font.woff2')
        ),
      'LOCAL_ASSET_TARGET_MISSING'
    )
    restoreBase()

    put(join(root, 'index.html'), '<script src="&"></script>')
    expectThreeReferences('&')
    restoreBase()
    put(join(root, 'index.html'), '<script src="&amp;"></script>')
    expectThreeReferences('&')
    restoreBase()
    put(join(root, 'index.html'), '<script src="%26"></script>')
    expectThreeReferences('&')
    restoreBase()

    const encodedEntityPath = '&amp;'
    put(join(root, encodedEntityPath), 'single decoded entity path')
    put(join(root, 'index.html'), '<script src="&amp;amp;"></script>')
    const entityInventory = [...inventory, { path: encodedEntityPath }]
    const entityResult = validateLocalAssetReferences(root, entityInventory)
    expect(entityResult.localReferenceCount).toBe(3)
    expect(entityResult.references[0]).toEqual({ source: 'index.html', target: encodedEntityPath })
    rmSync(join(root, encodedEntityPath), { force: true })
    restoreBase()

    const encodedPercentPath = '%26'
    put(join(root, encodedPercentPath), 'single decoded percent path')
    put(join(root, 'index.html'), '<script src="%2526"></script>')
    const percentResult = validateLocalAssetReferences(root, [...inventory, { path: encodedPercentPath }])
    expect(percentResult.localReferenceCount).toBe(3)
    expect(percentResult.references[0]).toEqual({ source: 'index.html', target: encodedPercentPath })
    rmSync(join(root, encodedPercentPath), { force: true })
    restoreBase()

    put(join(root, 'index.html'), '<script src="https://unreviewed.invalid/runtime.js"></script>')
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    put(join(root, 'index.html'), '<script src=https://unreviewed.invalid/runtime.js></script>')
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    put(join(root, 'index.html'), '<link rel="alternate stylesheet" href=https://unreviewed.invalid/style.css>')
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    put(join(root, 'index.html'), '<link rel="&#115;tylesheet" href="https://unreviewed.invalid/style.css">')
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    put(join(root, 'index.html'), '<link rel="preload" as="scr&#105;pt" href="https://unreviewed.invalid/runtime.js">')
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')

    const numericTargets = [
      '&#104;ttps://unreviewed.invalid/runtime.js',
      '&#x68;ttps://unreviewed.invalid/runtime.js',
      '&#104ttps://unreviewed.invalid/runtime.js',
      '&#x68ttps://unreviewed.invalid/runtime.js'
    ]
    for (const target of numericTargets) {
      put(join(root, 'index.html'), '<script src="' + target + '"></script><script src="&"></script>')
      reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
      put(join(root, 'index.html'), '<link rel="stylesheet" href="' + target + '"><script src="&"></script>')
      reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    }
    put(join(root, 'index.html'), '<script src="https&#x3a;//unreviewed.invalid/runtime.js"></script>')
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    put(join(root, 'index.html'), '<script src="https&colon;//unreviewed.invalid/runtime.js"></script>')
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    put(join(root, 'index.html'), '<script src="&colon;relative.js"></script>')
    reject(() => validateLocalAssetReferences(root, inventory), 'REFERENCE_URL_UNSUPPORTED')

    const rawTab = String.fromCharCode(9)
    const tabTarget = 'ht' + rawTab + 'tps://unreviewed.invalid/runtime.js'
    const tabInventoryPath = 'ht' + rawTab + 'tps:/unreviewed.invalid/runtime.js'
    put(join(root, 'index.html'), '<script src="' + tabTarget + '"></script>')
    if (process.platform !== 'win32') {
      put(join(root, tabInventoryPath), 'matching legacy local path')
      reject(
        () => validateLocalAssetReferences(root, [...inventory, { path: tabInventoryPath }]),
        'REFERENCE_URL_UNSUPPORTED'
      )
    } else {
      reject(() => validateLocalAssetReferences(root, inventory), 'REFERENCE_URL_UNSUPPORTED')
    }
    restoreBase()

    const backslash = String.fromCharCode(92)
    const backslashTarget = backslash.repeat(2) + 'unreviewed.invalid' + backslash + 'runtime.js'
    put(join(root, 'index.html'), '<script src="' + backslashTarget + '"></script>')
    if (process.platform !== 'win32') {
      put(join(root, backslashTarget), 'matching literal-backslash local path')
      reject(
        () => validateLocalAssetReferences(root, [...inventory, { path: backslashTarget }]),
        'REFERENCE_URL_UNSUPPORTED'
      )
    } else {
      reject(() => validateLocalAssetReferences(root, inventory), 'REFERENCE_URL_UNSUPPORTED')
    }
    restoreBase()

    const fullMetadata = inventory.map((entry) => {
      const bytes = readFileSync(join(root, entry.path))
      return { path: entry.path, bytes: bytes.length, sha256: sha(bytes) }
    })
    expect(validateLocalAssetReferences(root, fullMetadata).localReferenceCount).toBe(3)
    put(join(root, 'assets/style.css'), '@font-face{src:url("https://unreviewed.invalid/font.woff2")}')
    reject(() => validateLocalAssetReferences(root, fullMetadata), 'REFERENCE_SCAN_CHANGED')
    restoreBase()

    const externalImport = '@import/**/"https://unreviewed.invalid/x.css";' + baseCss
    put(join(root, 'index.html'), baseHtml)
    put(join(root, 'assets/style.css'), externalImport)
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    put(join(root, 'assets/style.css'), '@import"https://unreviewed.invalid/x.css";' + baseCss)
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    put(join(root, 'assets/style.css'), '@import "//unreviewed.invalid/runtime.css";' + baseCss)
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')

    put(join(root, 'assets/other.css'), '/* no references */')
    const importInventory = [...inventory, { path: 'assets/other.css' }]
    for (const importText of ['@import/**/"./other.css";', '@import"./other.css";']) {
      put(join(root, 'assets/style.css'), importText + baseCss)
      const result = validateLocalAssetReferences(root, importInventory)
      expect(result.localReferenceCount).toBe(4)
      expect(result.references).toEqual([
        { source: 'index.html', target: 'assets/style.css' },
        { source: 'assets/style.css', target: 'assets/other.css' },
        { source: 'assets/style.css', target: 'assets/font.woff2' },
        { source: 'assets/app.js', target: 'assets/app.js.map' }
      ])
    }
    rmSync(join(root, 'assets/other.css'), { force: true })
    restoreBase()

    put(join(root, 'assets/style.css'), '@im\\70ort "https://unreviewed.invalid/x.css";' + baseCss)
    reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED')
    put(join(root, 'assets/style.css'), 'a{background:u\\72l("https://unreviewed.invalid/x.png")}' + baseCss)
    reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED')
    put(join(root, 'assets/style.css'), 'a{background:URL("https://unreviewed.invalid/x.png")}' + baseCss)
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    put(join(root, 'assets/style.css'), 'a{background:image-set("https://unreviewed.invalid/x.png" 1x)}' + baseCss)
    reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED')
    put(
      join(root, 'assets/style.css'),
      '/* url(https://unreviewed.invalid/comment.png) */a::before{content:"url(https://unreviewed.invalid/text.png)"}' +
        baseCss
    )
    expectThreeReferences()
    put(join(root, 'assets/style.css'), 'a{background:url("https\\://unreviewed.invalid/x.png")}' + baseCss)
    reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED')
    put(join(root, 'assets/style.css'), 'a{background:url(/*comment*/https://unreviewed.invalid/x.png)}' + baseCss)
    reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED')
    put(join(root, 'assets/style.css'), '.foo\\:bar,.foo\\3a bar{color:red}' + baseCss)
    expectThreeReferences()

    put(join(root, 'index.html'), '<style>a{background:url("assets/font.woff2")}</style>' + baseHtml)
    const styleElementResult = validateLocalAssetReferences(root, inventory)
    expect(styleElementResult.localReferenceCount).toBe(4)
    expect(styleElementResult.references).toEqual(
      expect.arrayContaining([{ source: 'index.html', target: 'assets/font.woff2' }])
    )
    put(join(root, 'index.html'), '<style>a{background:url("https://unreviewed.invalid/x.png")}</style>')
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    put(join(root, 'index.html'), '<div style="background:url( assets/font.woff2 )"></div>' + baseHtml)
    const styleAttributeResult = validateLocalAssetReferences(root, inventory)
    expect(styleAttributeResult.localReferenceCount).toBe(4)
    expect(styleAttributeResult.references).toEqual(
      expect.arrayContaining([{ source: 'index.html', target: 'assets/font.woff2' }])
    )
    put(join(root, 'index.html'), '<div style="background:url(https://unreviewed.invalid/x.png)"></div>')
    reject(() => validateLocalAssetReferences(root, inventory), 'EXTERNAL_EXECUTABLE_REFERENCE')
    put(join(root, 'index.html'), '<div style="@media all{color:red}"></div>')
    reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED')
    restoreBase()

    put(join(root, 'index.html'), '<link rel="preload" as="image" href="https://images.example/cover.png">')
    const imageResult = validateLocalAssetReferences(root, inventory)
    expect(imageResult.localReferenceCount).toBe(2)
    expect(imageResult.references).toEqual(basePairs.slice(1))
    put(join(root, 'index.html'), '<link rel="PRELOAD" as="IMAGE" href="https://images.example/cover.png">')
    expect(validateLocalAssetReferences(root, inventory).references).toEqual(basePairs.slice(1))
    restoreBase()

    put(join(root, 'index.html'), '<div>'.repeat(128) + '</div>'.repeat(128))
    expect(validateLocalAssetReferences(root, inventory).localReferenceCount).toBe(2)
    put(join(root, 'index.html'), '<div>'.repeat(129) + '</div>'.repeat(129))
    reject(() => validateLocalAssetReferences(root, inventory), 'HTML_REFERENCE_DEPTH_LIMIT')
    restoreBase()

    put(join(root, 'assets/style.css'), '@media all{'.repeat(128) + '}'.repeat(128) + baseCss)
    expectThreeReferences()
    put(join(root, 'assets/style.css'), '@media all{'.repeat(129) + '}'.repeat(129) + baseCss)
    reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_DEPTH_LIMIT')
    restoreBase()

    const sixtyFourDataAttributes = Array.from({ length: 64 }, (_, index) => 'data-a' + index + '="x"').join(' ')
    const sixtyFiveDataAttributes = Array.from({ length: 65 }, (_, index) => 'data-a' + index + '="x"').join(' ')
    put(join(root, 'index.html'), '<div ' + sixtyFourDataAttributes + '></div>')
    expect(validateLocalAssetReferences(root, inventory).localReferenceCount).toBe(2)
    put(join(root, 'index.html'), '<div ' + sixtyFiveDataAttributes + '></div>')
    reject(() => validateLocalAssetReferences(root, inventory), 'HTML_REFERENCE_ATTRIBUTE_LIMIT')
    put(join(root, 'index.html'), '<script src="&" src="&"></script>')
    reject(() => validateLocalAssetReferences(root, inventory), 'HTML_REFERENCE_GRAMMAR_UNSUPPORTED')
    put(join(root, 'index.html'), '<base href="https://unreviewed.invalid/">')
    reject(() => validateLocalAssetReferences(root, inventory), 'HTML_REFERENCE_GRAMMAR_UNSUPPORTED')
    put(join(root, 'index.html'), '<iframe srcdoc=""></iframe>')
    reject(() => validateLocalAssetReferences(root, inventory), 'HTML_REFERENCE_GRAMMAR_UNSUPPORTED')
    restoreBase()

    put(join(root, 'assets/style.css'), 'a[data-x="line' + String.fromCharCode(10) + 'break"]{color:red}' + baseCss)
    reject(() => validateLocalAssetReferences(root, inventory), 'CSS_REFERENCE_GRAMMAR_UNSUPPORTED')
    restoreBase()

    const oversizedPath = 'oversized.js'
    const oversizedFd = openSync(join(root, oversizedPath), 'w')
    try {
      ftruncateSync(oversizedFd, 32 * 1024 * 1024 + 1)
    } finally {
      closeSync(oversizedFd)
    }
    const readFileSpy = vi.spyOn(fs, 'readFileSync')
    const readSyncSpy = vi.spyOn(fs, 'readSync')
    syncBuiltinESMExports()
    let observedReadFileCalls = -1
    let observedReadSyncCalls = -1
    try {
      let error: unknown
      try {
        validateLocalAssetReferences(root, [{ path: oversizedPath }, ...inventory])
      } catch (caught) {
        error = caught
      }
      expect(String(error)).toContain('REFERENCE_SCAN_SIZE')
    } finally {
      observedReadFileCalls = readFileSpy.mock.calls.length
      observedReadSyncCalls = readSyncSpy.mock.calls.length
      readFileSpy.mockRestore()
      readSyncSpy.mockRestore()
      syncBuiltinESMExports()
    }
    expect(observedReadFileCalls).toBe(0)
    expect(observedReadSyncCalls).toBe(0)
  })

  it('accepts measured full and lean build profiles only with a real Markdown graph and byte-identical outputs', async () => {
    const root = tempRoot()
    const tarball = process.env.RENDERER_KATEX_TARBALL
    if (!tarball) throw new Error('RENDERER_KATEX_TARBALL is required for the hosted archive-byte control')
    cpSync(resolve(process.cwd(), 'node_modules/katex'), join(root, 'node_modules/katex'), { recursive: true })
    put(join(root, 'node_modules/mermaid/package.json'), JSON.stringify({ version: '11.17.0' }))
    put(join(root, 'node_modules/mermaid/dist/mermaid.core.mjs'), 'export const core = true')
    put(join(root, 'node_modules/mermaid/dist/chunks/mermaid.esm/katex-HNBAO5SE.mjs'), 'version = "0.16.47"')
    const out = join(root, 'out/renderer')
    const outputBytes: Record<string, string | Buffer> = {
      'index.js': 'index.js',
      'decoder.js': 'decoder.js',
      'lazy.js': 'lazy.js',
      'assets/whisper.worker-abc.js': 'assets/whisper.worker-abc.js',
      'index.html': '<html>',
      'decoder.html': '<html>',
      'act1-boot.js': 'public act1',
      'onboarding-boot-gate.js': 'public gate',
      'onboarding-hero-poster.jpg': Buffer.from([1, 2, 3])
    }
    for (const [path, bytes] of Object.entries(outputBytes)) put(join(out, path), bytes)
    for (const name of ['act1-boot.js', 'onboarding-boot-gate.js', 'onboarding-hero-poster.jpg'])
      put(join(root, 'src/renderer/public', name), outputBytes[name])
    const files = Object.entries(outputBytes).map(([path, bytes]) => ({
      path,
      bytes: Buffer.byteLength(bytes),
      sha256: sha(bytes)
    }))
    const graph = validGraph()
    graph.assets = ['index.html', 'decoder.html'].map((path) => ({
      fileName: path,
      bytes: Buffer.byteLength(outputBytes[path]),
      sha256: sha(outputBytes[path]),
      generatorModules: [`/repo/src/renderer/${path}`],
      generatorChunks: [path === 'index.html' ? 'index.js' : 'decoder.js']
    }))
    graph.publicFiles = ['act1-boot.js', 'onboarding-boot-gate.js', 'onboarding-hero-poster.jpg']
      .map((path) => ({
        path,
        source: `src/renderer/public/${path}`,
        bytes: Buffer.byteLength(outputBytes[path]),
        sha256: sha(outputBytes[path])
      }))
      .sort((a, b) => a.source.localeCompare(b.source))
    const configPaths = [
      'electron.vite.config.ts',
      'package.json',
      'package-lock.json',
      'electron-builder.yml',
      'electron-builder.win.yml',
      'scripts/before-pack.mjs',
      'scripts/design/renderer-inputs.ts'
    ]
    for (const path of configPaths) put(join(root, path), `fixture ${path}`)
    graph.config = {
      command: 'build',
      mode: 'production',
      configFiles: [],
      outerConfig: {
        path: 'electron.vite.config.ts',
        files: ['electron.vite.config.ts', 'scripts/design/renderer-inputs.ts'].map((path) => ({
          path,
          sha256: sha(`fixture ${path}`)
        }))
      }
    }
    process.env.GITHUB_SHA = 'a'.repeat(40)
    process.env.GITHUB_RUN_ID = '44'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    process.env.GITHUB_JOB = 'renderer'
    process.env.RUNNER_OS = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'
    process.env.RENDERER_PACKAGE_TARGET = 'win-x64'
    process.env.ASKTOTO_MAC_UNIVERSAL = '0'
    const configurationHashes = Object.fromEntries(configPaths.map((path) => [path, sha(`fixture ${path}`)]))
    graph.buildRun = {
      schema: 1,
      sourceCommit: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      job: process.env.GITHUB_JOB,
      runnerOs: process.env.RUNNER_OS,
      runnerPlatform: process.platform,
      runnerArch: process.arch,
      profile: 'full',
      packageTarget: 'win-x64',
      macUniversal: '0',
      ordinaryBuildExitCode: 0,
      observedBuildExitCode: 0,
      configurationHashes
    }
    for (const profile of ['full', 'lean']) {
      process.env.METIS_PACKAGE_PROFILE = profile
      graph.buildRun.profile = profile
      const evidence = await validateBuildEvidence({
        ordinary: files,
        observed: files,
        graph: structuredClone(graph),
        root,
        katexTarball: tarball
      })
      expect(evidence.profile).toBe(profile)
      expect(evidence.mermaidResidue.knownEmbeddedOldKaTeX).toHaveLength(1)
      expect(evidence.mermaidResidue.buildResidueMatches).toEqual([])
    }
    process.env.METIS_PACKAGE_PROFILE = 'full'
    const missingOuterDependency = structuredClone(graph)
    missingOuterDependency.buildRun.profile = 'full'
    missingOuterDependency.config.outerConfig!.files = []
    await expect(
      validateBuildEvidence({
        ordinary: files,
        observed: files,
        graph: missingOuterDependency,
        root,
        katexTarball: tarball
      })
    ).rejects.toThrow('BUILD_RUN_IDENTITY_OR_CONFIG')
    delete process.env.METIS_PACKAGE_PROFILE
  })

  it('rejects a renamed old KaTeX bundle and old-source map content by bytes and signature', () => {
    expect(
      findEmbeddedOldKaTeX('node_modules/mermaid/dist/chunks/renamed.mjs', Buffer.from('version = "0.16.47"'))
    ).toBe(true)
    expect(
      findEmbeddedOldKaTeX(
        'node_modules/mermaid/dist/chunks/renamed.mjs.map',
        Buffer.from(JSON.stringify({ version: 3, sources: ['old.ts'], sourcesContent: ['version = "0.16.47"'] }))
      )
    ).toBe(true)
    expect(
      findEmbeddedOldKaTeX('node_modules/mermaid/package.json', Buffer.from('{"name":"mermaid","version":"11.17.0"}'))
    ).toBe(false)
    expect(
      findEmbeddedOldKaTeX(
        'renamed.js',
        Buffer.from(
          `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: ['old.ts'], sourcesContent: ['version = "0.16.47"'] })).toString('base64')}`
        )
      )
    ).toBe(true)
  })

  it('accepts the exact 30-title GREEN roster and rejects wrong counts, title grafts, pending work, and retries', () => {
    const root = tempRoot()
    let evidence = greenPaths(root)
    expect(checkGreenReport(evidence.reportPath, 0, evidence.logPath, evidence.attemptPath).cases).toBe(30)
    const report = validGreenReport()
    report.numTotalTests = 29
    evidence = greenPaths(root, report)
    reject(
      () => checkGreenReport(evidence.reportPath, 0, evidence.logPath, evidence.attemptPath),
      'GREEN_SUMMARY_OR_EXIT'
    )
    const oneFailure = validGreenReport()
    oneFailure.numFailedTests = 1
    evidence = greenPaths(root, oneFailure)
    reject(
      () => checkGreenReport(evidence.reportPath, 0, evidence.logPath, evidence.attemptPath),
      'GREEN_SUMMARY_OR_EXIT'
    )
    const duplicate = validGreenReport()
    duplicate.testResults[0].assertionResults[0].title = duplicate.testResults[0].assertionResults[1].title
    duplicate.testResults[0].assertionResults[0].fullName = `${duplicate.testResults[0].assertionResults[0].ancestorTitles[0]} ${duplicate.testResults[0].assertionResults[0].title}`
    evidence = greenPaths(root, duplicate)
    reject(
      () => checkGreenReport(evidence.reportPath, 0, evidence.logPath, evidence.attemptPath),
      'GREEN_CASE_INVENTORY'
    )
    const pending = validGreenReport()
    pending.testResults[0].assertionResults[0].status = 'pending'
    evidence = greenPaths(root, pending)
    reject(
      () => checkGreenReport(evidence.reportPath, 0, evidence.logPath, evidence.attemptPath),
      'GREEN_ASSERTION_STATE'
    )
    const retry = validAttemptReport(GREEN_CASES)
    retry.testCases[0].retryCount = 1
    evidence = greenPaths(root, validGreenReport(), retry)
    reject(
      () => checkGreenReport(evidence.reportPath, 0, evidence.logPath, evidence.attemptPath),
      'ATTEMPT_RETRY_REPEAT_OR_TEST_STATE'
    )
    evidence = greenPaths(root)
    reject(
      () => checkGreenReport(evidence.reportPath, 1, evidence.logPath, evidence.attemptPath),
      'GREEN_SUMMARY_OR_EXIT'
    )
    put(evidence.logPath, 'Test Files  5 passed (5)\nFAIL  src/later.test.ts\n')
    reject(() => checkGreenReport(evidence.reportPath, 0, evidence.logPath, evidence.attemptPath), 'GREEN_LOG_FAILURE')
  })

  it('rejects a wrong file/title identity and a file-level hook error even when summary counts claim 30/30', () => {
    const root = tempRoot()
    const wrongTitle = validGreenReport()
    wrongTitle.testResults[0].assertionResults[0].title = 'M1 replacement title'
    wrongTitle.testResults[0].assertionResults[0].fullName = `${wrongTitle.testResults[0].assertionResults[0].ancestorTitles[0]} ${wrongTitle.testResults[0].assertionResults[0].title}`
    let evidence = greenPaths(root, wrongTitle)
    reject(
      () => checkGreenReport(evidence.reportPath, 0, evidence.logPath, evidence.attemptPath),
      'GREEN_CASE_INVENTORY'
    )
    const wrongFile = validGreenReport()
    wrongFile.testResults[0].name = join(process.cwd(), 'src/renderer/wrong.test.ts')
    evidence = greenPaths(root, wrongFile)
    reject(
      () => checkGreenReport(evidence.reportPath, 0, evidence.logPath, evidence.attemptPath),
      'GREEN_FILE_INVENTORY'
    )
    const hookError = validGreenReport()
    hookError.testResults[0].message = 'setup failed'
    evidence = greenPaths(root, hookError)
    reject(() => checkGreenReport(evidence.reportPath, 0, evidence.logPath, evidence.attemptPath), 'GREEN_FILE_FAILED')
  })

  it('requires current-attempt unhandled-error identity and rejects missing or duplicate browser origins', () => {
    const root = tempRoot()
    const runErrors = join(root, 'run-errors.json')
    process.env.GITHUB_RUN_ID = '41'
    process.env.GITHUB_RUN_ATTEMPT = '2'
    process.env.GITHUB_JOB = 'browser'
    process.env.RUNNER_OS = 'Linux'
    process.env.GITHUB_SHA = 'a'.repeat(40)
    process.env.REPORT_DIR = root
    const attemptProduced = join(root, 'actual-reporter.json')
    process.env.RENDERER_ATTEMPT_REPORT = attemptProduced
    const producer = new RendererAttemptReporter()
    const moduleId = resolve(process.cwd(), 'scripts/ci/renderer-katex-evidence.test.ts')
    producer.onTestCaseResult({
      module: { moduleId },
      name: 'actual producer API',
      parent: { type: 'suite', name: 'fixture suite', parent: { type: 'module' } },
      diagnostic: () => ({ retryCount: 0, repeatCount: 0, flaky: false }),
      result: () => ({ state: 'passed' }),
      options: { retry: 0, repeats: 0 }
    })
    producer.onTestRunEnd([{ moduleId, state: () => 'passed', errors: () => [], diagnostic: () => ({}) }], [], 'passed')
    const produced = JSON.parse(readFileSync(attemptProduced, 'utf8'))
    expect(produced.testCases).toEqual([expect.objectContaining({ state: 'passed', retryCount: 0, repeatCount: 0 })])
    expect(produced.moduleResults).toEqual([expect.objectContaining({ state: 'passed', errors: 0 })])
    put(
      runErrors,
      JSON.stringify({
        schema: 1,
        runId: '41',
        runAttempt: '2',
        job: 'browser',
        runnerOs: 'Linux',
        fileCount: 5,
        errorCount: 0,
        errors: [],
        omittedErrors: 0
      })
    )
    expect(checkRunErrors(runErrors, runErrors).errorCount).toBe(0)
    put(
      runErrors,
      JSON.stringify({
        schema: 1,
        runId: '40',
        runAttempt: '2',
        job: 'browser',
        runnerOs: 'Linux',
        fileCount: 5,
        errorCount: 0,
        errors: [],
        omittedErrors: 0
      })
    )
    reject(() => checkRunErrors(runErrors, runErrors), 'UNHANDLED_ERRORS_PRESENT_OR_RUN_MISMATCH')
    put(
      runErrors,
      JSON.stringify({
        schema: 1,
        runId: '41',
        runAttempt: '1',
        job: 'browser',
        runnerOs: 'Linux',
        fileCount: 5,
        errorCount: 0,
        errors: [],
        omittedErrors: 0
      })
    )
    reject(() => checkRunErrors(runErrors, runErrors), 'UNHANDLED_ERRORS_PRESENT_OR_RUN_MISMATCH')
    const evidenceReport = join(root, 'evidence-tests.json')
    const evidenceLog = join(root, 'evidence-tests.log')
    const evidenceErrors = join(root, 'evidence-run-errors.json')
    const evidenceAttempt = join(root, 'evidence-attempt.json')
    const suiteName = 'renderer remediation evidence validators'
    const evidenceCases = EVIDENCE_CASES.map(
      (title) => ['scripts/ci/renderer-katex-evidence.test.ts', suiteName, title] as const
    )
    put(evidenceLog, 'Tests  14 passed (14)\n')
    put(
      evidenceErrors,
      JSON.stringify({
        schema: 1,
        runId: '41',
        runAttempt: '2',
        job: 'browser',
        runnerOs: 'Linux',
        fileCount: 1,
        errorCount: 0,
        errors: [],
        omittedErrors: 0
      })
    )
    put(evidenceAttempt, JSON.stringify(validAttemptReport(evidenceCases)))
    put(
      evidenceReport,
      JSON.stringify({
        success: true,
        numTotalTests: 14,
        numPassedTests: 14,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        numTotalTestSuites: 2,
        numPassedTestSuites: 2,
        numFailedTestSuites: 0,
        numPendingTestSuites: 0,
        testResults: [
          {
            name: join(process.cwd(), 'scripts/ci/renderer-katex-evidence.test.ts'),
            status: 'passed',
            message: '',
            assertionResults: EVIDENCE_CASES.map((title) => ({
              title,
              fullName: `${suiteName} ${title}`,
              ancestorTitles: [suiteName],
              status: 'passed',
              failureMessages: []
            }))
          }
        ]
      })
    )
    expect(
      checkEvidenceSuite(evidenceReport, evidenceLog, 0, evidenceErrors, evidenceErrors, evidenceAttempt)
    ).toMatchObject({ caseCount: 14 })
    put(evidenceLog, 'Tests  14 passed (14)\nFAIL  src/later.test.ts\n')
    reject(
      () => checkEvidenceSuite(evidenceReport, evidenceLog, 0, evidenceErrors, evidenceErrors, evidenceAttempt),
      'EVIDENCE_SUITE_LOG_FAILURE'
    )
    const origins = join(root, 'origins')
    mkdirSync(origins)
    reject(() => checkHarnessOrigins(origins, '0.18.2'), 'HARNESS_ORIGIN_COUNT')
    for (const name of [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444'
    ])
      put(join(origins, `harness-origin-${name}.json`), '{}')
    reject(() => checkHarnessOrigins(origins, '0.18.2'), 'HARNESS_ORIGIN_COUNT')
  })

  it('requires zero-exit full audit and a complete npm 10.9.8 CycloneDX lock graph', () => {
    const root = tempRoot()
    const sourceRoot = join(root, 'AskToto-Mantu')
    const audit = join(root, 'audit.json')
    const allZero = {
      auditReportVersion: 2,
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
        dependencies: { prod: 1, dev: 2, optional: 0, peer: 0, total: 3 }
      },
      vulnerabilities: {}
    }
    put(audit, JSON.stringify(allZero))
    expect(checkAudit(audit, 0)).toMatchObject({ metadata: { total: 0 } })
    reject(() => checkAudit(audit, 1), 'AUDIT_COMMAND_EXIT')
    put(
      audit,
      JSON.stringify({ ...allZero, metadata: { vulnerabilities: { ...allZero.metadata.vulnerabilities, low: 1 } } })
    )
    reject(() => checkAudit(audit, 0), 'AUDIT_NOT_ZERO')
    put(audit, JSON.stringify({ ...allZero, error: { code: 'EAUDITNOLOCK' } }))
    reject(() => checkAudit(audit, 0), 'AUDIT_NOT_ZERO')
    put(audit, JSON.stringify(allZero))
    process.env.GITHUB_SHA = 'a'.repeat(40)
    process.env.GITHUB_RUN_ID = '51'
    process.env.GITHUB_RUN_ATTEMPT = '2'
    process.env.GITHUB_JOB = 'renderer-audit'
    const producerPath = join(root, 'audit-producer.json')
    const producer = {
      schema: 1,
      producer: 'npm',
      version: '10.9.8',
      kind: 'audit',
      argv: ['audit', '--include=dev', '--include=optional', '--include=peer', '--json'],
      sourceCommit: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      job: process.env.GITHUB_JOB,
      startedAt: '2026-10-15T05:00:00Z',
      finishedAt: '2026-10-15T05:00:01Z',
      effectiveOmit: '',
      exitCode: 0,
      outputSha256: sha(readFileSync(audit))
    }
    put(producerPath, JSON.stringify(producer))
    expect(checkNpmProducer(producerPath, audit, 'audit', 0).producer).toBe('npm')
    put(producerPath, JSON.stringify({ ...producer, effectiveOmit: 'dev' }))
    reject(() => checkNpmProducer(producerPath, audit, 'audit', 0), 'NPM_AUDIT_PRODUCER_MISMATCH')
    const lock = {
      packages: {
        '': {
          name: 'asktoto',
          version: '1.9.7',
          devDependencies: { streamdown: '^2.5.0', khroma: '^2.1.0' },
          optionalDependencies: { mermaid: '11.17.0' }
        },
        'node_modules/khroma': {
          version: '2.1.0',
          resolved: 'https://registry.npmjs.org/khroma/-/khroma-2.1.0.tgz',
          integrity: 'sha512-Ls993zuzfayK269Svk9hzpeGUKob/sIgZzyHYdjQoAdQetRKpOLj+k/QQQ/6Qi0Yz65mlROrfd+Ev+1+7dz9Kw=='
        },
        'node_modules/katex': {
          version: '0.18.2',
          resolved: 'https://registry.npmjs.org/katex/-/katex-0.18.2.tgz',
          integrity: 'sha512-3snve4y0SXTMequLim1FMiPvLGElySam0blN5xQZBqEY3lOJz1TnuaaiugnBZBqHzlSAGmFTYL7MCQkORuLKCA==',
          license: 'MIT'
        },
        'node_modules/mermaid': {
          version: '11.17.0',
          dependencies: { katex: '^0.16.0' },
          integrity: 'sha512-Jo9N377Wb4MSnHFPTbLi2SxFpsQl4eVHoxnW5U1Md9EazvgMp3s+4ohDxr81YNTgbn5Kj7HJ3yslrSJ52kwpbA==',
          resolved: 'https://registry.npmjs.org/mermaid/-/mermaid-11.17.0.tgz',
          license: 'MIT'
        },
        'node_modules/streamdown': {
          version: '2.5.0',
          dependencies: { mermaid: '^11.17.0' },
          integrity: 'sha512-/tTnURfIOxZK/pqJAxsfCvETG/XCJHoWnk3jq9xLcuz6CSpnjjuxSRBTTL4PKGhxiZQf0lqPxGhImdpwcZ2XwA==',
          resolved: 'https://registry.npmjs.org/streamdown/-/streamdown-2.5.0.tgz',
          license: 'Apache-2.0'
        }
      }
    }
    const sbomPath = join(root, 'sbom.json')
    const ref = (name: string, version: string) => `${name}@${version}`
    const lockNodes = [
      ['khroma', '2.1.0', 'node_modules/khroma'],
      ['katex', '0.18.2', 'node_modules/katex'],
      ['mermaid', '11.17.0', 'node_modules/mermaid'],
      ['streamdown', '2.5.0', 'node_modules/streamdown']
    ] as const
    const sbom = {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      metadata: {
        tools: [{ vendor: 'npm', name: 'cli', version: '10.9.8' }],
        component: {
          type: 'application',
          name: 'AskToto-Mantu',
          version: '1.9.7',
          'bom-ref': 'asktoto@1.9.7',
          purl: 'pkg:npm/asktoto@1.9.7',
          properties: [{ name: 'cdx:npm:package:path', value: '' }]
        }
      },
      components: lockNodes.map(([name, version, path]) => {
        const node = lock.packages[path]
        return {
          type: 'library',
          name,
          version,
          'bom-ref': ref(name, version),
          properties: [{ name: 'cdx:npm:package:path', value: path }],
          hashes: [{ alg: 'SHA-512', content: Buffer.from(node.integrity!.split('-')[1], 'base64').toString('hex') }],
          externalReferences: [{ type: 'distribution', url: node.resolved }],
          ...('license' in node && node.license ? { licenses: [{ license: { id: node.license } }] } : {})
        }
      }),
      dependencies: [
        {
          ref: 'asktoto@1.9.7',
          dependsOn: [ref('streamdown', '2.5.0'), ref('khroma', '2.1.0'), ref('mermaid', '11.17.0')]
        },
        { ref: ref('khroma', '2.1.0'), dependsOn: [] },
        { ref: ref('katex', '0.18.2'), dependsOn: [] },
        { ref: ref('mermaid', '11.17.0'), dependsOn: [ref('katex', '0.18.2')] },
        { ref: ref('streamdown', '2.5.0'), dependsOn: [ref('mermaid', '11.17.0')] }
      ]
    }
    put(sbomPath, JSON.stringify(sbom))
    expect(checkSbom(sbomPath, lock, 0, sourceRoot).componentCount).toBe(4)
    expect(checkSbom(sbomPath, lock, 0, sourceRoot).supplementalLicenseAddendum).toEqual(
      expect.objectContaining({
        lockPath: 'node_modules/khroma',
        materialSha256: '66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49'
      })
    )
    const missingRootOptionalEdge = structuredClone(sbom)
    missingRootOptionalEdge.dependencies[0].dependsOn = missingRootOptionalEdge.dependencies[0].dependsOn.filter(
      (edge) => edge !== ref('mermaid', '11.17.0')
    )
    put(sbomPath, JSON.stringify(missingRootOptionalEdge))
    reject(() => checkSbom(sbomPath, lock, 0, sourceRoot), 'SBOM_DEPENDENCY_EDGE_MISMATCH:asktoto@1.9.7')
    put(sbomPath, JSON.stringify(sbom))
    const wrongDisplayName = structuredClone(sbom)
    wrongDisplayName.metadata.component.name = 'asktoto'
    put(sbomPath, JSON.stringify(wrongDisplayName))
    reject(() => checkSbom(sbomPath, lock, 0, sourceRoot), 'SBOM_ROOT_IDENTITY')
    const wrongVersion = structuredClone(sbom)
    wrongVersion.metadata.component.version = '1.9.6'
    put(sbomPath, JSON.stringify(wrongVersion))
    reject(() => checkSbom(sbomPath, lock, 0, sourceRoot), 'SBOM_ROOT_IDENTITY')
    const wrongBomRef = structuredClone(sbom)
    wrongBomRef.metadata.component['bom-ref'] = 'AskToto-Mantu@1.9.7'
    put(sbomPath, JSON.stringify(wrongBomRef))
    reject(() => checkSbom(sbomPath, lock, 0, sourceRoot), 'SBOM_ROOT_IDENTITY')
    const wrongPurl = structuredClone(sbom)
    wrongPurl.metadata.component.purl = 'pkg:npm/AskToto-Mantu@1.9.7'
    put(sbomPath, JSON.stringify(wrongPurl))
    reject(() => checkSbom(sbomPath, lock, 0, sourceRoot), 'SBOM_ROOT_IDENTITY')
    const missingPurl = structuredClone(sbom)
    delete (missingPurl.metadata.component as { purl?: string }).purl
    put(sbomPath, JSON.stringify(missingPurl))
    reject(() => checkSbom(sbomPath, lock, 0, sourceRoot), 'SBOM_ROOT_IDENTITY')
    const missingRootPath = structuredClone(sbom)
    missingRootPath.metadata.component.properties = []
    put(sbomPath, JSON.stringify(missingRootPath))
    reject(() => checkSbom(sbomPath, lock, 0, sourceRoot), 'SBOM_ROOT_IDENTITY')
    const nonemptyRootPath = structuredClone(sbom)
    nonemptyRootPath.metadata.component.properties[0].value = './'
    put(sbomPath, JSON.stringify(nonemptyRootPath))
    reject(() => checkSbom(sbomPath, lock, 0, sourceRoot), 'SBOM_ROOT_IDENTITY')
    const duplicateRootPath = structuredClone(sbom)
    duplicateRootPath.metadata.component.properties.push({ name: 'cdx:npm:package:path', value: '' })
    put(sbomPath, JSON.stringify(duplicateRootPath))
    reject(() => checkSbom(sbomPath, lock, 0, sourceRoot), 'SBOM_ROOT_IDENTITY')
    const scopedSbom = structuredClone(sbom)
    scopedSbom.metadata.component.name = '@scope/checkout'
    put(sbomPath, JSON.stringify(scopedSbom))
    expect(checkSbom(sbomPath, lock, 0, join(root, '@scope', 'checkout')).componentCount).toBe(4)
    put(sbomPath, JSON.stringify(sbom))
    const duplicateLock = structuredClone(lock) as { packages: Record<string, unknown> }
    duplicateLock.packages['node_modules/mermaid/node_modules/katex'] = structuredClone(
      lock.packages['node_modules/katex']
    )
    const duplicateSbom = structuredClone(sbom)
    const nestedKatex = structuredClone(duplicateSbom.components.find((entry) => entry.name === 'katex')!)
    ;(nestedKatex.properties[0] as { value: string }).value = 'node_modules/mermaid/node_modules/katex'
    duplicateSbom.components.push(nestedKatex)
    duplicateSbom.dependencies.push({ ref: ref('katex', '0.18.2'), dependsOn: [] })
    put(sbomPath, JSON.stringify(duplicateSbom))
    expect(checkSbom(sbomPath, duplicateLock, 0, sourceRoot).componentCount).toBe(5)
    put(sbomPath, JSON.stringify(sbom))
    const missingEdge = structuredClone(sbom)
    missingEdge.dependencies[3].dependsOn = []
    put(sbomPath, JSON.stringify(missingEdge))
    reject(() => checkSbom(sbomPath, lock, 0, sourceRoot), 'SBOM_DEPENDENCY_EDGE_MISMATCH')
    sbom.components = sbom.components.filter((entry) => entry.name !== 'mermaid')
    put(sbomPath, JSON.stringify(sbom))
    reject(() => checkSbom(sbomPath, lock, 0, sourceRoot), 'SBOM_COMPONENT_COVERAGE')
  })

  it('binds the exact KaTeX lock fix while rejecting an alternate KaTeX identity, duplicate copy, or unrelated lock churn', () => {
    const old = {
      version: '0.16.47',
      resolved: 'https://registry.npmjs.org/katex/-/katex-0.16.47.tgz',
      integrity: 'sha512-Eeo8Ys1doU1z+x8AZsPpQu+p/QcZBI5PeOo7QGQdy2x2m0MU/hYagBbGOmXwr5KVbEfVuWv9LpnQWeehogurjg=='
    }
    const patched = {
      version: '0.18.2',
      resolved: 'https://registry.npmjs.org/katex/-/katex-0.18.2.tgz',
      integrity: 'sha512-3snve4y0SXTMequLim1FMiPvLGElySam0blN5xQZBqEY3lOJz1TnuaaiugnBZBqHzlSAGmFTYL7MCQkORuLKCA=='
    }
    const realLock = JSON.parse(readFileSync(resolve(process.cwd(), 'package-lock.json'), 'utf8'))
    const realManifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
    const fallbackBase = '3544b519eaff8336b3b1bee25c742d5c7392d476'
    const beforeManifestBytes = execFileSync('git', ['show', `${fallbackBase}:package.json`])
    const beforeLockBytes = execFileSync('git', ['show', `${fallbackBase}:package-lock.json`])
    expect(sha(beforeManifestBytes)).toBe('587bae986ba457a255a7e52943586401327e3c5c6c9ae1a32f6d120a3bdf280e')
    expect(sha(beforeLockBytes)).toBe('a381ca5f8cce8042c5fca6a8aaf256e97c5a9c5540a0bb9abd149b10b7d07ced')
    const beforeManifest = JSON.parse(beforeManifestBytes.toString('utf8'))
    const beforeLock = JSON.parse(beforeLockBytes.toString('utf8'))
    const amendment = validateRetainedSharpFallbackAmendment(beforeManifest, beforeLock, realManifest, realLock)
    expect(amendment).toEqual({
      manifestChangedField: 'optionalDependencies',
      lockChangedField: 'packages[""].optionalDependencies',
      optionalDependencies: { '@img/sharp-wasm32': '0.35.5' },
      preservedPackageNodeCount: 1039,
      preservedNonRootPackageNodeCount: 1038
    })
    const amendmentMutations: Array<(manifest: any, lock: any) => void> = [
      (manifest) => {
        delete manifest.optionalDependencies
      },
      (_manifest, lock) => {
        delete lock.packages[''].optionalDependencies
      },
      (manifest) => {
        manifest.optionalDependencies['@img/sharp-wasm32'] = '^0.35.5'
      },
      (_manifest, lock) => {
        lock.packages[''].optionalDependencies['@img/sharp-wasm32'] = '0.35.4'
      },
      (manifest) => {
        manifest.optionalDependencies.extra = '1.0.0'
      },
      (_manifest, lock) => {
        lock.packages[''].optionalDependencies.extra = '1.0.0'
      },
      (manifest) => {
        manifest.dependencies.undici = '0.0.0'
      },
      (manifest) => {
        manifest.scripts.postinstall += ' && echo changed'
      },
      (manifest) => {
        manifest.overrides['mermaid@11.17.0'].katex = '0.18.3'
      },
      (_manifest, lock) => {
        lock.packages['node_modules/@img/sharp-wasm32'].version = '0.35.4'
      },
      (_manifest, lock) => {
        lock.packages['node_modules/@img/sharp-wasm32'].integrity = 'sha512-wrong'
      },
      (_manifest, lock) => {
        lock.packages['node_modules/@img/sharp-wasm32'].optional = false
      },
      (_manifest, lock) => {
        delete lock.packages['node_modules/@emnapi/runtime']
      },
      (_manifest, lock) => {
        lock.packages['node_modules/extra'] = { version: '1.0.0' }
      },
      (_manifest, lock) => {
        lock.lockfileVersion = 2
      }
    ]
    for (const mutate of amendmentMutations) {
      const changedManifest = structuredClone(realManifest)
      const changedLock = structuredClone(realLock)
      mutate(changedManifest, changedLock)
      reject(
        () => validateRetainedSharpFallbackAmendment(beforeManifest, beforeLock, changedManifest, changedLock),
        'GREEN_FALLBACK_AMENDMENT_EXACT'
      )
    }
    reject(
      () => validateRetainedSharpFallbackAmendment(realManifest, beforeLock, realManifest, realLock),
      'GREEN_FALLBACK_AMENDMENT_BASE'
    )
    const changedBeforeLock = structuredClone(beforeLock)
    changedBeforeLock.packages['node_modules/@emnapi/runtime'].integrity = 'sha512-wrong'
    reject(
      () => validateRetainedSharpFallbackAmendment(beforeManifest, changedBeforeLock, realManifest, realLock),
      'GREEN_FALLBACK_BASE_CHAIN'
    )
    const current = {
      packages: Object.fromEntries(
        [
          '',
          'node_modules/katex',
          'node_modules/mermaid',
          'node_modules/streamdown',
          'node_modules/katex/node_modules/commander'
        ].map((path) => [path, beforeLock.packages[path]])
      )
    }
    const base = { packages: { ...current.packages, 'node_modules/katex': old } }
    expect(validateLockDelta(base, current).changedPackageKeys).toEqual(['node_modules/katex'])
    const manifest = { overrides: { 'mermaid@11.17.0': { katex: '0.18.2' } }, dependencies: {}, devDependencies: {} }
    expect(validateRemediationPackageRecords(manifest, current, '0.18.2').installedVersion).toBe('0.18.2')
    reject(
      () =>
        validateLockDelta(base, { packages: { ...current.packages, 'node_modules/commander': { version: '9.0.0' } } }),
      'GREEN_LOCK_NODE_SET_CHANGED'
    )
    reject(
      () =>
        validateLockDelta(base, { packages: { ...current.packages, 'node_modules/mermaid': { version: '11.17.1' } } }),
      'GREEN_UNRELATED_LOCK_CHANGE'
    )
    reject(
      () =>
        validateRemediationPackageRecords(
          manifest,
          { packages: { ...current.packages, 'node_modules/katex': old } },
          '0.18.2'
        ),
      'GREEN_LOCK_KATEX_IDENTITY'
    )
    reject(
      () =>
        validateRemediationPackageRecords(
          manifest,
          { packages: { ...current.packages, 'node_modules/other/node_modules/katex': patched } },
          '0.18.2'
        ),
      'GREEN_KATEX_DUPLICATE_OR_NESTED'
    )
    const remediationFiles = [
      '.github/workflows/renderer-katex-security.yml',
      'scripts/ci/renderer-katex-build-evidence.mjs',
      'scripts/ci/renderer-katex-evidence.test.ts',
      'scripts/ci/renderer-katex-provenance.mjs',
      'scripts/ci/renderer-katex-shipping-evidence.mjs',
      'src/renderer/src/components/Markdown.katex.browser.test.ts',
      'src/renderer/src/components/Markdown.mermaid.browser.test.ts'
    ].sort()
    const packageFiles = ['package-lock.json', 'package.json']
    const retainedFailure = '1612d40c56b05d39147443b3765cabed1c99ef2a'
    const broadBaseline = 'f880e76069c43cfa135ffed0d2baf7593068d50a'
    const broadRepair = [
      '.github/workflows/build.yml',
      'scripts/ci/renderer-katex-provenance.mjs',
      'scripts/ci/renderer-katex-evidence.test.ts',
      'scripts/ci/root-report-workflow.contract.test.ts'
    ]
    const historicalFive = [
      'scripts/ci/renderer-katex-build-evidence.mjs',
      'scripts/ci/renderer-katex-provenance.mjs',
      'scripts/ci/renderer-katex-evidence.test.ts',
      ...packageFiles
    ].sort()
    const currentFour = [
      'scripts/ci/renderer-katex-build-evidence.mjs',
      'scripts/ci/renderer-katex-provenance.mjs',
      'scripts/ci/renderer-katex-evidence.test.ts',
      'scripts/ci/renderer-katex-shipping-evidence.mjs'
    ].sort()
    const cumulativeSix = [...new Set([...historicalFive, ...currentFour])].sort()
    const broadCumulativeEight = [...new Set([...cumulativeSix, ...broadRepair])].sort()
    const amendedEleven = [...new Set([...remediationFiles, ...packageFiles, ...broadRepair])].sort()
    const broadFour = broadRepair.slice().sort()
    const facts = {
      repository: 'mysticalsin/AskToto-Mantu',
      ref: 'refs/heads/fix/renderer-katex-remediation',
      head: 'b'.repeat(40),
      githubSha: 'b'.repeat(40),
      dependencyParent: 'cf2889b0c46b001140b7ccd346ffa6010eeec7a1',
      imagePolicyParent: 'c7901c5551c820171401ff4669b5af4b394eb5b9',
      retainedFailureParent: fallbackBase,
      broadBaselineParent: retainedFailure,
      dirty: false,
      ancestors: Object.fromEntries(
        [
          '15fcfa376feda44531596218a3751c6ea37f98ef',
          'c7901c5551c820171401ff4669b5af4b394eb5b9',
          '0b10ac4badd4811685bb376f1a6ee8aab8212490',
          'cf2889b0c46b001140b7ccd346ffa6010eeec7a1',
          'af7da32a46e2edb084c70f41823e7df48a13df9a',
          fallbackBase,
          retainedFailure,
          broadBaseline,
          'b'.repeat(40)
        ].map((commit) => [commit, true])
      ),
      paths: {
        baseToHarness: [
          '.github/workflows/renderer-katex-security.yml',
          'scripts/ci/renderer-katex-provenance.mjs',
          'scripts/ci/renderer-katex-unhandled-reporter.mjs',
          'src/renderer/src/components/Markdown.katex.browser.test.ts',
          'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
          'src/renderer/src/components/Markdown.security.browser.test.ts',
          'src/renderer/src/components/__tests__/renderer-security-browser-harness.ts'
        ].sort(),
        harnessToPolicy: ['src/renderer/src/components/Markdown.tsx'],
        policyToR: [
          '.github/workflows/renderer-katex-security.yml',
          'scripts/ci/renderer-katex-provenance.mjs',
          'src/renderer/src/components/Markdown.security.browser.test.ts',
          'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
          'src/renderer/src/components/__tests__/renderer-security-browser-harness.ts'
        ].sort(),
        baseToR: [
          '.github/workflows/renderer-katex-security.yml',
          'scripts/ci/renderer-katex-provenance.mjs',
          'scripts/ci/renderer-katex-unhandled-reporter.mjs',
          'src/renderer/src/components/Markdown.katex.browser.test.ts',
          'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
          'src/renderer/src/components/Markdown.security.browser.test.ts',
          'src/renderer/src/components/Markdown.tsx',
          'src/renderer/src/components/__tests__/renderer-security-browser-harness.ts'
        ].sort(),
        rToD: packageFiles,
        dToFallbackBase: remediationFiles,
        fallbackBaseToG: historicalFive,
        fallbackBaseToRetainedFailure: historicalFive,
        retainedFailureToBroadBaseline: currentFour,
        fallbackBaseToBroadBaseline: cumulativeSix,
        dToBroadBaseline: [...packageFiles, ...remediationFiles].sort(),
        rToBroadBaseline: [...packageFiles, ...remediationFiles].sort(),
        broadBaselineToG: broadFour,
        retainedFailureToG: [...new Set([...currentFour, ...broadRepair])].sort(),
        fallbackBaseToCurrent: broadCumulativeEight,
        dToG: amendedEleven,
        rToG: amendedEleven
      },
      historicalPackageHashes: {
        manifest: '143e15a11a6b4285a02cb385a0701e85e2a001c0b2b0ed8560283ef12e938122',
        lock: '88425a099d638387d1bf14fd06348002e3ced36f29ca25296d00f7e5b92b0393'
      },
      fallbackBasePackageHashes: {
        manifest: '587bae986ba457a255a7e52943586401327e3c5c6c9ae1a32f6d120a3bdf280e',
        lock: 'a381ca5f8cce8042c5fca6a8aaf256e97c5a9c5540a0bb9abd149b10b7d07ced'
      },
      retainedFailurePackageHashes: {
        manifest: 'dddf43f8fcd0a8b353b5b29ed9fa316486a668955ad56161e707f71f56b2ad06',
        lock: 'f2cedcad1b2b67c9f9fb780d24ab6c8dde6dfa65ae0a76432038450d2a41746c'
      },
      policyHashes: {
        parent: 'b012099ba2a8d66cc29caee8555d5a92ff82b3c7b32c205273a90de2c5d67eaa',
        reviewed: '5f1d8910947f5b33de58b759d7bebf72088c1dfab26d013a8c9724640a62d994',
        atR: '5f1d8910947f5b33de58b759d7bebf72088c1dfab26d013a8c9724640a62d994'
      }
    }
    expect(validateRemediationLineageFacts(facts).dependencyCommit).toBe('af7da32a46e2edb084c70f41823e7df48a13df9a')
    expect(validateRemediationLineageFacts(facts).retainedFailureCommit).toBe(retainedFailure)
    expect(validateRemediationLineageFacts(facts).broadBaselineCommit).toBe(broadBaseline)
    reject(
      () => validateRemediationLineageFacts({ ...facts, retainedFailureParent: '' }),
      'GREEN_RETAINED_FAILURE_PARENT'
    )
    reject(
      () => validateRemediationLineageFacts({ ...facts, retainedFailureParent: '0'.repeat(40) }),
      'GREEN_RETAINED_FAILURE_PARENT'
    )
    reject(
      () => validateRemediationLineageFacts({ ...facts, ancestors: { ...facts.ancestors, [retainedFailure]: false } }),
      'GREEN_RETAINED_FAILURE_ANCESTRY'
    )
    reject(
      () => validateRemediationLineageFacts({ ...facts, broadBaselineParent: '0'.repeat(40) }),
      'GREEN_BROAD_BASELINE_PARENT'
    )
    reject(
      () => validateRemediationLineageFacts({ ...facts, ancestors: { ...facts.ancestors, [broadBaseline]: false } }),
      'GREEN_BROAD_BASELINE_ANCESTRY'
    )
    reject(
      () =>
        validateRemediationLineageFacts({
          ...facts,
          retainedFailurePackageHashes: { ...facts.retainedFailurePackageHashes, lock: '0'.repeat(64) }
        }),
      'GREEN_HISTORICAL_BYTES'
    )
    for (const paths of [historicalFive.slice(1), [...historicalFive, 'extra.txt'].sort()])
      reject(
        () =>
          validateRemediationLineageFacts({
            ...facts,
            paths: { ...facts.paths, fallbackBaseToRetainedFailure: paths }
          }),
        'GREEN_RETAINED_FAILURE_PATHS'
      )
    for (const paths of [
      currentFour.filter((path) => !path.endsWith('shipping-evidence.mjs')),
      [...currentFour, 'package.json'].sort(),
      [...currentFour, 'extra.txt'].sort()
    ])
      reject(
        () =>
          validateRemediationLineageFacts({
            ...facts,
            paths: { ...facts.paths, retainedFailureToBroadBaseline: paths }
          }),
        'GREEN_CURRENT_REPAIR_PATHS'
      )
    for (const paths of [
      ...[broadRepair[0], broadRepair[3]].map((omitted) => broadFour.filter((path) => path !== omitted)),
      [...broadFour, 'package.json'].sort(),
      [...broadFour, 'extra.txt'].sort()
    ])
      reject(
        () => validateRemediationLineageFacts({ ...facts, paths: { ...facts.paths, broadBaselineToG: paths } }),
        'GREEN_BROAD_REPAIR_PATHS'
      )
    reject(
      () =>
        validateRemediationLineageFacts({
          ...facts,
          paths: { ...facts.paths, fallbackBaseToBroadBaseline: historicalFive }
        }),
      'GREEN_BROAD_BASELINE_CUMULATIVE_PATHS'
    )
    for (const [key, code] of [
      ['retainedFailureToBroadBaseline', 'GREEN_CURRENT_REPAIR_PATHS'],
      ['fallbackBaseToBroadBaseline', 'GREEN_BROAD_BASELINE_CUMULATIVE_PATHS'],
      ['dToBroadBaseline', 'GREEN_BROAD_BASELINE_D_PATHS'],
      ['rToBroadBaseline', 'GREEN_BROAD_BASELINE_R_PATHS'],
      ['retainedFailureToG', 'GREEN_CURRENT_REPAIR_PATHS'],
      ['fallbackBaseToCurrent', 'GREEN_CUMULATIVE_FALLBACK_PATHS'],
      ['dToG', 'GREEN_D_TO_G_PATHS'],
      ['rToG', 'GREEN_R_TO_G_PATHS']
    ] as const)
      reject(
        () =>
          validateRemediationLineageFacts({ ...facts, paths: { ...facts.paths, [key]: facts.paths[key].slice(1) } }),
        code
      )
    reject(
      () => validateRemediationLineageFacts({ ...facts, repository: 'fork/AskToto-Mantu' }),
      'GREEN_SOURCE_IDENTITY'
    )
    reject(() => validateRemediationLineageFacts({ ...facts, githubSha: 'c'.repeat(40) }), 'GREEN_SOURCE_IDENTITY')
    reject(
      () =>
        validateRemediationLineageFacts({
          ...facts,
          ancestors: { ...facts.ancestors, af7da32a46e2edb084c70f41823e7df48a13df9a: false }
        }),
      'GREEN_HISTORICAL_ANCESTRY'
    )
    reject(
      () =>
        validateRemediationLineageFacts({
          ...facts,
          paths: { ...facts.paths, dToBroadBaseline: [...packageFiles, ...remediationFiles, 'unrelated.txt'].sort() }
        }),
      'GREEN_BROAD_BASELINE_D_PATHS'
    )
    const withoutKatexTest = remediationFiles.filter(
      (path) => path !== 'src/renderer/src/components/Markdown.katex.browser.test.ts'
    )
    reject(
      () =>
        validateRemediationLineageFacts({
          ...facts,
          paths: { ...facts.paths, dToBroadBaseline: [...packageFiles, ...withoutKatexTest].sort() }
        }),
      'GREEN_BROAD_BASELINE_D_PATHS'
    )
    reject(
      () =>
        validateRemediationLineageFacts({
          ...facts,
          paths: { ...facts.paths, rToBroadBaseline: [...packageFiles, ...withoutKatexTest].sort() }
        }),
      'GREEN_BROAD_BASELINE_R_PATHS'
    )
    reject(
      () => validateRemediationLineageFacts({ ...facts, paths: { ...facts.paths, dToFallbackBase: withoutKatexTest } }),
      'GREEN_D_TO_FALLBACK_BASE_PATHS'
    )
    reject(
      () =>
        validateRemediationLineageFacts({
          ...facts,
          paths: { ...facts.paths, fallbackBaseToG: [...facts.paths.fallbackBaseToG, 'extra.txt'].sort() }
        }),
      'GREEN_FALLBACK_AMENDMENT_PATHS'
    )
    reject(
      () => validateRemediationLineageFacts({ ...facts, ancestors: { ...facts.ancestors, [fallbackBase]: false } }),
      'GREEN_FALLBACK_BASE_ANCESTRY'
    )
    reject(
      () =>
        validateRemediationLineageFacts({
          ...facts,
          fallbackBasePackageHashes: { ...facts.fallbackBasePackageHashes, lock: '0'.repeat(64) }
        }),
      'GREEN_HISTORICAL_BYTES'
    )
  })

  it('requires npm ls and npm explain to agree on one installed patched KaTeX and rejects malformed or stale evidence', () => {
    const root = tempRoot()
    const lsPath = join(root, 'npm-ls.json')
    const explainPath = join(root, 'npm-explain.json')
    const mermaidExplainPath = join(root, 'npm-explain-mermaid.json')
    const lock = {
      packages: {
        '': { name: 'asktoto', version: '1.9.7', dependencies: { mermaid: '^11.17.0', streamdown: '^2.5.0' } },
        'node_modules/katex': { version: '0.18.2' },
        'node_modules/mermaid': {
          version: '11.17.0',
          dependencies: { katex: '^0.16.47' },
          peerDependencies: { msw: '^2.0.0' },
          peerDependenciesMeta: { msw: { optional: true } }
        },
        'node_modules/streamdown': { version: '2.5.0', dependencies: { mermaid: '^11.12.2' } }
      }
    }
    for (const [name, version] of [
      ['katex', '0.18.2'],
      ['mermaid', '11.17.0'],
      ['streamdown', '2.5.0']
    ])
      put(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
    const packagePath = (name: string) => join(root, 'node_modules', name)
    const katexNode = { version: '0.18.2', path: packagePath('katex') }
    const mermaidNode = {
      version: '11.17.0',
      path: packagePath('mermaid'),
      dependencies: { katex: katexNode, msw: {} }
    }
    const streamdownNode = { version: '2.5.0', path: packagePath('streamdown'), dependencies: { mermaid: mermaidNode } }
    const tree = {
      name: 'asktoto',
      version: '1.9.7',
      dependencies: {
        mermaid: mermaidNode,
        streamdown: streamdownNode
      }
    }
    const explain = [
      {
        name: 'katex',
        version: '0.18.2',
        location: 'node_modules/katex',
        dependents: [
          {
            name: 'katex',
            type: 'prod',
            spec: '0.18.2',
            rawSpec: '^0.16.47',
            overridden: true,
            from: { name: 'mermaid', version: '11.17.0', location: 'node_modules/mermaid' }
          }
        ]
      }
    ]
    put(lsPath, JSON.stringify(tree))
    put(explainPath, JSON.stringify(explain))
    const mermaidExplain = [
      {
        name: 'mermaid',
        version: '11.17.0',
        location: 'node_modules/mermaid',
        dependents: [
          {
            name: 'mermaid',
            type: 'prod',
            spec: '11.17.0',
            rawSpec: '^11.12.2',
            overridden: true,
            from: { name: 'streamdown', version: '2.5.0', location: 'node_modules/streamdown' }
          }
        ]
      }
    ]
    put(mermaidExplainPath, JSON.stringify(mermaidExplain))
    const checkGraph = (lsExit = 0, explainExit = 0) =>
      checkNpmInstalledGraph(lsPath, lsExit, explainPath, explainExit, lock, root, mermaidExplainPath, 0)
    expect(checkGraph().npmLs.katexCopies).toHaveLength(1)
    const oxide = '@tailwindcss/oxide-wasm32-wasi'
    const oxideDescendants = ['@emnapi/core', '@emnapi/wasi-threads', '@napi-rs/wasm-runtime', '@tybys/wasm-util']
    const graphLock = lock as { packages: Record<string, any> }
    graphLock.packages[''].optionalDependencies = { [oxide]: '4.0.0' }
    graphLock.packages[`node_modules/${oxide}`] = {
      version: '4.0.0',
      optional: true,
      cpu: ['wasm32'],
      dependencies: Object.fromEntries(oxideDescendants.map((name) => [name, '1.0.0']))
    }
    for (const name of oxideDescendants)
      graphLock.packages[`node_modules/${name}`] = { version: '1.0.0', optional: true }
    expect(checkGraph().npmLs.prunedOptionalDescendants).toEqual(oxideDescendants.map((name) => `node_modules/${name}`))
    graphLock.packages[''].dependencies['@emnapi/core'] = '1.0.0'
    reject(() => checkGraph(), 'NPM_INSTALLED_LOCK_NODE_COUNT')
    delete graphLock.packages[''].dependencies['@emnapi/core']
    expect(checkGraph().npmLs.absentOptionalPeers).toEqual([
      { parent: 'node_modules/mermaid', name: 'msw', declaredSpec: '^2.0.0' }
    ])
    const mermaidMutations: Array<(entry: any) => void> = [
      (entry) => {
        delete entry.dependents[0].rawSpec
      },
      (entry) => {
        entry.dependents[0].rawSpec = '^11.17.0'
      },
      (entry) => {
        delete entry.dependents[0].overridden
      },
      (entry) => {
        entry.dependents[0].overridden = false
      },
      (entry) => {
        entry.dependents[0].spec = '^11.12.2'
      },
      (entry) => {
        entry.dependents[0].from.name = 'other-parent'
      },
      (entry) => {
        entry.dependents[0].from.location = 'node_modules/other-streamdown'
      },
      (entry) => {
        entry.dependents[0].error = 'invalid'
      },
      (entry) => {
        entry.location = 'node_modules/other-mermaid'
      }
    ]
    for (const mutate of mermaidMutations) {
      const changed = structuredClone(mermaidExplain)
      mutate(changed[0])
      put(mermaidExplainPath, JSON.stringify(changed))
      reject(() => checkGraph(), 'NPM_EXPLAIN_MERMAID_CHAIN')
    }
    put(mermaidExplainPath, JSON.stringify(mermaidExplain))
    const sharedLock = structuredClone(graphLock)
    const fallback = '@img/sharp-wasm32'
    const runtime = '@emnapi/runtime'
    const wrappers = ['@img/sharp-freebsd-wasm32', '@img/sharp-webcontainers-wasm32']
    Object.assign(
      sharedLock.packages[''].optionalDependencies,
      Object.fromEntries(wrappers.map((name) => [name, '0.35.5']))
    )
    for (const [index, name] of wrappers.entries())
      sharedLock.packages[`node_modules/${name}`] = {
        version: '0.35.5',
        optional: true,
        ...(index === 0 ? { os: ['freebsd'] } : { cpu: ['wasm32'] }),
        dependencies: { [fallback]: '0.35.5' }
      }
    sharedLock.packages[`node_modules/${fallback}`] = {
      version: '0.35.5',
      optional: true,
      dependencies: { [runtime]: '^1.11.3' }
    }
    sharedLock.packages[`node_modules/${runtime}`] = {
      version: '1.11.3',
      optional: true,
      dependencies: { tslib: '^2.4.0' }
    }
    sharedLock.packages['node_modules/tslib'] = { version: '2.8.1', optional: true }
    for (const [name, version] of [
      [fallback, '0.35.5'],
      [runtime, '1.11.3'],
      ['tslib', '2.8.1']
    ])
      put(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
    const checkSharedGraph = () =>
      checkNpmInstalledGraph(lsPath, 0, explainPath, 0, sharedLock, root, mermaidExplainPath, 0)
    expect(checkSharedGraph().npmLs.physicalPackageCount).toBe(3)
    const runtimeNode = {
      version: '1.11.3',
      path: packagePath(runtime),
      dependencies: { tslib: { version: '2.8.1', path: packagePath('tslib') } }
    }
    const fallbackNode = { version: '0.35.5', path: packagePath(fallback), dependencies: { [runtime]: runtimeNode } }
    const sharedTree = { ...tree, dependencies: { ...tree.dependencies, [fallback]: fallbackNode } }
    put(lsPath, JSON.stringify(sharedTree))
    reject(() => checkSharedGraph(), 'NPM_INSTALLED_LOCK_NODE_COUNT')
    put(lsPath, JSON.stringify({ ...sharedTree, problems: ['extraneous: @img/sharp-wasm32@0.35.5'] }))
    reject(() => checkSharedGraph(), 'NPM_LS_INVALID_OR_PROBLEMS')
    put(
      lsPath,
      JSON.stringify({
        ...sharedTree,
        problems: [],
        dependencies: { ...sharedTree.dependencies, [fallback]: { ...fallbackNode, extraneous: true } }
      })
    )
    reject(() => checkSharedGraph(), 'NPM_LS_NODE_INVALID')
    sharedLock.packages[''].optionalDependencies[fallback] = '0.35.5'
    put(lsPath, JSON.stringify(sharedTree))
    expect(checkSharedGraph().npmLs.physicalPackageCount).toBe(6)
    put(lsPath, JSON.stringify(tree))
    reject(() => checkSharedGraph(), 'NPM_INSTALLED_LOCK_NODE_COUNT')
    put(
      lsPath,
      JSON.stringify({
        ...sharedTree,
        dependencies: { ...tree.dependencies, [fallback]: { ...fallbackNode, dependencies: {} } }
      })
    )
    reject(() => checkSharedGraph(), 'NPM_INSTALLED_LOCK_NODE_COUNT')
    put(
      lsPath,
      JSON.stringify({
        ...sharedTree,
        dependencies: { ...sharedTree.dependencies, extra: { version: '1.0.0', path: packagePath('extra') } }
      })
    )
    reject(() => checkSharedGraph(), 'NPM_LS_UNDECLARED_EDGE')
    put(lsPath, JSON.stringify(tree))
    const forgedExplain = structuredClone(explain)
    forgedExplain[0].dependents[0].rawSpec = '^0.18.2'
    put(explainPath, JSON.stringify(forgedExplain))
    reject(() => checkGraph(), 'NPM_EXPLAIN_KATEX_CHAIN')
    put(explainPath, JSON.stringify(explain))
    put(lsPath, JSON.stringify({ ...tree, dependencies: { ...tree.dependencies, katex: katexNode } }))
    reject(() => checkGraph(), 'NPM_INSTALLED_EDGE_SET_MISMATCH')
    put(lsPath, JSON.stringify(tree))
    reject(() => checkGraph(1), 'NPM_GRAPH_COMMAND_EXIT')
    put(
      lsPath,
      JSON.stringify({
        ...tree,
        dependencies: {
          ...tree.dependencies,
          stale: { version: '0.16.47', path: join(root, 'node_modules/stale'), dependencies: {} }
        }
      })
    )
    reject(() => checkGraph(), 'NPM_LS_UNDECLARED_EDGE')
    put(lsPath, JSON.stringify({ ...tree, problems: ['invalid: katex'] }))
    reject(() => checkGraph(), 'NPM_LS_INVALID_OR_PROBLEMS')
    put(
      lsPath,
      JSON.stringify({
        ...tree,
        dependencies: { ...tree.dependencies, streamdown: { ...streamdownNode, dependencies: {} } }
      })
    )
    reject(() => checkGraph(), 'NPM_INSTALLED_EDGE_SET_MISMATCH')
  })

  it('reads a real packed and unpacked ASAR and qualifies only a candidate app tree', async () => {
    const root = tempRoot()
    const stage = join(root, 'stage')
    const resources = join(root, 'resources')
    const rendererBytes = Buffer.from('<html><script src="index.js"></script></html>')
    put(join(stage, 'out/renderer/index.html'), rendererBytes)
    const rendererInventory = structuralRenderer(stage, rendererBytes)
    const fontBytes = readFileSync(resolve(process.cwd(), 'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2'))
    put(join(stage, 'fonts/KaTeX_Main-Regular.woff2'), fontBytes)
    put(join(stage, 'assets/unpacked.dat'), Buffer.from('unpacked fixture'))
    put(join(stage, 'assets/nested/contained.dat'), Buffer.from('nested fixture'))
    symlinkSync('unpacked.dat', join(stage, 'assets/file-link.dat'))
    symlinkSync('nested', join(stage, 'assets/directory-link'), 'dir')
    copyFixture(resolve(process.cwd(), 'node_modules/typescript/LICENSE.txt'), join(stage, 'licenses/APACHE-2.0.txt'))
    put(join(stage, 'package.json'), JSON.stringify({ name: 'fixture' }))
    for (const name of ['katex', 'mermaid', 'streamdown'])
      copyFixture(resolve(process.cwd(), 'node_modules', name, 'LICENSE'), join(stage, 'node_modules', name, 'LICENSE'))
    symlinkSync('out/renderer/index.html', join(stage, 'renderer-link.html'))
    mkdirSync(resources, { recursive: true })
    put(join(resources, 'intelligence/resource.bin'), Buffer.from('data'))
    const output = await createPackageWithOptions(stage, join(resources, 'app.asar'), { unpackDir: 'assets' })
    await finished(output as unknown as Writable)
    const katexLicenseSha = sha(readFileSync(resolve(process.cwd(), 'node_modules/katex/LICENSE')))
    const fontAttribution = [
      {
        origin: 'asar',
        path: 'fonts/KaTeX_Main-Regular.woff2',
        sha256: sha(fontBytes),
        licensePackage: 'katex',
        licenseSha256: katexLicenseSha,
        sourcePath: 'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2'
      }
    ]
    const { buildPath, receiptPath, sourceRoot } = await candidateBinding(
      root,
      resources,
      'full',
      'win-x64',
      rendererInventory,
      fontAttribution
    )
    const evidence = await inspectCandidate({
      structuralFixture: true,
      resources,
      buildEvidence: buildPath,
      candidateReceipt: receiptPath,
      sourceRoot,
      profile: 'full',
      arch: 'win-x64'
    })
    expect(evidence.evidence).toBe('STRUCTURAL_FIXTURE_ONLY')
    expect(evidence.securityQualification).toBe(false)
    expect(evidence.installerReadback).toBe('UNKNOWN')
    expect(evidence.unpackedFileCount).toBe(4)
    expect(evidence.fontAttributionStatus).toContain('verified sources')
    expect(evidence.fontAssets).toEqual([
      expect.objectContaining({ path: 'fonts/KaTeX_Main-Regular.woff2', licensePackage: 'katex' })
    ])
    const graphPath = join(dirname(buildPath), 'renderer-graph.json')
    const manifestPath = join(sourceRoot, 'package.json')
    const lockPath = join(sourceRoot, 'package-lock.json')
    const boundPaths = [manifestPath, lockPath, graphPath, buildPath, receiptPath]
    const originalBytes = boundPaths.map((path) => readFileSync(path))
    const historicalManifest = execFileSync('git', ['show', '3544b519eaff8336b3b1bee25c742d5c7392d476:package.json'])
    const historicalLock = execFileSync('git', ['show', '3544b519eaff8336b3b1bee25c742d5c7392d476:package-lock.json'])
    expect(sha(historicalManifest)).toBe('587bae986ba457a255a7e52943586401327e3c5c6c9ae1a32f6d120a3bdf280e')
    expect(sha(historicalLock)).toBe('a381ca5f8cce8042c5fca6a8aaf256e97c5a9c5540a0bb9abd149b10b7d07ced')
    const inspectBound = () =>
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: buildPath,
        candidateReceipt: receiptPath,
        sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    const rebindSource = (manifest: Buffer, lock: Buffer) => {
      put(manifestPath, manifest)
      put(lockPath, lock)
      const graph = JSON.parse(originalBytes[2].toString('utf8'))
      const build = JSON.parse(originalBytes[3].toString('utf8'))
      const receipt = JSON.parse(originalBytes[4].toString('utf8'))
      const configPaths = Object.keys(build.buildRun.configurationHashes)
      const hashes = Object.fromEntries(configPaths.map((path) => [path, sha(readFileSync(join(sourceRoot, path)))]))
      graph.buildRun.configurationHashes = hashes
      build.buildRun.configurationHashes = hashes
      put(graphPath, JSON.stringify(graph))
      build.graphSha256 = sha(readFileSync(graphPath))
      put(buildPath, JSON.stringify(build))
      receipt.buildEvidenceSha256 = sha(readFileSync(buildPath))
      receipt.configurationHashes = hashes
      put(receiptPath, JSON.stringify(receipt))
      expect(hashes).toEqual(
        Object.fromEntries(configPaths.map((path) => [path, sha(readFileSync(join(sourceRoot, path)))]))
      )
      expect(hashes['package.json']).toBe(sha(manifest))
      expect(hashes['package-lock.json']).toBe(sha(lock))
      expect(graph.buildRun.configurationHashes).toEqual(hashes)
      expect(build.buildRun.configurationHashes).toEqual(hashes)
      expect(receipt.configurationHashes).toEqual(hashes)
      expect(build.graphSha256).toBe(sha(readFileSync(graphPath)))
      expect(receipt.buildEvidenceSha256).toBe(sha(readFileSync(buildPath)))
      expect(JSON.parse(readFileSync(graphPath, 'utf8')).buildRun.configurationHashes).toEqual(hashes)
      expect(JSON.parse(readFileSync(buildPath, 'utf8')).graphSha256).toBe(build.graphSha256)
      expect(JSON.parse(readFileSync(receiptPath, 'utf8')).buildEvidenceSha256).toBe(receipt.buildEvidenceSha256)
    }
    try {
      for (const [manifest, lock] of [
        [historicalManifest, originalBytes[1]],
        [originalBytes[0], historicalLock],
        [historicalManifest, historicalLock],
        [Buffer.concat([originalBytes[0], Buffer.from('\n')]), originalBytes[1]],
        [originalBytes[0], Buffer.concat([originalBytes[1], Buffer.from('\n')])]
      ]) {
        rebindSource(manifest, lock)
        await expect(inspectBound()).rejects.toThrow('BUILD_SOURCE_CONFIG_BINDING')
      }
    } finally {
      boundPaths.forEach((path, index) => put(path, originalBytes[index]))
    }
    expect((await inspectBound()).evidence).toBe('STRUCTURAL_FIXTURE_ONLY')
    const packedBytes = evidence.delivered
      .filter((entry: { origin: string; type: string }) => entry.origin === 'asar' && entry.type === 'file')
      .reduce((total: number, entry: { bytes: number }) => total + entry.bytes, 0)
    const unpackedFiles = evidence.delivered.filter(
      (entry: { origin: string; type: string }) =>
        entry.origin === 'asar-unpacked-physical' && (entry.type === 'file' || entry.type === 'link')
    )
    const physicalBytes = (entries: Array<{ physicalPath: string; bytes: number }>) =>
      [...new Map(entries.map((entry) => [entry.physicalPath, entry.bytes])).values()].reduce(
        (total, bytes) => total + bytes,
        0
      )
    const unpackedBytes = physicalBytes(unpackedFiles)
    const looseBytes = physicalBytes(
      evidence.delivered.filter(
        (entry: { origin: string; type: string }) =>
          entry.origin === 'loose-resource' && (entry.type === 'file' || entry.type === 'link')
      )
    )
    expect(packedBytes).toBeGreaterThan(0)
    expect(unpackedBytes).toBe(Buffer.byteLength('unpacked fixture') + Buffer.byteLength('nested fixture'))
    expect(looseBytes).toBeGreaterThan(0)
    const unpackedPhysical = (path: string) =>
      unpackedFiles.find((entry: { path: string }) => entry.path === path)?.physicalPath
    expect(unpackedPhysical('assets/unpacked.dat')).toEqual(expect.any(String))
    expect(unpackedPhysical('assets/nested/contained.dat')).toEqual(expect.any(String))
    expect(unpackedPhysical('assets/file-link.dat')).toBe(unpackedPhysical('assets/unpacked.dat'))
    expect(unpackedPhysical('assets/directory-link/contained.dat')).toBe(
      unpackedPhysical('assets/nested/contained.dat')
    )
    const resourcesAlias = join(root, 'resources-alias')
    symlinkSync(resources, resourcesAlias, process.platform === 'win32' ? 'junction' : 'dir')
    const inspectAlias = (structuralByteLimit: number) =>
      inspectCandidate({
        structuralFixture: true,
        structuralByteLimit,
        resources: resourcesAlias,
        buildEvidence: buildPath,
        candidateReceipt: receiptPath,
        sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    const admittedBytes = packedBytes + unpackedBytes + looseBytes
    const aliasedEvidence = await inspectAlias(admittedBytes)
    expect(aliasedEvidence.resourcesRoot).toBe(evidence.resourcesRoot)
    expect(aliasedEvidence.delivered).toEqual(evidence.delivered)
    expect(aliasedEvidence.unpackedFileCount).toBe(4)
    const unpackedFileLink = join(resources, 'app.asar.unpacked/assets/file-link.dat')
    const ownedOutside = join(root, 'outside-unpacked-link.dat')
    put(ownedOutside, 'outside unpacked roots')
    rmSync(unpackedFileLink)
    symlinkSync(ownedOutside, unpackedFileLink)
    try {
      await expect(inspectAlias(admittedBytes)).rejects.toThrow('LOOSE_EXTERNAL_SYMLINK')
    } finally {
      rmSync(unpackedFileLink)
      symlinkSync('unpacked.dat', unpackedFileLink)
    }
    const inspectWithLimit = (structuralByteLimit: number) =>
      inspectCandidate({
        structuralFixture: true,
        structuralByteLimit,
        resources,
        buildEvidence: buildPath,
        candidateReceipt: receiptPath,
        sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    const rejectBeforePayloadRead = async (limit: number) => {
      const archivePath = fs.realpathSync(join(resources, 'app.asar'))
      const headerEnd = 8 + readFileSync(archivePath).readUInt32LE(4)
      const originalOpen = fs.openSync
      const originalRead = fs.readSync
      const asarRequire = createRequire(resolve(process.cwd(), 'package.json'))
      const wrappedFs = asarRequire(join(dirname(asarRequire.resolve('@electron/asar')), 'wrapped-fs.js'))
        .default as typeof fs
      const originalWrappedOpen = wrappedFs.openSync
      const originalWrappedRead = wrappedFs.readSync
      const opened = new Map<number, { path: string; cursor: number }>()
      let prematureReads = 0
      const trackedOpen = (original: typeof fs.openSync, args: any[]) => {
        const fd = (original as any)(...args)
        opened.set(fd, { path: String(args[0]), cursor: 0 })
        return fd
      }
      const trackedRead = (original: typeof fs.readSync, args: any[]) => {
        const [fd, , , length, position] = args
        const held = opened.get(fd)
        const start = typeof position === 'number' ? position : (held?.cursor ?? 0)
        if (!held || held.path !== archivePath || start + length > headerEnd) {
          prematureReads += 1
          throw new Error('PAYLOAD_READ_BEFORE_ADMISSION')
        }
        const count = (original as any)(...args)
        if (position === null) held.cursor = start + count
        return count
      }
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((...args: any[]) => {
        return trackedOpen(originalOpen, args)
      }) as typeof fs.openSync)
      const readSpy = vi.spyOn(fs, 'readSync').mockImplementation(((...args: any[]) => {
        return trackedRead(originalRead, args)
      }) as typeof fs.readSync)
      const streamSpy = vi.spyOn(fs, 'createReadStream').mockImplementation((() => {
        prematureReads += 1
        throw new Error('PAYLOAD_READ_BEFORE_ADMISSION')
      }) as typeof fs.createReadStream)
      const fileSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((() => {
        prematureReads += 1
        throw new Error('PAYLOAD_READ_BEFORE_ADMISSION')
      }) as typeof fs.readFileSync)
      const wrappedOpenSpy = vi
        .spyOn(wrappedFs, 'openSync')
        .mockImplementation(((...args: any[]) => trackedOpen(originalWrappedOpen, args)) as typeof fs.openSync)
      const wrappedReadSpy = vi
        .spyOn(wrappedFs, 'readSync')
        .mockImplementation(((...args: any[]) => trackedRead(originalWrappedRead, args)) as typeof fs.readSync)
      const wrappedFileSpy = vi.spyOn(wrappedFs, 'readFileSync').mockImplementation((() => {
        prematureReads += 1
        throw new Error('PAYLOAD_READ_BEFORE_ADMISSION')
      }) as typeof fs.readFileSync)
      const wrappedStreamSpy = vi.spyOn(wrappedFs, 'createReadStream').mockImplementation((() => {
        prematureReads += 1
        throw new Error('PAYLOAD_READ_BEFORE_ADMISSION')
      }) as typeof fs.createReadStream)
      syncBuiltinESMExports()
      let observed: unknown
      try {
        await inspectWithLimit(limit)
      } catch (error) {
        observed = error
      } finally {
        wrappedStreamSpy.mockRestore()
        wrappedFileSpy.mockRestore()
        wrappedReadSpy.mockRestore()
        wrappedOpenSpy.mockRestore()
        fileSpy.mockRestore()
        streamSpy.mockRestore()
        readSpy.mockRestore()
        openSpy.mockRestore()
        syncBuiltinESMExports()
      }
      expect(String(observed)).toContain('DELIVERED_TOTAL_BYTE_LIMIT')
      expect(prematureReads).toBe(0)
    }
    await rejectBeforePayloadRead(packedBytes + unpackedBytes + looseBytes - 1)
    const firstUnpacked = evidence.delivered.find(
      (entry: { origin: string; type: string }) => entry.origin === 'asar' && entry.type === 'unpacked-file'
    )
    expect(firstUnpacked?.bytes).toBeGreaterThan(0)
    await rejectBeforePayloadRead(packedBytes + firstUnpacked.bytes - 1)
    const inspectFull = () =>
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: buildPath,
        candidateReceipt: receiptPath,
        sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    if (process.platform !== 'win32') {
      const outside = join(root, 'outside.txt')
      put(outside, 'outside resource')
      symlinkSync(outside, join(resources, 'external-link'))
      await expect(inspectFull()).rejects.toThrow('LOOSE_ROOT_LINK')
      rmSync(join(resources, 'external-link'))
      symlinkSync('cycle-link', join(resources, 'cycle-link'))
      await expect(inspectFull()).rejects.toThrow('LOOSE_SYMLINK_CYCLE')
      rmSync(join(resources, 'cycle-link'))
    }
    if (process.platform === 'linux') {
      put(join(resources, 'INTELLIGENCE/resource.bin'), 'collision')
      await expect(inspectFull()).rejects.toThrow('DELIVERED_NAMESPACE_COLLISION')
      rmSync(join(resources, 'INTELLIGENCE'), { recursive: true })
      const oversized = join(resources, 'oversized-resource.bin')
      const sparse = openSync(oversized, 'w')
      try {
        ftruncateSync(sparse, 16 * 1024 * 1024 * 1024 + 1)
      } finally {
        closeSync(sparse)
      }
      await expect(inspectFull()).rejects.toThrow('DELIVERED_TOTAL_BYTE_LIMIT')
      rmSync(oversized)
    }
    const archivePath = join(resources, 'app.asar')
    const completeArchive = readFileSync(archivePath)
    const malformedHeader = Buffer.from(completeArchive)
    malformedHeader.writeUInt32LE(7, 0)
    put(archivePath, malformedHeader)
    await expect(inspectFull()).rejects.toThrow('ASAR_SIZE_PICKLE_SCHEMA')
    put(archivePath, completeArchive)
    const noncanonicalOffset = Buffer.from(completeArchive)
    const offsetMarker = Buffer.from('"offset":"')
    const offsetStart = noncanonicalOffset.indexOf(offsetMarker)
    if (offsetStart < 0) throw new Error('mini-ASAR fixture has no packed offset')
    noncanonicalOffset[offsetStart + offsetMarker.length] = 'x'.charCodeAt(0)
    put(archivePath, noncanonicalOffset)
    await expect(inspectFull()).rejects.toThrow('ASAR_RANGE_SCHEMA')
    put(archivePath, completeArchive)
    const completeBuild = JSON.parse(readFileSync(buildPath, 'utf8'))
    put(
      buildPath,
      JSON.stringify({
        ...completeBuild,
        observedInventory: completeBuild.observedInventory.filter((entry: { path: string }) => entry.path !== 'lazy.js')
      })
    )
    await expect(inspectFull()).rejects.toThrow('ORDINARY_OBSERVED_BYTES_DIFFER')
    put(buildPath, JSON.stringify(completeBuild))
    const reducedConfig = structuredClone(completeBuild)
    reducedConfig.buildRun.configurationHashes = {
      'electron.vite.config.ts': reducedConfig.buildRun.configurationHashes['electron.vite.config.ts']
    }
    put(buildPath, JSON.stringify(reducedConfig))
    await expect(inspectFull()).rejects.toThrow('BUILD_SOURCE_CONFIG_BINDING')
    put(buildPath, JSON.stringify(completeBuild))
    const omittedOldMember = 'node_modules/mermaid/dist/chunks/mermaid.esm.min/katex-CZ4GXH2S.mjs'
    copyFixture(resolve(process.cwd(), omittedOldMember), join(sourceRoot, omittedOldMember))
    await expect(inspectFull()).rejects.toThrow('BUILD_RESIDUE_MEMBER_SET')
    rmSync(join(sourceRoot, omittedOldMember))
    rmSync(join(resources, 'intelligence/resource.bin'))
    await expect(inspectFull()).rejects.toThrow('REQUIRED_RESOURCE_MISSING:intelligence/resource.bin')
    put(join(resources, 'intelligence/resource.bin'), Buffer.from('data'))
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    put(receiptPath, JSON.stringify({ ...receipt, fontAttributions: [] }))
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: buildPath,
        candidateReceipt: receiptPath,
        sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    ).rejects.toThrow('FONT_ATTRIBUTION_INCOMPLETE')
    const wrongOwner = structuredClone(receipt)
    wrongOwner.fontAttributions[0].licensePackage = 'geist'
    put(receiptPath, JSON.stringify(wrongOwner))
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: buildPath,
        candidateReceipt: receiptPath,
        sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    ).rejects.toThrow('FONT_ATTRIBUTION_BINDING')
    put(receiptPath, JSON.stringify({ ...receipt, signatureScope: 'signed-final-installer' }))
    await expect(inspectFull()).rejects.toThrow('CANDIDATE_RECEIPT_BINDING')
    put(receiptPath, JSON.stringify(receipt))
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: buildPath,
        candidateReceipt: receiptPath,
        sourceRoot,
        profile: 'lean',
        arch: 'mac-arm64'
      })
    ).rejects.toThrow('BUILD_EVIDENCE_REQUIRED')
    const leanStage = join(root, 'lean-stage')
    const leanResources = join(root, 'lean-resources')
    const leanIndex = Buffer.from('<html>lean</html>')
    put(join(leanStage, 'out/renderer/index.html'), leanIndex)
    const leanInventory = structuralRenderer(leanStage, leanIndex, false)
    copyFixture(
      resolve(process.cwd(), 'node_modules/typescript/LICENSE.txt'),
      join(leanStage, 'licenses/APACHE-2.0.txt')
    )
    put(join(leanStage, 'package.json'), JSON.stringify({ name: 'fixture', metisPackageProfile: 'lean' }))
    for (const name of ['katex', 'mermaid', 'streamdown'])
      copyFixture(
        resolve(process.cwd(), 'node_modules', name, 'LICENSE'),
        join(leanStage, 'node_modules', name, 'LICENSE')
      )
    mkdirSync(leanResources, { recursive: true })
    put(join(leanResources, 'intelligence/resource.bin'), Buffer.from('data'))
    put(join(leanResources, 'THIRD_PARTY_NOTICES.md'), noticeText)
    const leanArchive = await createPackageWithOptions(leanStage, join(leanResources, 'app.asar'), {})
    await finished(leanArchive as unknown as Writable)
    const leanBinding = await candidateBinding(root, leanResources, 'lean', 'mac-arm64', leanInventory)
    const leanEvidence = await inspectCandidate({
      structuralFixture: true,
      resources: leanResources,
      buildEvidence: leanBinding.buildPath,
      candidateReceipt: leanBinding.receiptPath,
      sourceRoot: leanBinding.sourceRoot,
      profile: 'lean',
      arch: 'mac-arm64'
    })
    expect(leanEvidence.rendererComparedFileCount).toBe(leanInventory.length - 1)
    expect(leanEvidence.rendererProfileExclusions).toEqual([
      expect.objectContaining({ path: 'assets/whisper.worker-abc.js' })
    ])
    const inspectLean = () =>
      inspectCandidate({
        structuralFixture: true,
        resources: leanResources,
        buildEvidence: leanBinding.buildPath,
        candidateReceipt: leanBinding.receiptPath,
        sourceRoot: leanBinding.sourceRoot,
        profile: 'lean',
        arch: 'mac-arm64'
      })
    rmSync(join(leanResources, 'operator'), { recursive: true })
    await expect(inspectLean()).rejects.toThrow('LEAN_CANDIDATE_REQUIRED_DIRECTORY:operator')
    mkdirSync(join(leanResources, 'operator'))
    const sidecar = 'mac-helper/metis-mac-helper'
    const sidecarBytes = readFileSync(join(leanResources, sidecar))
    const originalLeanReceipt = readFileSync(leanBinding.receiptPath)
    rmSync(join(leanResources, sidecar))
    rmSync(join(leanBinding.sourceRoot, 'build/lean-stage/resources', sidecar))
    const withoutSidecar = JSON.parse(originalLeanReceipt.toString('utf8'))
    withoutSidecar.looseResources = withoutSidecar.looseResources.filter(
      (entry: { path: string }) => entry.path !== sidecar
    )
    put(leanBinding.receiptPath, JSON.stringify(withoutSidecar))
    await expect(inspectLean()).rejects.toThrow(`LEAN_CANDIDATE_REQUIRED_FILE:${sidecar}`)
    put(join(leanResources, sidecar), sidecarBytes)
    put(join(leanBinding.sourceRoot, 'build/lean-stage/resources', sidecar), sidecarBytes)
    put(leanBinding.receiptPath, originalLeanReceipt)
    rmSync(join(leanResources, 'intelligence/resource.bin'))
    rmSync(join(leanBinding.sourceRoot, 'build/lean-stage/resources/intelligence/resource.bin'))
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources: leanResources,
        buildEvidence: leanBinding.buildPath,
        candidateReceipt: leanBinding.receiptPath,
        sourceRoot: leanBinding.sourceRoot,
        profile: 'lean',
        arch: 'mac-arm64'
      })
    ).rejects.toThrow('LEAN_STAGE_CORE_FILE_MISMATCH')
    put(join(leanResources, 'intelligence/index.html'), '<html>fixture intelligence</html>')
    put(
      join(leanBinding.sourceRoot, 'build/lean-stage/resources/intelligence/index.html'),
      '<html>fixture intelligence</html>'
    )
    const coherentLean = JSON.parse(readFileSync(join(leanResources, 'package-inventory.json'), 'utf8'))
    coherentLean.coreFiles = coherentLean.coreFiles.filter(
      (entry: { path: string }) => entry.path !== 'intelligence/resource.bin'
    )
    coherentLean.identity = packageInventoryIdentity(coherentLean)
    const coherentText = `${JSON.stringify(coherentLean)}\n`
    put(join(leanResources, 'package-inventory.json'), coherentText)
    put(join(leanBinding.sourceRoot, 'build/lean-stage/resources/package-inventory.json'), coherentText)
    const coherentReceipt = JSON.parse(readFileSync(leanBinding.receiptPath, 'utf8'))
    coherentReceipt.looseResources = coherentReceipt.looseResources
      .filter((entry: { path: string }) => entry.path !== 'intelligence/resource.bin')
      .map((entry: { path: string; bytes: number; sha256: string }) =>
        entry.path === 'package-inventory.json'
          ? { ...entry, bytes: Buffer.byteLength(coherentText), sha256: sha(coherentText) }
          : entry
      )
    put(leanBinding.receiptPath, JSON.stringify(coherentReceipt))
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources: leanResources,
        buildEvidence: leanBinding.buildPath,
        candidateReceipt: leanBinding.receiptPath,
        sourceRoot: leanBinding.sourceRoot,
        profile: 'lean',
        arch: 'mac-arm64'
      })
    ).rejects.toThrow('LEAN_INTELLIGENCE_SOURCE_SET_MISMATCH')
    const geistBytes = readFileSync(resolve(process.cwd(), 'src/renderer/src/assets/fonts/geist-sans.woff2'))
    put(join(stage, 'fonts/geist-sans.woff2'), geistBytes)
    const interLicense = readFileSync(resolve(process.cwd(), 'node_modules/@fontsource-variable/inter/LICENSE'), 'utf8')
    const fullFontNotice = `${noticeText}\nCopyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git)\n${interLicense}`
    rmSync(join(resources, 'app.asar'))
    rmSync(join(resources, 'app.asar.unpacked'), { recursive: true })
    const fontArchive = await createPackageWithOptions(stage, join(resources, 'app.asar'), { unpackDir: 'assets' })
    await finished(fontArchive as unknown as Writable)
    const fontBinding = await candidateBinding(
      root,
      resources,
      'full',
      'win-x64',
      rendererInventory,
      [
        ...fontAttribution,
        {
          origin: 'asar',
          path: 'fonts/geist-sans.woff2',
          sha256: sha(geistBytes),
          licensePackage: 'geist',
          licenseSha256: sha(fullFontNotice),
          sourcePath: 'src/renderer/src/assets/fonts/geist-sans.woff2'
        }
      ],
      fullFontNotice
    )
    const fontEvidence = await inspectCandidate({
      structuralFixture: true,
      resources,
      buildEvidence: fontBinding.buildPath,
      candidateReceipt: fontBinding.receiptPath,
      sourceRoot: fontBinding.sourceRoot,
      profile: 'full',
      arch: 'win-x64'
    })
    expect(fontEvidence.unpackedFileCount).toBe(4)
    expect(fontEvidence.delivered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: 'asar',
          path: 'assets/file-link.dat',
          type: 'internal-link',
          target: 'assets/unpacked.dat'
        }),
        expect.objectContaining({
          origin: 'asar',
          path: 'assets/directory-link',
          type: 'internal-link',
          target: 'assets/nested'
        })
      ])
    )
    expect(fontEvidence.fontAssets.some((entry: { licensePackage: string }) => entry.licensePackage === 'geist')).toBe(
      true
    )
    const shortNotice = fullFontNotice.replace(
      'This license becomes null and void if any of the above conditions are\nnot met.',
      'This license remains in force.'
    )
    if (shortNotice === fullFontNotice) throw new Error('OFL fixture did not contain the termination paragraph')
    put(join(resources, 'THIRD_PARTY_NOTICES.md'), shortNotice)
    put(join(fontBinding.sourceRoot, 'THIRD_PARTY_NOTICES.md'), shortNotice)
    const fontReceipt = JSON.parse(readFileSync(fontBinding.receiptPath, 'utf8'))
    const noticeEntry = fontReceipt.looseResources.find(
      (entry: { path: string }) => entry.path === 'THIRD_PARTY_NOTICES.md'
    )
    noticeEntry.bytes = Buffer.byteLength(shortNotice)
    noticeEntry.sha256 = sha(shortNotice)
    fontReceipt.fontAttributions.find(
      (entry: { licensePackage: string }) => entry.licensePackage === 'geist'
    )!.licenseSha256 = sha(shortNotice)
    put(fontBinding.receiptPath, JSON.stringify(fontReceipt))
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: fontBinding.buildPath,
        candidateReceipt: fontBinding.receiptPath,
        sourceRoot: fontBinding.sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    ).rejects.toThrow('OFL_TERMS_NOT_DELIVERED')
  })

  it('rejects a build/package byte mismatch, missing delivered license material, and a renamed old bundle in loose resources', async () => {
    const root = tempRoot()
    const stage = join(root, 'stage')
    const resources = join(root, 'resources')
    const rendererBytes = Buffer.from('<html>safe</html>')
    put(join(stage, 'out/renderer/index.html'), rendererBytes)
    const rendererInventory = structuralRenderer(stage, rendererBytes)
    copyFixture(resolve(process.cwd(), 'node_modules/typescript/LICENSE.txt'), join(stage, 'licenses/APACHE-2.0.txt'))
    put(join(stage, 'package.json'), JSON.stringify({ name: 'fixture' }))
    for (const name of ['katex', 'mermaid', 'streamdown'])
      copyFixture(resolve(process.cwd(), 'node_modules', name, 'LICENSE'), join(stage, 'node_modules', name, 'LICENSE'))
    mkdirSync(resources, { recursive: true })
    put(join(resources, 'intelligence/resource.bin'), Buffer.from('data'))
    const repack = async () => {
      if (existsSync(join(resources, 'app.asar'))) rmSync(join(resources, 'app.asar'))
      const output = await createPackageWithOptions(stage, join(resources, 'app.asar'), {})
      await finished(output as unknown as Writable)
      return candidateBinding(root, resources, 'full', 'win-x64', rendererInventory)
    }
    put(join(stage, 'out/renderer/index.html'), '<html>changed</html>')
    let binding = await repack()
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: binding.buildPath,
        candidateReceipt: binding.receiptPath,
        sourceRoot: binding.sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    ).rejects.toThrow('RENDERER_BUILD_MISMATCH')
    put(join(stage, 'out/renderer/index.html'), rendererBytes)
    const katexLicensePath = join(stage, 'node_modules/katex/LICENSE')
    const completeKatexLicense = readFileSync(resolve(process.cwd(), 'node_modules/katex/LICENSE'))
    put(katexLicensePath, completeKatexLicense.subarray(0, 96))
    binding = await repack()
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: binding.buildPath,
        candidateReceipt: binding.receiptPath,
        sourceRoot: binding.sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    ).rejects.toThrow('PACKAGE_LICENSE_NOT_PRESERVED:katex')
    put(katexLicensePath, completeKatexLicense)
    rmSync(join(stage, 'node_modules/mermaid/LICENSE'))
    binding = await repack()
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: binding.buildPath,
        candidateReceipt: binding.receiptPath,
        sourceRoot: binding.sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    ).rejects.toThrow('PACKAGE_LICENSE_NOT_PRESERVED:mermaid')
    copyFixture(resolve(process.cwd(), 'node_modules/mermaid/LICENSE'), join(stage, 'node_modules/mermaid/LICENSE'))
    binding = await repack()
    copyFixture(
      join(binding.sourceRoot, 'node_modules/mermaid/dist/chunks/mermaid.esm/katex-HNBAO5SE.mjs'),
      join(resources, 'vendor/renamed.js')
    )
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: binding.buildPath,
        candidateReceipt: binding.receiptPath,
        sourceRoot: binding.sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    ).rejects.toThrow('EXACT_OLD_ALTERNATE_COPY')
    rmSync(join(resources, 'vendor/renamed.js'))
    put(
      join(resources, 'vendor/renamed.js.map'),
      JSON.stringify({ version: 3, sources: ['old.ts'], sourcesContent: ['version = "0.16.47"'] })
    )
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: binding.buildPath,
        candidateReceipt: binding.receiptPath,
        sourceRoot: binding.sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    ).rejects.toThrow('OLD_KATEX_SOURCE_OR_MAP')
    rmSync(join(resources, 'vendor/renamed.js.map'))
    const disguisedModel = Buffer.alloc(32 * 1024 * 1024 + 1024)
    disguisedModel.write('GGUF', 0, 'ascii')
    disguisedModel.writeUInt32LE(3, 4)
    disguisedModel.write('version = "0.16.47"', 32 * 1024 * 1024 + 100, 'ascii')
    put(join(resources, 'local-llm/models/qwen3.5-0.8b/model.gguf'), disguisedModel)
    binding = await repack()
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: binding.buildPath,
        candidateReceipt: binding.receiptPath,
        sourceRoot: binding.sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    ).rejects.toThrow('OLD_KATEX_SOURCE_OR_MAP')
    rmSync(join(resources, 'local-llm/models/qwen3.5-0.8b/model.gguf'))
    const encodedMap = Buffer.from(
      JSON.stringify({ version: 3, sources: ['old.ts'], sourcesContent: ['version = "0.16.47"'] })
    ).toString('base64')
    const disguisedJavascript = Buffer.alloc(32 * 1024 * 1024 + 1024, 0x20)
    disguisedJavascript.write('MZ:;', 0, 'ascii')
    disguisedJavascript.write(
      `\n//# sourceMappingURL=data:application/json;base64,${encodedMap}\n`,
      32 * 1024 * 1024 + 100,
      'ascii'
    )
    put(join(stage, 'vendor/payload.js'), disguisedJavascript)
    binding = await repack()
    put(join(binding.sourceRoot, 'vendor/payload.js'), disguisedJavascript)
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: binding.buildPath,
        candidateReceipt: binding.receiptPath,
        sourceRoot: binding.sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    ).rejects.toThrow('LARGE_SOURCE_UNCLASSIFIED')
    rmSync(join(stage, 'vendor/payload.js'))
    const malformedPe = Buffer.alloc(32 * 1024 * 1024 + 1024, 0x20)
    malformedPe.write('MZ:/*', 0, 'ascii')
    malformedPe.writeUInt32LE(128, 0x3c)
    malformedPe.write('PE\0\0', 128, 'ascii')
    malformedPe.write(
      `\n//# sourceMappingURL=data:application/json;base64,${encodedMap}\n`,
      32 * 1024 * 1024 + 100,
      'ascii'
    )
    const exePath = 'node_modules/streamdown/vendor/payload.exe'
    put(join(stage, exePath), malformedPe)
    binding = await repack()
    put(join(binding.sourceRoot, exePath), malformedPe)
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: binding.buildPath,
        candidateReceipt: binding.receiptPath,
        sourceRoot: binding.sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    ).rejects.toThrow('LARGE_SOURCE_UNCLASSIFIED')
    malformedPe.writeUInt16LE(0x8664, 132)
    malformedPe.writeUInt16LE(1, 134)
    malformedPe.writeUInt16LE(0xf0, 148)
    malformedPe.writeUInt16LE(0x20b, 152)
    malformedPe.writeUInt32LE(512, 408)
    malformedPe.writeUInt32LE(1024, 412)
    put(join(stage, exePath), malformedPe)
    binding = await repack()
    put(join(binding.sourceRoot, exePath), malformedPe)
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: binding.buildPath,
        candidateReceipt: binding.receiptPath,
        sourceRoot: binding.sourceRoot,
        profile: 'full',
        arch: 'win-x64'
      })
    ).rejects.toThrow('OLD_KATEX_SOURCE_OR_MAP')
  })

  it('finds an old KaTeX source map inside the actual ASAR instead of trusting its filename', async () => {
    const root = tempRoot()
    const stage = join(root, 'stage')
    const resources = join(root, 'resources')
    const rendererBytes = Buffer.from('<html>safe</html>')
    const mapBytes = Buffer.from(
      JSON.stringify({ version: 3, sources: ['old.ts'], sourcesContent: ['version = "0.16.47"'] })
    )
    put(join(stage, 'out/renderer/index.html'), rendererBytes)
    const rendererInventory = structuralRenderer(stage, rendererBytes, false)
    put(join(stage, 'chunks/renamed.js.map'), mapBytes)
    copyFixture(resolve(process.cwd(), 'node_modules/typescript/LICENSE.txt'), join(stage, 'licenses/APACHE-2.0.txt'))
    put(join(stage, 'package.json'), JSON.stringify({ name: 'fixture', metisPackageProfile: 'lean' }))
    for (const name of ['katex', 'mermaid', 'streamdown'])
      copyFixture(resolve(process.cwd(), 'node_modules', name, 'LICENSE'), join(stage, 'node_modules', name, 'LICENSE'))
    mkdirSync(resources, { recursive: true })
    put(join(resources, 'intelligence/resource.bin'), Buffer.from('data'))
    put(join(resources, 'THIRD_PARTY_NOTICES.md'), noticeText)
    const output = await createPackageWithOptions(stage, join(resources, 'app.asar'), {})
    await finished(output as unknown as Writable)
    const { buildPath, receiptPath, sourceRoot } = await candidateBinding(
      root,
      resources,
      'lean',
      'mac-x64',
      rendererInventory
    )
    await expect(
      inspectCandidate({
        structuralFixture: true,
        resources,
        buildEvidence: buildPath,
        candidateReceipt: receiptPath,
        sourceRoot,
        profile: 'lean',
        arch: 'mac-x64'
      })
    ).rejects.toThrow('OLD_KATEX_SOURCE_OR_MAP')
  })
})
