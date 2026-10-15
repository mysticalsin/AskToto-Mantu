import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

/** Run a diagnostic child and do not settle until its close event owns no resources. */
export function runDiagnosticChild(
  command,
  args,
  {
    cwd,
    timeoutMs = 30 * 60_000,
    maxOutputBytes = 2_000_000,
    redact = (value) => value,
    spawnImpl = spawn,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  } = {}
) {
  const started = performance.now()
  return new Promise((resolve, reject) => {
    let child
    let stdout = ''
    let stderr = ''
    let totalBytes = 0
    let timedOut = false
    let outputLimitExceeded = false
    let spawnError = null
    let failureReason = null
    let terminationRequested = false
    let closed = false
    let deadlineTimer = null
    let escalationTimer = null

    const requestTermination = () => {
      if (terminationRequested || closed || !child) return
      terminationRequested = true
      try {
        child.kill()
      } catch (error) {
        spawnError ??= error
      }
      escalationTimer = setTimeoutImpl(() => {
        if (closed) return
        try {
          child.kill('SIGKILL')
        } catch (error) {
          spawnError ??= error
        }
      }, 5000)
    }

    const append = (which) => (chunk) => {
      if (failureReason) return
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
      if (totalBytes + bytes > maxOutputBytes) {
        outputLimitExceeded = true
        failureReason = `Diagnostic child output exceeded ${maxOutputBytes} bytes`
        requestTermination()
        return
      }
      totalBytes += bytes
      if (which === 'stdout') stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      else stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    }

    try {
      child = spawnImpl(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      spawnError = error
      failureReason = `Command spawn failed: ${command}`
      const result = {
        command,
        args: [...args],
        cwd,
        exitCode: null,
        signal: null,
        elapsedMs: Math.round(performance.now() - started),
        stdout,
        stderr,
        timedOut: false,
        outputLimitExceeded: false,
        spawnError: redact(String(error?.message ?? error)).slice(0, 4000)
      }
      reject(Object.assign(new Error(failureReason), { result }))
      return
    }

    child.stdout?.on('data', append('stdout'))
    child.stderr?.on('data', append('stderr'))
    deadlineTimer = setTimeoutImpl(() => {
      if (closed || failureReason) return
      timedOut = true
      failureReason = `Command timed out: ${command}`
      requestTermination()
    }, timeoutMs)
    child.once('error', (error) => {
      spawnError ??= error
      failureReason ??= `Command spawn failed: ${command}`
      requestTermination()
    })
    child.once('close', (code, signal) => {
      closed = true
      clearTimeoutImpl(deadlineTimer)
      clearTimeoutImpl(escalationTimer)
      const result = {
        command,
        args: [...args],
        cwd,
        exitCode: code,
        signal,
        elapsedMs: Math.round(performance.now() - started),
        stdout: redact(stdout),
        stderr: redact(stderr),
        timedOut,
        outputLimitExceeded,
        ...(spawnError ? { spawnError: redact(String(spawnError.message ?? spawnError)).slice(0, 4000) } : {})
      }
      if (failureReason || spawnError || code !== 0) {
        const message = failureReason ?? `Command failed: ${command} (${code ?? signal})`
        reject(Object.assign(new Error(message), { result }))
      } else resolve(result)
    })
  })
}
