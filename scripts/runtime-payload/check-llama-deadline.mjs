#!/usr/bin/env node
import assert from 'node:assert/strict'
import { assertBeforeDeadline } from './candidate-deadline.mjs'

function fail(code) {
  throw new Error(code)
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux')
    fail('RUNTIME_DEADLINE_TEST_ACTIONS_LINUX_ONLY')
  const fastDeadline = performance.now() + 1_000
  assert.doesNotThrow(() => assertBeforeDeadline(fastDeadline))

  const lateDeadline = performance.now() + 25
  await new Promise((resolve) => setTimeout(resolve, 50))
  const lateValidResponse = { ok: true, text: 'valid-shaped inference response' }
  assert.equal(lateValidResponse.ok, true)
  assert.throws(() => assertBeforeDeadline(lateDeadline), {
    message: 'RUNTIME_LLAMA_INFERENCE_TIMEOUT'
  })
  process.stdout.write('RUNTIME_LLAMA_DEADLINE_NEGATIVES_PASSED\n')
}

main().catch((error) => {
  const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'RUNTIME_LLAMA_DEADLINE_TEST_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
