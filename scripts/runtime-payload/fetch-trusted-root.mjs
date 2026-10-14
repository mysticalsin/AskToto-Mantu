#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { initTUF } from '@sigstore/tuf'
import { TrustedRoot } from '@sigstore/protobuf-specs'

async function run() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('RUNTIME_TRUST_ROOT_ACTIONS_ONLY')
  const runnerTemp = process.env.RUNNER_TEMP
  if (!runnerTemp) throw new Error('RUNTIME_TRUST_ROOT_OUTPUT_UNAVAILABLE')

  const outputPath = resolve(process.argv[2] ?? resolve(runnerTemp, 'metis-runtime-trust/sigstore-trusted-root.json'))
  const outputRelative = relative(resolve(runnerTemp), outputPath)
  if (!outputRelative || outputRelative === '..' || outputRelative.startsWith(`..${sep}`)) {
    throw new Error('RUNTIME_TRUST_ROOT_OUTPUT_OUTSIDE_TEMP')
  }

  const cachePath = resolve(runnerTemp, 'sigstore-tuf-cache')
  const client = await initTUF({
    cachePath,
    mirrorURL: 'https://tuf-repo-cdn.sigstore.dev',
    forceInit: true,
    forceCache: false,
    timeout: 15_000,
    retry: { retries: 2 }
  })
  const raw = await client.getTarget('trusted_root.json')
  const bytes = Buffer.from(raw, 'utf8')
  if (bytes.length === 0 || bytes.length > 2_000_000) throw new Error('RUNTIME_TRUST_ROOT_SIZE_REJECTED')

  TrustedRoot.fromJSON(JSON.parse(raw))
  const digest = createHash('sha256').update(bytes).digest('hex')
  const lock = await readFile(new URL('../../package-lock.json', import.meta.url))
  const receipt = {
    schemaVersion: 1,
    source: 'https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json',
    verifiedBy: { package: '@sigstore/tuf', version: '5.0.0' },
    sourceCommit: process.env.GITHUB_SHA,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    workflowCommit: process.env.GITHUB_WORKFLOW_SHA,
    runId: process.env.GITHUB_RUN_ID,
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    lockSha256: createHash('sha256').update(lock).digest('hex'),
    rootBytes: bytes.length,
    rootSha256: digest
  }
  if (!/^[a-f0-9]{40}$/.test(receipt.sourceCommit ?? '') || !/^[a-f0-9]{40}$/.test(receipt.workflowCommit ?? '')) {
    throw new Error('RUNTIME_TRUST_ROOT_SOURCE_IDENTITY_UNAVAILABLE')
  }
  if (!/^\d{1,20}$/.test(receipt.runId ?? '') || !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1) {
    throw new Error('RUNTIME_TRUST_ROOT_RUN_IDENTITY_UNAVAILABLE')
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 })
  await writeFile(resolve(dirname(outputPath), 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600
  })
  process.stdout.write(`RUNTIME_TRUST_ROOT_READY bytes=${bytes.length} sha256=${digest}\n`)
}

run().catch(() => {
  process.stderr.write('RUNTIME_TRUST_ROOT_FAILED\n')
  process.exitCode = 1
})
