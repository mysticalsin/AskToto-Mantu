#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractArchive } from './fetch-llama-server.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const expected = {
  darwin: {
    arm64: {
      archive: 'llama-b9957-bin-macos-arm64.tar.gz',
      archiveSha: '7a43fd3c4ddd30f3c408da7c80975503f18b829da023a7d0e34bdb6f1b1a056f',
      binary: 'resources/llama/mac/arm64/llama-server',
      cpu: 0x0100000c
    },
    x64: {
      archive: 'llama-b9957-bin-macos-x64.tar.gz',
      archiveSha: 'f03f6669c7e34c2768ca4a318dd13e105dec46e1f87a2165d2be7fd6a0ee4716',
      binary: 'resources/llama/mac/x64/llama-server',
      cpu: 0x01000007
    }
  },
  win32: {
    x64: {
      archives: [
        ['llama-b9957-bin-win-cpu-x64.zip', '422ad9b46f5ab60f7fd2e83783233eba2d9383e6f17d7ee916c80f19eb070e79'],
        ['llama-b9957-bin-win-vulkan-x64.zip', 'fcc0a8c0f0f3140122452ed2728cebb520c5fbc4fc921836ee3a45dd77e18c68']
      ]
    }
  }
}
const modelInputs = [
  [
    'resources/local-llm/models/qwen3.5-0.8b/model.gguf',
    558_772_480,
    '3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5'
  ],
  [
    'resources/local-llm/models/qwen3.5-0.8b/mmproj.gguf',
    204_987_232,
    '56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453'
  ],
  [
    'resources/local-llm/LICENSE.QWEN3.5-APACHE-2.0.txt',
    11_344,
    '2410613f992aef11cab1ca584d5732068b6038da37bd140092f09f61dd1c31bd'
  ]
]

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function requireEqual(actual, expectedValue, label) {
  if (actual !== expectedValue) throw new Error(`${label}: expected ${expectedValue}, got ${actual}`)
}

function requireFile(path, bytes, digest, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label}: missing regular file ${path}`)
  if (bytes !== undefined) requireEqual(statSync(path).size, bytes, `${label} byte length`)
  return sha256(path).then((actual) => {
    if (digest) requireEqual(actual, digest, `${label} SHA-256`)
    return { path: path.slice(root.length + 1).replaceAll('\\', '/'), bytes: statSync(path).size, sha256: actual }
  })
}

function findDirContaining(directory, filename, depth = 6) {
  if (existsSync(join(directory, filename))) return directory
  if (depth <= 0) return null
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findDirContaining(join(directory, entry.name), filename, depth - 1)
      if (found) return found
    }
  }
  return null
}

async function verifyExtractedArchive(archivePath, destination, binaryName, libraryExtension, archiveSha, runnerTemp) {
  const paths = process.platform === 'win32' ? win32 : posix
  const scratch = await mkdtemp(join(runnerTemp, 'native-runtime-archive-'))
  try {
    extractArchive(archivePath, scratch)
    const archiveDirectory = findDirContaining(scratch, binaryName)
    if (!archiveDirectory) throw new Error(`Pinned archive is missing ${binaryName}`)
    const archiveEntries = readdirSync(archiveDirectory, { withFileTypes: true })
    const archiveMembers = archiveEntries
      .filter((entry) => entry.isFile() && (entry.name === binaryName || entry.name.endsWith(libraryExtension)))
      .map((entry) => entry.name)
      .sort()
    if (!archiveMembers.includes(binaryName)) throw new Error(`Pinned archive is missing runtime ${binaryName}`)
    if (archiveMembers.filter((name) => name.endsWith(libraryExtension)).length === 0)
      throw new Error(`Pinned archive has no ${libraryExtension} runtime libraries`)
    const destinationEntries = readdirSync(destination, { withFileTypes: true })
    const runtimeDestinationEntries = destinationEntries.filter((entry) => entry.name !== '.sha256')
    const destinationNames = runtimeDestinationEntries.map((entry) => entry.name).sort()
    if (JSON.stringify(destinationNames) !== JSON.stringify(archiveMembers))
      throw new Error(
        `Extracted runtime inventory differs from pinned archive: expected ${archiveMembers.join(',')}, got ${destinationNames.join(',')}`
      )
    const marker = join(destination, '.sha256')
    if (!existsSync(marker) || !lstatSync(marker).isFile() || readFileSync(marker, 'utf8').trim() !== archiveSha)
      throw new Error(`Runtime archive marker does not match pinned archive ${archiveSha}`)
    const members = []
    for (const name of archiveMembers) {
      const extractedEntry = runtimeDestinationEntries.find((entry) => entry.name === name)
      if (!extractedEntry?.isFile()) throw new Error(`Extracted runtime member is not a regular file: ${name}`)
      const archiveMemberPath = join(archiveDirectory, name)
      const extractedPath = join(destination, name)
      const archiveStat = statSync(archiveMemberPath)
      const extractedStat = statSync(extractedPath)
      if (!archiveStat.isFile() || !extractedStat.isFile())
        throw new Error(`Runtime member is not a regular file: ${name}`)
      if (archiveStat.size !== extractedStat.size) throw new Error(`Extracted runtime member size differs: ${name}`)
      const archiveDigest = await sha256(archiveMemberPath)
      const extractedDigest = await sha256(extractedPath)
      requireEqual(extractedDigest, archiveDigest, `Extracted runtime member ${name} SHA-256`)
      members.push({
        archiveMember: name,
        bytes: extractedStat.size,
        sha256: extractedDigest,
        path: paths.relative(root, extractedPath).replaceAll('\\', '/')
      })
    }
    return { archive: paths.relative(root, archivePath).replaceAll('\\', '/'), members }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

const platform = process.env.EXPECTED_PLATFORM
const arch = process.env.EXPECTED_ARCH
const runnerTemp = process.env.RUNNER_TEMP
const paths = process.platform === 'win32' ? win32 : posix
requireEqual(process.platform, platform === 'darwin' ? 'darwin' : 'win32', 'actual process.platform')
requireEqual(process.arch, arch, 'actual process.arch')
const tempRoot = runnerTemp ? paths.parse(paths.resolve(runnerTemp)).root : ''
const resolvedTemp = runnerTemp ? paths.resolve(runnerTemp) : ''
if (!runnerTemp || resolvedTemp === tempRoot) throw new Error('RUNNER_TEMP must be an absolute non-root directory')
const pin = expected[process.platform]?.[process.arch]
if (!pin) throw new Error(`No reviewed input pin for ${process.platform}/${process.arch}`)
const verified = []
const runtimeInventories = []
if (platform === 'darwin') {
  const cache = join(root, 'resources/llama/.cache')
  verified.push(await requireFile(join(cache, pin.archive), undefined, pin.archiveSha, 'llama archive'))
  const binary = join(root, pin.binary)
  runtimeInventories.push(
    await verifyExtractedArchive(
      join(cache, pin.archive),
      dirname(binary),
      'llama-server',
      '.dylib',
      pin.archiveSha,
      resolvedTemp
    )
  )
  verified.push(await requireFile(binary, undefined, undefined, 'llama executable'))
  if ((statSync(binary).mode & 0o111) === 0) throw new Error(`llama executable is not marked executable: ${binary}`)
  const data = readFileSync(binary)
  if (data.length < 8 || data.readUInt32LE(4) !== pin.cpu)
    throw new Error(`llama executable CPU type does not match ${arch}`)
  for (const member of runtimeInventories[0].members.filter((entry) => entry.archiveMember.endsWith('.dylib')))
    verified.push(
      await requireFile(join(dirname(binary), member.archiveMember), member.bytes, member.sha256, 'llama dylib')
    )
} else {
  const cache = join(root, 'resources/llama/.cache')
  const { readdir } = await import('node:fs/promises')
  for (const [name, digest] of pin.archives) {
    verified.push(await requireFile(join(cache, name), undefined, digest, 'llama archive'))
    const variant = name.includes('-cpu-') ? 'cpu' : 'vulkan'
    runtimeInventories.push(
      await verifyExtractedArchive(
        join(cache, name),
        join(root, 'resources/llama/win', variant),
        'llama-server.exe',
        '.dll',
        digest,
        resolvedTemp
      )
    )
  }
  for (const variant of ['cpu', 'vulkan']) {
    const dir = join(root, 'resources/llama/win', variant)
    const executable = join(dir, 'llama-server.exe')
    verified.push(await requireFile(executable, undefined, undefined, `llama ${variant} executable`))
    const data = readFileSync(executable)
    if (data.length < 64 || data.toString('ascii', 0, 2) !== 'MZ')
      throw new Error(`llama ${variant} executable is not PE`)
    const peOffset = data.readUInt32LE(0x3c)
    if (
      peOffset + 6 > data.length ||
      data.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' ||
      data.readUInt16LE(peOffset + 4) !== 0x8664
    ) {
      throw new Error(`llama ${variant} executable is not Windows x64`)
    }
    const inventory = runtimeInventories.find((entry) => entry.archive.includes(`-win-${variant}-`))
    if (!inventory) throw new Error(`Missing pinned archive inventory for Windows ${variant}`)
    for (const member of inventory.members.filter((entry) => entry.archiveMember.endsWith('.dll')))
      verified.push(
        await requireFile(join(dir, member.archiveMember), member.bytes, member.sha256, `llama ${variant} DLL`)
      )
  }
}
for (const [relative, bytes, digest] of modelInputs)
  verified.push(await requireFile(join(root, relative), bytes, digest, relative))

const sourceSha = process.env.GITHUB_SHA
if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) throw new Error('GITHUB_SHA must be a full source commit SHA')
const runId = process.env.GITHUB_RUN_ID
if (!/^[0-9]+$/.test(runId ?? '')) throw new Error('GITHUB_RUN_ID is required')
const attempt = process.env.GITHUB_RUN_ATTEMPT
if (!/^[1-9][0-9]*$/.test(attempt ?? '')) throw new Error('GITHUB_RUN_ATTEMPT is required')
const output = process.env.NATIVE_INPUT_REPORT
if (!output || !paths.isAbsolute(runnerTemp) || !paths.isAbsolute(output))
  throw new Error('RUNNER_TEMP and NATIVE_INPUT_REPORT must be absolute nonempty paths')
if (
  resolvedTemp === tempRoot ||
  paths.dirname(paths.resolve(output)) !== resolvedTemp ||
  paths.basename(output) !== 'native-inputs.json'
)
  throw new Error('NATIVE_INPUT_REPORT must be the owned native-inputs.json directly inside a non-root RUNNER_TEMP')
await mkdir(dirname(output), { recursive: true })
const evidence = {
  schema: 1,
  sourceSha,
  runId,
  attempt: Number(attempt),
  platform,
  arch,
  runtimeInventories,
  inputs: verified
}
await (await import('node:fs/promises')).writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
console.log(`NATIVE_INPUTS_VERIFIED ${JSON.stringify({ sourceSha, platform, arch, inputCount: verified.length })}`)
