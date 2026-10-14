#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { stopOwnedChild } from './owned-child-shutdown.mjs'

function fail(code) {
  throw new Error(code)
}

async function waitForReady(child) {
  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onMessage = (message) => {
      if (message?.type !== 'ready') return
      finish()
    }
    const onError = () => finish(new Error('RUNTIME_CHILD_TEST_SPAWN_FAILED'))
    const onExit = () => finish(new Error('RUNTIME_CHILD_TEST_EXITED_BEFORE_READY'))
    const timer = setTimeout(() => finish(new Error('RUNTIME_CHILD_TEST_READY_TIMEOUT')), 5_000)
    child.on('message', onMessage)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux')
    fail('RUNTIME_CHILD_TEST_ACTIONS_LINUX_ONLY')

  const missing = spawn('/__metis_runtime_candidate__/missing-server', [], { stdio: 'ignore' })
  const spawnStarted = Date.now()
  await stopOwnedChild(missing, { spawnMs: 2_000, termMs: 100, killMs: 100 })
  if (Date.now() - spawnStarted > 2_500 || missing.pid !== undefined)
    fail('RUNTIME_CHILD_TEST_SPAWN_FAILURE_NOT_BOUNDED')

  const resistant = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.send({ type: 'ready' }); setInterval(() => {}, 1000)"],
    { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  )
  let testError
  try {
    await waitForReady(resistant)
    const shutdownStarted = Date.now()
    await stopOwnedChild(resistant, { spawnMs: 2_000, termMs: 100, killMs: 1_500 })
    if (Date.now() - shutdownStarted > 2_000 || resistant.signalCode !== 'SIGKILL')
      fail('RUNTIME_CHILD_TEST_KILL_ESCALATION_FAILED')
  } catch (error) {
    testError = error
  } finally {
    try {
      await stopOwnedChild(resistant, { spawnMs: 2_000, termMs: 100, killMs: 1_500 })
    } catch (cleanupError) {
      if (!testError) testError = cleanupError
    }
  }
  if (testError) throw testError
  process.stdout.write('RUNTIME_CHILD_LIFECYCLE_NEGATIVES_PASSED\n')
}

main().catch((error) => {
  const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'RUNTIME_CHILD_LIFECYCLE_TEST_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
