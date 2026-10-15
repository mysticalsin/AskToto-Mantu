import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type ChildReport = {
  kind: 'success'
  blockingReadWithheld: true
  blockingReadReleased: true
  controlByte: 0x5a
  refusal: 'RUNTIME_ARCHIVE_SHAPE_MISMATCH'
  payloadBytes: 0
}

type ChildMessage = ChildReport | { kind: 'failure'; reason: string }

function deadline<T>(promise: Promise<T>, label: string, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), milliseconds)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

describe('Windows runtime archive named-pipe refusal', () => {
  it('proves a real blocking pipe read, then rejects the held pipe before payload reads', async () => {
    expect(process.platform).toBe('win32')
    const endpoint = `\\\\.\\pipe\\metis-runtime-archive-${randomUUID()}`
    const childPath = fileURLToPath(new URL('./runtime-archive.windows-pipe-child.ts', import.meta.url))
    const child: ChildProcess = spawn(
      process.execPath,
      ['--experimental-strip-types', '--experimental-default-type=module', childPath, endpoint],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true
      }
    )
    const childStderr: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => childStderr.push(chunk))
    let messageResolve!: (message: ChildMessage) => void
    const messagePromise = new Promise<ChildMessage>((resolve) => {
      messageResolve = resolve
    })
    child.on('message', (message) => messageResolve(message as ChildMessage))
    let spawnFailure: Error | undefined
    child.on('error', (error) => {
      spawnFailure = error
      messageResolve({ kind: 'failure', reason: 'named-pipe child could not start' })
    })
    let closeResolve!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void
    const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      closeResolve = resolve
    })
    child.once('close', (code, signal) => closeResolve({ code, signal }))
    let joined = false
    try {
      const messageOrPrematureClose = await deadline(
        Promise.race([
          messagePromise,
          closePromise.then((result) => {
            throw new Error(
              `named-pipe child exited before its completion report: code=${result.code} signal=${result.signal}`
            )
          })
        ]),
        'owned named-pipe child report',
        35_000
      )
      if (messageOrPrematureClose.kind !== 'success')
        throw new Error(`owned named-pipe child failed: ${messageOrPrematureClose.reason}`)

      const exit = await deadline(closePromise, 'owned named-pipe child exit', 5_000)
      joined = true
      expect(spawnFailure).toBeUndefined()
      expect(exit.code, `owned child stderr: ${Buffer.concat(childStderr).toString('utf8')}`).toBe(0)
      expect(exit.signal).toBeNull()
      expect(messageOrPrematureClose).toEqual({
        kind: 'success',
        blockingReadWithheld: true,
        blockingReadReleased: true,
        controlByte: 0x5a,
        refusal: 'RUNTIME_ARCHIVE_SHAPE_MISMATCH',
        payloadBytes: 0
      } satisfies ChildReport)
    } finally {
      if (!joined) {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill()
          } catch {
            // A concurrent exit is joined below; process termination is the cleanup barrier.
          }
        }
        await closePromise
        joined = true
      }
    }
  }, 45_000)
})
