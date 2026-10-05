import { createWriteStream, renameSync, statSync, unlinkSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { get as httpsGet } from 'node:https'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_RESPONSE_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_BASE_MS = 1_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fetchStream(url, { requestGet, requestTimeoutMs }) {
  return new Promise((resolve, reject) => {
    let timeout
    const req = requestGet(url, { timeout: requestTimeoutMs }, (res) => {
      clearTimeout(timeout)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        fetchStream(next, { requestGet, requestTimeoutMs }).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`${url}: HTTP ${res.statusCode}`))
        return
      }
      resolve(res)
    })
    timeout = setTimeout(() => {
      req.destroy(new Error(`request timeout after ${requestTimeoutMs}ms for ${url}`))
    }, requestTimeoutMs)
    req.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

export async function downloadFile(
  url,
  dest,
  {
    requestGet = httpsGet,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    responseIdleTimeoutMs = DEFAULT_RESPONSE_IDLE_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS
  } = {}
) {
  await mkdir(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchStream(url, { requestGet, requestTimeoutMs })
      const total = Number(res.headers['content-length'] || 0)
      const out = createWriteStream(part)
      res.setTimeout(responseIdleTimeoutMs, () => {
        res.destroy(new Error(`response idle timeout after ${responseIdleTimeoutMs}ms for ${url}`))
      })
      await pipeline(res, out)
      if (res.socket) res.setTimeout(0)
      const size = statSync(part).size
      if (total && size !== total) throw new Error(`incomplete download: got ${size} of ${total} bytes`)
      renameSync(part, dest)
      return
    } catch (error) {
      lastError = error
      try {
        unlinkSync(part)
      } catch {
        /* .part may not exist */
      }
      const clientError = /HTTP 4\d\d/.test(error?.message ?? '')
      if (attempt < maxAttempts && !clientError) {
        const backoffMs = backoffBaseMs * 2 ** (attempt - 1)
        console.log(`  [retry ${attempt}/${maxAttempts - 1}] ${error?.message ?? error}; waiting ${backoffMs}ms`)
        await sleep(backoffMs)
        continue
      }
      break
    }
  }

  throw lastError
}
