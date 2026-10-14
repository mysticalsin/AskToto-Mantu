#!/usr/bin/env node
import assert from 'node:assert/strict'
import { assertBeforeDeadline, readInferenceResponse } from './candidate-deadline.mjs'

function fail(code) {
  throw new Error(code)
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux')
    fail('RUNTIME_DEADLINE_TEST_ACTIONS_LINUX_ONLY')
  const fastDeadline = performance.now() + 1_000
  assert.doesNotThrow(() => assertBeforeDeadline(fastDeadline))

  const lateFetchDeadline = performance.now() + 25
  await assert.rejects(
    readInferenceResponse(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'ready' } }] }) }
      },
      'http://127.0.0.1:1/v1/chat/completions',
      {},
      lateFetchDeadline
    ),
    { message: 'RUNTIME_LLAMA_INFERENCE_TIMEOUT' }
  )
  const lateJsonDeadline = performance.now() + 25
  await assert.rejects(
    readInferenceResponse(
      async () => ({
        ok: true,
        json: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return { choices: [{ message: { content: 'ready' } }] }
        }
      }),
      'http://127.0.0.1:1/v1/chat/completions',
      {},
      lateJsonDeadline
    ),
    { message: 'RUNTIME_LLAMA_INFERENCE_TIMEOUT' }
  )
  process.stdout.write('RUNTIME_LLAMA_DEADLINE_NEGATIVES_PASSED\n')
}

main().catch((error) => {
  const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'RUNTIME_LLAMA_DEADLINE_TEST_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
