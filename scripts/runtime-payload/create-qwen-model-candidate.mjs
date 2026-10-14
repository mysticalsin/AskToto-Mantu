#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCAL_MODEL_ASSETS, LOCAL_MODEL_ID, LOCAL_MODEL_LICENSE } from '../local-model-assets.mjs'
import { REPO_ROOT } from '../local-model-assets.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = process.env.RUNTIME_CANDIDATE_OUTPUT
const MODEL_REVISION = '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0'
const MODEL_REPOSITORY = 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function fail(code) {
  throw new Error(code)
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function requireActionIdentity() {
  const workflow = /^mysticalsin\/AskToto-Mantu\/([a-z0-9./-]+\.yml)@/.exec(process.env.GITHUB_WORKFLOW_REF ?? '')
  if (process.env.GITHUB_ACTIONS !== 'true' || !output || !workflow) fail('RUNTIME_QWEN_ACTION_CONTEXT_INVALID')
  if (
    !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ||
    !/^[a-f0-9]{40}$/.test(process.env.GITHUB_WORKFLOW_SHA ?? '')
  )
    fail('RUNTIME_QWEN_SOURCE_IDENTITY_INVALID')
  if (!/^[0-9]{1,20}$/.test(process.env.GITHUB_RUN_ID ?? '')) fail('RUNTIME_QWEN_RUN_IDENTITY_INVALID')
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT)
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1000) fail('RUNTIME_QWEN_RUN_IDENTITY_INVALID')
  if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') fail('RUNTIME_QWEN_RUNNER_NOT_HOSTED')
  return { workflowPath: workflow[1], attempt }
}

async function verifyPinnedSource(path, expected, label) {
  const actual = await stat(path)
  if (actual.size !== expected.bytes || (await hashFile(path)) !== expected.sha256)
    fail(`RUNTIME_QWEN_${label}_PIN_MISMATCH`)
}

async function main() {
  const identity = requireActionIdentity()
  if (LOCAL_MODEL_ID !== 'qwen3.5-0.8b' || LOCAL_MODEL_ASSETS.length !== 2) fail('RUNTIME_QWEN_MODEL_PIN_INVALID')
  const lockBytes = await readFile(resolve(repository, 'package-lock.json'))
  const lock = JSON.parse(lockBytes.toString('utf8'))
  const electronVersion = lock.packages?.['node_modules/electron']?.version
  if (electronVersion !== '43.6.0') fail('RUNTIME_QWEN_ELECTRON_LOCK_INVALID')

  const temporary = await mkdtemp(resolve(tmpdir(), 'metis-qwen-model-candidate-'))
  const payloadRoot = resolve(temporary, 'payload')
  const modelRoot = resolve(payloadRoot, 'models', LOCAL_MODEL_ID)
  const licensePath = resolve(payloadRoot, 'licenses/QWEN3.5-APACHE-2.0.txt')
  const candidateOutput = resolve(temporary, 'candidate')
  const metadataPath = resolve(temporary, 'metadata.json')
  try {
    await mkdir(modelRoot, { recursive: true })
    await mkdir(dirname(licensePath), { recursive: true })
    for (const asset of LOCAL_MODEL_ASSETS) {
      const source = resolve(REPO_ROOT, 'resources/local-llm/models', LOCAL_MODEL_ID, asset.file)
      await verifyPinnedSource(source, asset, asset.file === 'model.gguf' ? 'MODEL' : 'PROJECTOR')
      await copyFile(source, resolve(modelRoot, asset.file))
    }
    await verifyPinnedSource(LOCAL_MODEL_LICENSE.path, LOCAL_MODEL_LICENSE, 'LICENSE')
    await copyFile(LOCAL_MODEL_LICENSE.path, licensePath)

    const sourceCommit = process.env.GITHUB_SHA
    const licenseNoticeBytes = LOCAL_MODEL_LICENSE.bytes
    const licenseNoticeSha256 = LOCAL_MODEL_LICENSE.sha256
    const metadata = {
      schemaVersion: 1,
      kind: 'model',
      componentId: 'model.qwen3.5-0.8b',
      artifactId: 'model.qwen3.5-0.8b',
      target: { platform: 'any', arch: 'any' },
      runtime: null,
      entrypoints: {},
      directories: {},
      models: [
        {
          id: 'qwen3.5-0.8b',
          root: `models/${LOCAL_MODEL_ID}`,
          members: LOCAL_MODEL_ASSETS.map((asset) => `models/${LOCAL_MODEL_ID}/${asset.file}`)
        }
      ],
      source: {
        repositoryUri: 'https://github.com/mysticalsin/AskToto-Mantu',
        commit: sourceCommit,
        workflowPath: identity.workflowPath,
        workflowCommit: process.env.GITHUB_WORKFLOW_SHA,
        runId: process.env.GITHUB_RUN_ID,
        attempt: identity.attempt,
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
      upstream: LOCAL_MODEL_ASSETS.map((asset) => ({
        name: `Qwen3.5 0.8B ${asset.file}`,
        version: MODEL_REVISION,
        sourceUri: asset.url,
        revision: MODEL_REVISION,
        digest: { algorithm: 'sha256', value: asset.sha256 }
      })),
      licenses: [
        {
          package: 'Qwen3.5-0.8B-GGUF',
          version: MODEL_REVISION,
          spdx: 'Apache-2.0',
          sourceUri: MODEL_REPOSITORY,
          noticePath: 'licenses/QWEN3.5-APACHE-2.0.txt',
          noticeBytes: licenseNoticeBytes,
          noticeSha256: licenseNoticeSha256,
          sourceReceiptUri: `https://github.com/mysticalsin/AskToto-Mantu/blob/${sourceCommit}/resources/local-llm/LICENSE.QWEN3.5-APACHE-2.0.txt`
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
      { encoding: 'utf8', env: process.env, timeout: 180_000 }
    )
    if (build.error || build.status !== 0) fail('RUNTIME_QWEN_PAYLOAD_BUILD_FAILED')
    const candidate = JSON.parse(await readFile(resolve(candidateOutput, 'candidate.json'), 'utf8'))
    if (
      candidate.kind !== 'model' ||
      candidate.artifactId !== 'model.qwen3.5-0.8b' ||
      candidate.payloadBytes !==
        LOCAL_MODEL_ASSETS.reduce((total, asset) => total + asset.bytes, LOCAL_MODEL_LICENSE.bytes)
    )
      fail('RUNTIME_QWEN_CANDIDATE_INVALID')
    await mkdir(output, { recursive: true })
    for (const filename of [candidate.archive.path, candidate.inventory.path, 'candidate.json']) {
      await writeFile(resolve(output, filename), await readFile(resolve(candidateOutput, filename)), {
        flag: 'wx',
        mode: 0o600
      })
    }
    process.stdout.write(
      `RUNTIME_QWEN_MODEL_CANDIDATE_READY files=${candidate.payloadFiles} bytes=${candidate.payloadBytes} archiveSha256=${candidate.archive.sha256} inventorySha256=${candidate.inventory.sha256}\n`
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

main().catch((error) => {
  const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'RUNTIME_QWEN_MODEL_CANDIDATE_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
