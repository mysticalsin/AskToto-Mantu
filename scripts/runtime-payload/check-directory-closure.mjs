#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

if (process.env.GITHUB_ACTIONS !== 'true' || !['darwin', 'win32'].includes(process.platform)) {
  throw new Error('RUNTIME_DIRECTORY_CLOSURE_ACTIONS_NATIVE_ONLY')
}

const script = fileURLToPath(new URL('./create-payload.mjs', import.meta.url))
const repository = resolve(dirname(script), '../..')
const workspace = await mkdtemp(resolve(tmpdir(), 'metis-runtime-directory-'))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function metadataFor() {
  const workflow = /^mysticalsin\/AskToto-Mantu\/([a-z0-9./-]+\.yml)@/.exec(process.env.GITHUB_WORKFLOW_REF ?? '')
  if (!workflow) throw new Error('RUNTIME_DIRECTORY_TEST_WORKFLOW_IDENTITY_INVALID')
  const lockBytes = await readFile(resolve(repository, 'package-lock.json'))
  return {
    schemaVersion: 1,
    kind: 'runtime',
    componentId: 'runtime.whisper-renderer',
    artifactId: 'runtime.whisper-renderer-directory-fixture',
    target: { platform: process.platform, arch: process.arch },
    runtime: {
      electronVersion: '43.6.0',
      nodeAbi: '140',
      napi: '10',
      chromiumVersion: '140.0.0.0',
      hostProtocol: 1
    },
    entrypoints: { 'whisper-renderer-worker': 'runtime/worker.mjs' },
    directories: {
      'whisper-ort-wasm': {
        root: 'ort',
        members: ['ort/ort-wasm-simd-threaded.jsep.mjs', 'ort/ort-wasm-simd-threaded.jsep.wasm']
      }
    },
    models: [],
    source: {
      repositoryUri: 'https://github.com/mysticalsin/AskToto-Mantu',
      commit: process.env.GITHUB_SHA,
      workflowPath: workflow[1],
      workflowCommit: process.env.GITHUB_WORKFLOW_SHA,
      runId: process.env.GITHUB_RUN_ID,
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      lockSha256: sha256(lockBytes),
      ref: process.env.GITHUB_REF,
      runnerEnvironment: process.env.RUNNER_ENVIRONMENT
    },
    builder: {
      nodeVersion: process.version,
      npmVersion: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
      zlibVersion: process.versions.zlib,
      packages: [{ name: 'electron', version: '43.6.0' }]
    },
    upstream: [
      {
        name: 'directory fixture',
        version: '1',
        sourceUri: 'https://example.invalid/wasm-fixture',
        revision: 'fixture-revision',
        digest: { algorithm: 'sha256', value: '0'.repeat(64) }
      }
    ],
    licenses: [
      {
        package: 'directory fixture',
        version: '1',
        spdx: 'MIT',
        sourceUri: 'https://example.invalid/wasm-fixture',
        noticePath: 'licenses/NOTICE.txt',
        noticeBytes: 1,
        noticeSha256: sha256(Buffer.from('x')),
        sourceReceiptUri: 'https://example.invalid/wasm-fixture-license'
      }
    ]
  }
}

function build(payloadRoot, metadataPath, output) {
  return spawnSync(process.execPath, [script, '--root', payloadRoot, '--metadata', metadataPath, '--output', output], {
    encoding: 'utf8',
    timeout: 30_000,
    env: process.env
  })
}

function readTarRows(bytes) {
  const tar = gunzipSync(bytes)
  const rows = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    assert.equal(header[156], 0x30)
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/, '')
    const name = field(0, 100)
    const prefix = field(345, 155)
    const bytes = Number.parseInt(field(124, 12).trim(), 8)
    const start = offset + 512
    const contents = tar.subarray(start, start + bytes)
    rows.push({ path: prefix ? `${prefix}/${name}` : name, bytes, sha256: sha256(contents) })
    offset = start + 512 + Math.ceil(bytes / 512) * 512
  }
  return rows
}

try {
  const payloadRoot = resolve(workspace, 'payload')
  const output = resolve(workspace, 'output')
  const rejectOutput = resolve(workspace, 'reject-output')
  const metadataPath = resolve(workspace, 'metadata.json')
  await mkdir(resolve(payloadRoot, 'runtime'), { recursive: true })
  await mkdir(resolve(payloadRoot, 'ort'), { recursive: true })
  await mkdir(resolve(payloadRoot, 'licenses'), { recursive: true })
  await writeFile(resolve(payloadRoot, 'runtime/worker.mjs'), 'worker fixture')
  await writeFile(resolve(payloadRoot, 'ort/ort-wasm-simd-threaded.jsep.mjs'), 'loader fixture')
  await writeFile(resolve(payloadRoot, 'ort/ort-wasm-simd-threaded.jsep.wasm'), 'wasm fixture')
  await writeFile(resolve(payloadRoot, 'licenses/NOTICE.txt'), 'x')
  const metadata = await metadataFor()
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`)
  const result = build(payloadRoot, metadataPath, output)
  assert.equal(result.error, undefined, 'valid directory fixture builder completed')
  assert.equal(result.status, 0, 'valid WASM directory closure accepted')
  const candidate = JSON.parse(await readFile(resolve(output, 'candidate.json'), 'utf8'))
  const inventory = JSON.parse(await readFile(resolve(output, candidate.inventory.path), 'utf8'))
  assert.deepEqual(inventory.directories, metadata.directories)
  assert.deepEqual(candidate.directories, metadata.directories)
  assert.deepEqual(
    readTarRows(await readFile(resolve(output, candidate.archive.path))),
    inventory.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
  )

  await writeFile(resolve(payloadRoot, 'ort/extra.wasm'), 'unmapped extra')
  const rejected = build(payloadRoot, metadataPath, rejectOutput)
  assert.equal(rejected.error, undefined, 'extra directory member rejection completed')
  assert.notEqual(rejected.status, 0, 'extra WASM directory member rejected')
  assert.equal(rejected.stderr.trim(), 'RUNTIME_PAYLOAD_DIRECTORY_CLOSURE_MISMATCH')
  process.stdout.write('RUNTIME_DIRECTORY_CLOSURE_CASES_PASSED positive=1 negative=1\n')
} catch {
  process.stderr.write('RUNTIME_DIRECTORY_CLOSURE_CASES_FAILED\n')
  process.exitCode = 1
} finally {
  await rm(workspace, { recursive: true, force: true })
}
