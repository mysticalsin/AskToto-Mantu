import { get as httpsGet } from 'node:https'
import { createWriteStream, renameSync, rmSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_BACKOFF_BASE_MS = 1_000

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isClientError(error) {
  return /HTTP 4\d\d/.test(error?.message ?? '')
}

function fetchStream(url, { requestGet, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = requestGet(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        fetchStream(new URL(res.headers.location, url).toString(), { requestGet, timeoutMs }).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`${url}: HTTP ${res.statusCode}`))
        return
      }
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new Error(`request timeout after ${timeoutMs}ms for ${url}`)))
    req.on('error', reject)
  })
}

export async function download(
  url,
  dest,
  {
    requestGet = httpsGet,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    sleep = delay,
    log = process.stdout.write.bind(process.stdout)
  } = {}
) {
  const part = `${dest}.part`
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetchStream(url, { requestGet, timeoutMs })
      await pipeline(res, createWriteStream(part))
      rmSync(dest, { force: true })
      renameSync(part, dest)
      return
    } catch (error) {
      lastError = error
      rmSync(part, { force: true })
      if (attempt >= maxAttempts || isClientError(error)) break
      const backoffMs = backoffBaseMs * 2 ** (attempt - 1)
      log(`[retry ${attempt}/${maxAttempts - 1}] ${error?.message ?? error}; waiting ${backoffMs}ms\n`)
      await sleep(backoffMs)
    }
  }
  throw lastError
}
