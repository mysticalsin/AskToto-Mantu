#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import Ajv2020 from 'ajv/dist/2020.js'
import { readFile } from 'node:fs/promises'

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux') {
  throw new Error('RUNTIME_PAYLOAD_NEGATIVES_ACTIONS_LINUX_ONLY')
}

const script = fileURLToPath(new URL('./create-payload.mjs', import.meta.url))
const repoRoot = resolve(dirname(script), '../..')
const lockBytes = await readFile(resolve(repoRoot, 'package-lock.json'))
const root = await mkdtemp(resolve(tmpdir(), 'metis-runtime-negative-'))
const ajv = new Ajv2020({ allErrors: true, strict: false })
const validateInventorySchema = ajv.compile(
  JSON.parse(await readFile(resolve(repoRoot, 'resources/runtime-schema/inventory.schema.json'), 'utf8'))
)
const validateCatalogSchema = ajv.compile(
  JSON.parse(await readFile(resolve(repoRoot, 'resources/runtime-schema/catalog.schema.json'), 'utf8'))
)

async function createValidModelFiles(payloadRoot) {
  await mkdir(resolve(payloadRoot, 'model'), { recursive: true })
  await writeFile(resolve(payloadRoot, 'model/file.bin'), 'fixture-model')
  const notice = Buffer.from('x')
  await writeFile(resolve(payloadRoot, 'model/NOTICE'), notice)
}

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

function readTarRows(archiveBytes) {
  const tar = gunzipSync(archiveBytes)
  const rows = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    assert.equal(header.subarray(257, 262).toString('ascii'), 'ustar')
    assert.equal(header[156], 0x30, 'payload members are regular files')
    const textField = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/, '')
    const name = textField(0, 100)
    const prefix = textField(345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const sizeText = textField(124, 12).trim()
    const bytes = Number.parseInt(sizeText, 8)
    const start = offset + 512
    const contents = tar.subarray(start, start + bytes)
    assert.equal(contents.length, bytes)
    rows.push({ path, bytes, sha256: createHash('sha256').update(contents).digest('hex') })
    offset = start + Math.ceil(bytes / 512) * 512
  }
  return rows
}

async function positiveCandidate() {
  const caseRoot = resolve(root, 'valid-positive')
  const output = resolve(root, 'valid-positive-output')
  const metadataPath = resolve(root, 'valid-positive.json')
  await mkdir(caseRoot, { recursive: true })
  await createValidModelFiles(caseRoot)
  const longDirectory = 'd'.repeat(140)
  const longBasename = 'f'.repeat(100)
  await mkdir(resolve(caseRoot, 'model', longDirectory), { recursive: true })
  await writeFile(resolve(caseRoot, 'model', longDirectory, longBasename), 'ustar-prefix-fixture')
  await writeFile(metadataPath, `${JSON.stringify(makeMetadata())}\n`)
  const run = spawnSync(
    process.execPath,
    [script, '--root', caseRoot, '--metadata', metadataPath, '--output', output],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, GITHUB_ACTIONS: 'true' }
    }
  )
  assert.equal(run.error, undefined, 'positive builder process completed')
  assert.equal(run.status, 0, 'valid model payload built')
  assert.match(run.stdout, /^RUNTIME_PAYLOAD_READY component=model\.test-fixture /)
  const candidate = JSON.parse(await readFile(resolve(output, 'candidate.json'), 'utf8'))
  const inventoryBytes = await readFile(resolve(output, candidate.inventory.path))
  const inventory = JSON.parse(inventoryBytes.toString('utf8'))
  const archiveBytes = await readFile(resolve(output, candidate.archive.path))
  assert.equal(validateInventorySchema(inventory), true, 'inventory matches the exact closed schema')
  assert.equal(
    Object.keys(candidate).sort().join('\0'),
    [
      'archive',
      'artifactId',
      'componentId',
      'inventory',
      'kind',
      'payloadBytes',
      'payloadFiles',
      'runtime',
      'schemaVersion',
      'target'
    ]
      .sort()
      .join('\0'),
    'candidate has a closed field set'
  )
  assert.equal(candidate.schemaVersion, 1)
  assert.equal(candidate.artifactId, inventory.artifactId)
  assert.equal(candidate.archive.path, 'model.test-fixture.tar.gz')
  assert.equal(candidate.inventory.path, 'model.test-fixture.inventory.json')
  assert.equal(inventory.source.ref, process.env.GITHUB_REF)
  assert.equal(inventory.source.runnerEnvironment, 'github-hosted')
  assert.deepEqual(inventory.models, [{ id: 'speaker.embedding', root: 'model', members: ['model/file.bin'] }])
  assert.equal(candidate.archive.bytes, archiveBytes.length)
  assert.equal(candidate.archive.sha256, createHash('sha256').update(archiveBytes).digest('hex'))
  assert.equal(candidate.inventory.bytes, inventoryBytes.length)
  assert.equal(candidate.inventory.sha256, createHash('sha256').update(inventoryBytes).digest('hex'))
  assert.equal(candidate.payloadFiles, inventory.files.length)
  assert.deepEqual(
    readTarRows(archiveBytes),
    inventory.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
  )

  const approvedCatalogShape = {
    schemaVersion: 1,
    protocolVersion: 1,
    catalogId: 'metis-runtime-catalog-v1',
    trustRoot: {
      path: 'runtime-trust/sigstore-trusted-root.json',
      bytes: 6787,
      sha256: '6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66',
      source: 'https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json',
      receipt: {
        path: 'runtime-trust/acquisition-receipt.json',
        bytes: 663,
        sha256: '1ad8c2f7d308b9c2a76cbbc48c8880c338a8f89f44f9ce7427ecf99acc6ec456'
      }
    },
    targets: []
  }
  assert.equal(validateCatalogSchema(approvedCatalogShape), true, 'approved app-owned root catalog shape validates')
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
      await createValidModelFiles(payloadRoot)
      const deepRoot = resolve(payloadRoot, 'p'.repeat(75), 'q'.repeat(78))
      await mkdir(deepRoot, { recursive: true })
      for (let index = 0; index < 60_000; index += 1) {
        const prefix = `file-${String(index).padStart(5, '0')}`
        await writeFile(resolve(deepRoot, prefix.padEnd(90, 'x')), '')
      }
    },
    'RUNTIME_PAYLOAD_INVENTORY_OVERSIZED'
  )

  await rejected(
    'array-artifact-id',
    async (_payloadRoot, _metadataPath, metadata) => {
      metadata.artifactId = ['model.test-fixture']
    },
    'RUNTIME_PAYLOAD_METADATA_INVALID'
  )

  await rejected(
    'array-component-id',
    async (_payloadRoot, _metadataPath, metadata) => {
      metadata.componentId = ['model.test-fixture']
    },
    'RUNTIME_PAYLOAD_METADATA_INVALID'
  )

  await rejected(
    'array-source-commit',
    async (_payloadRoot, _metadataPath, metadata) => {
      metadata.source.commit = [process.env.GITHUB_SHA]
    },
    'RUNTIME_PAYLOAD_METADATA_INVALID'
  )

  await rejected(
    'array-workflow-path',
    async (_payloadRoot, _metadataPath, metadata) => {
      metadata.source.workflowPath = ['.github/workflows/runtime-artifact-candidate.yml']
    },
    'RUNTIME_PAYLOAD_METADATA_INVALID'
  )

  await rejected(
    'array-source-ref',
    async (_payloadRoot, _metadataPath, metadata) => {
      metadata.source.ref = [process.env.GITHUB_REF]
    },
    'RUNTIME_PAYLOAD_METADATA_INVALID'
  )

  await rejected(
    'array-builder-node-version',
    async (_payloadRoot, _metadataPath, metadata) => {
      metadata.builder.nodeVersion = [process.version]
    },
    'RUNTIME_PAYLOAD_METADATA_INVALID'
  )

  await rejected(
    'array-builder-npm-version',
    async (_payloadRoot, _metadataPath, metadata) => {
      metadata.builder.npmVersion = ['10.9.4']
    },
    'RUNTIME_PAYLOAD_METADATA_INVALID'
  )

  await rejected(
    'array-source-run-id',
    async (_payloadRoot, _metadataPath, metadata) => {
      metadata.source.runId = [process.env.GITHUB_RUN_ID]
    },
    'RUNTIME_PAYLOAD_METADATA_INVALID'
  )

  await rejected(
    'out-of-schema-run-attempt',
    async (_payloadRoot, _metadataPath, metadata) => {
      metadata.source.attempt = 1001
    },
    'RUNTIME_PAYLOAD_METADATA_INVALID'
  )

  await rejected(
    'array-runtime-abi',
    async (_payloadRoot, _metadataPath, metadata) => {
      metadata.kind = 'runtime'
      metadata.target = { platform: 'darwin', arch: 'arm64' }
      metadata.runtime = {
        electronVersion: '43.6.0',
        nodeAbi: ['140'],
        napi: '10',
        chromiumVersion: '140.0.0.0',
        hostProtocol: 1
      }
      metadata.entrypoints = { 'parakeet-host': 'model/file.bin' }
      metadata.models = []
    },
    'RUNTIME_PAYLOAD_METADATA_INVALID'
  )

  await rejected(
    'array-upstream-digest',
    async (payloadRoot, _metadataPath, metadata) => {
      await createValidModelFiles(payloadRoot)
      metadata.upstream[0].digest.value = ['0'.repeat(64)]
    },
    'RUNTIME_PAYLOAD_UPSTREAM_RECEIPT_INVALID'
  )

  await rejected(
    'array-license-spdx',
    async (payloadRoot, _metadataPath, metadata) => {
      await createValidModelFiles(payloadRoot)
      metadata.licenses[0].spdx = ['MIT']
    },
    'RUNTIME_PAYLOAD_LICENSE_RECEIPT_INVALID'
  )

  await rejected(
    'oversized-license-notice',
    async (payloadRoot, _metadataPath, metadata) => {
      await createValidModelFiles(payloadRoot)
      metadata.licenses[0].noticeBytes = 20_000_001
    },
    'RUNTIME_PAYLOAD_LICENSE_RECEIPT_INVALID'
  )

  await positiveCandidate()
  process.stdout.write('RUNTIME_PAYLOAD_PUBLISHER_CASES_PASSED negative=20 positive=1\n')
} catch {
  process.stderr.write('RUNTIME_PAYLOAD_NEGATIVE_CASES_FAILED\n')
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true })
}
