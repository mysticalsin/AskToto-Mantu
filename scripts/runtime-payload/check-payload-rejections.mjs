#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux') {
  throw new Error('RUNTIME_PAYLOAD_NEGATIVES_ACTIONS_LINUX_ONLY')
}

const script = fileURLToPath(new URL('./create-payload.mjs', import.meta.url))
const repoRoot = resolve(dirname(script), '../..')
const lockBytes = await (await import('node:fs/promises')).readFile(resolve(repoRoot, 'package-lock.json'))
const root = await mkdtemp(resolve(tmpdir(), 'metis-runtime-negative-'))

function makeMetadata() {
  return {
    schemaVersion: 1,
    kind: 'model',
    componentId: 'model.test-fixture',
    artifactId: 'model.test-fixture',
    target: { platform: 'any', arch: 'any' },
    runtime: null,
    entrypoints: {},
    models: [{ id: 'speaker.embedding', root: 'model', members: ['model/file.bin'] }],
    source: {
      repositoryUri: 'https://github.com/mysticalsin/AskToto-Mantu',
      commit: process.env.GITHUB_SHA,
      workflowPath: /^mysticalsin\/AskToto-Mantu\/(\.github\/workflows\/[a-z0-9-]+\.yml)@/.exec(
        process.env.GITHUB_WORKFLOW_REF ?? ''
      )?.[1],
      workflowCommit: process.env.GITHUB_WORKFLOW_SHA,
      runId: process.env.GITHUB_RUN_ID,
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      lockSha256: createHash('sha256').update(lockBytes).digest('hex'),
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
        name: 'publisher rejection fixture',
        version: '1',
        sourceUri: 'https://example.invalid/source',
        revision: 'fixture-revision',
        digest: { algorithm: 'sha256', value: '0'.repeat(64) }
      }
    ],
    licenses: [
      {
        package: 'publisher rejection fixture',
        version: '1',
        spdx: 'MIT',
        sourceUri: 'https://example.invalid/source',
        noticePath: 'model/NOTICE',
        noticeBytes: 1,
        noticeSha256: createHash('sha256').update('x').digest('hex'),
        sourceReceiptUri: 'https://example.invalid/license-receipt'
      }
    ]
  }
}

async function rejected(name, setup, expectedCode) {
  const caseRoot = resolve(root, name)
  const output = resolve(root, `${name}-output`)
  await mkdir(caseRoot, { recursive: true })
  const metadataPath = resolve(root, `${name}.json`)
  const metadata = makeMetadata()
  await setup(caseRoot, metadataPath, metadata)
  if (metadataPath.endsWith('.json') && name !== 'oversized-metadata') {
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`)
  }
  const run = spawnSync(
    process.execPath,
    [script, '--root', caseRoot, '--metadata', metadataPath, '--output', output],
    {
      encoding: 'utf8',
      timeout: 180_000,
      env: {
        ...process.env,
        GITHUB_ACTIONS: 'true'
      }
    }
  )
  assert.equal(run.error, undefined, `${name}: builder process completed`)
  assert.notEqual(run.status, 0, `${name}: builder rejected input`)
  assert.equal(run.stderr.trim(), expectedCode, `${name}: stable rejection code`)
}

try {
  await rejected(
    'reserved-device',
    async (payloadRoot) => {
      await writeFile(resolve(payloadRoot, 'CON.txt'), 'x')
    },
    'RUNTIME_PAYLOAD_PATH_INVALID'
  )

  await rejected(
    'trailing-dot',
    async (payloadRoot) => {
      await writeFile(resolve(payloadRoot, 'artifact.'), 'x')
    },
    'RUNTIME_PAYLOAD_PATH_INVALID'
  )

  await rejected(
    'symbolic-link',
    async (payloadRoot) => {
      await writeFile(resolve(payloadRoot, 'target.bin'), 'x')
      await symlink(resolve(payloadRoot, 'target.bin'), resolve(payloadRoot, 'model'))
    },
    'RUNTIME_PAYLOAD_LINK_REJECTED'
  )

  await rejected(
    'hard-link',
    async (payloadRoot) => {
      await mkdir(resolve(payloadRoot, 'model'))
      await writeFile(resolve(payloadRoot, 'model/file.bin'), 'x')
      await link(resolve(payloadRoot, 'model/file.bin'), resolve(payloadRoot, 'duplicate.bin'))
    },
    'RUNTIME_PAYLOAD_SPECIAL_OR_HARDLINK_REJECTED'
  )

  await rejected(
    'fifo',
    async (payloadRoot) => {
      const fifo = resolve(payloadRoot, 'model')
      const result = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 5_000 })
      assert.equal(result.status, 0, 'fifo fixture created')
    },
    'RUNTIME_PAYLOAD_SPECIAL_OR_HARDLINK_REJECTED'
  )

  await rejected(
    'oversized-metadata',
    async (_payloadRoot, metadataPath) => {
      await writeFile(metadataPath, Buffer.alloc(2_000_001))
    },
    'RUNTIME_PAYLOAD_METADATA_OVERSIZED'
  )

  await rejected(
    'oversized-inventory',
    async (payloadRoot) => {
      await mkdir(resolve(payloadRoot, 'model'), { recursive: true })
      await writeFile(resolve(payloadRoot, 'model/file.bin'), 'x')
      await writeFile(resolve(payloadRoot, 'model/NOTICE'), 'x')
      const longPart = 'p'.repeat(230)
      const deepRoot = resolve(payloadRoot, longPart, longPart, longPart, longPart)
      await mkdir(deepRoot, { recursive: true })
      for (let index = 0; index < 21_000; index += 1) {
        await writeFile(resolve(deepRoot, `file-${String(index).padStart(5, '0')}.bin`), '')
      }
    },
    'RUNTIME_PAYLOAD_INVENTORY_OVERSIZED'
  )

  process.stdout.write('RUNTIME_PAYLOAD_NEGATIVE_CASES_PASSED count=7\n')
} catch {
  process.stderr.write('RUNTIME_PAYLOAD_NEGATIVE_CASES_FAILED\n')
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true })
}
