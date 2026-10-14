#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const temporary = await mkdtemp(resolve(tmpdir(), 'metis-runtime-attestation-fixture-'))
const payloadRoot = resolve(temporary, 'payload')
const output = resolve(temporary, 'candidate')
const metadataPath = resolve(temporary, 'metadata.json')
const artifactId = 'runtime.attestation-fixture'
const notice = Buffer.from(
  'Synthetic provenance-verification fixture only. It contains no runtime, model, or third-party files.\n',
  'utf8'
)
const model = Buffer.from('synthetic fixture bytes; not a model\n', 'utf8')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

try {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('RUNTIME_FIXTURE_ACTIONS_ONLY')
  const workflow = /^mysticalsin\/AskToto-Mantu\/([a-z0-9./-]+\.yml)@/.exec(process.env.GITHUB_WORKFLOW_REF ?? '')
  if (!workflow) throw new Error('RUNTIME_FIXTURE_WORKFLOW_IDENTITY_INVALID')
  const lock = JSON.parse(await readFile(resolve(repository, 'package-lock.json'), 'utf8'))
  const electron = lock.packages?.['node_modules/electron']?.version
  if (typeof electron !== 'string') throw new Error('RUNTIME_FIXTURE_LOCK_INVALID')

  await mkdir(resolve(payloadRoot, 'model'), { recursive: true })
  await writeFile(resolve(payloadRoot, 'model', 'fixture.onnx'), model, { flag: 'wx', mode: 0o600 })
  await writeFile(resolve(payloadRoot, 'model', 'NOTICE.txt'), notice, { flag: 'wx', mode: 0o600 })

  const sourceUri = `https://github.com/mysticalsin/AskToto-Mantu/blob/${process.env.GITHUB_SHA}/scripts/runtime-payload/create-attestation-fixture.mjs`
  const metadata = {
    schemaVersion: 1,
    kind: 'model',
    componentId: 'model.test-fixture',
    artifactId,
    target: { platform: 'any', arch: 'any' },
    runtime: null,
    entrypoints: {},
    directories: {},
    models: [{ id: 'speaker.embedding', root: 'model', members: ['model/fixture.onnx'] }],
    source: {
      repositoryUri: 'https://github.com/mysticalsin/AskToto-Mantu',
      commit: process.env.GITHUB_SHA,
      workflowPath: workflow[1],
      workflowCommit: process.env.GITHUB_WORKFLOW_SHA,
      runId: process.env.GITHUB_RUN_ID,
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      lockSha256: sha256(await readFile(resolve(repository, 'package-lock.json'))),
      ref: process.env.GITHUB_REF,
      runnerEnvironment: process.env.RUNNER_ENVIRONMENT
    },
    builder: {
      nodeVersion: process.version,
      npmVersion: spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(),
      zlibVersion: process.versions.zlib,
      packages: [{ name: 'electron', version: electron }]
    },
    upstream: [
      {
        name: 'synthetic provenance-verification fixture',
        version: '1',
        sourceUri,
        revision: process.env.GITHUB_SHA,
        digest: { algorithm: 'sha256', value: sha256(model) }
      }
    ],
    licenses: [
      {
        package: 'synthetic provenance-verification fixture',
        version: '1',
        spdx: 'NOASSERTION',
        sourceUri,
        noticePath: 'model/NOTICE.txt',
        noticeBytes: notice.length,
        noticeSha256: sha256(notice),
        sourceReceiptUri: sourceUri
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
      output
    ],
    { encoding: 'utf8', env: process.env, timeout: 60_000 }
  )
  if (build.error || build.status !== 0) {
    process.stderr.write(build.stderr || 'RUNTIME_FIXTURE_BUILDER_FAILED\n')
    throw new Error('RUNTIME_FIXTURE_BUILDER_FAILED')
  }
  process.stdout.write(build.stdout)
  const artifactDirectory = process.env.RUNTIME_FIXTURE_OUTPUT
  if (!artifactDirectory) throw new Error('RUNTIME_FIXTURE_OUTPUT_MISSING')
  await mkdir(artifactDirectory, { recursive: true })
  for (const filename of [`${artifactId}.tar.gz`, `${artifactId}.inventory.json`, 'candidate.json']) {
    const bytes = await readFile(resolve(output, filename))
    await writeFile(resolve(artifactDirectory, filename), bytes, { flag: 'wx', mode: 0o600 })
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
