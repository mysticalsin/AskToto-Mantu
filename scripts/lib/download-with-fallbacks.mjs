import { createWriteStream } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'

async function downloadOnce(url, dest, { get, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadOnce(new URL(res.headers.location, url).toString(), dest, { get, timeoutMs }).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`${url}: HTTP ${res.statusCode}`))
        return
      }
      pipeline(res, createWriteStream(dest)).then(resolve, reject)
    })
    req.on('timeout', () => req.destroy(new Error(`${url}: timed out after ${timeoutMs}ms`)))
    req.on('error', reject)
  })
}

export async function downloadWithFallbacks(urls, dest, options = {}) {
  const candidates = Array.isArray(urls) ? urls : [urls]
  const attempts = options.attempts ?? 2
  const retryDelayMs = options.retryDelayMs ?? 1_000
  const get = options.get ?? httpsGet
  const timeoutMs = options.timeoutMs ?? 60_000
  let lastError = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const url of candidates) {
      try {
        await downloadOnce(url, dest, { get, timeoutMs })
        return
      } catch (error) {
        lastError = error
      }
    }
    if (attempt < attempts) await delay(retryDelayMs)
  }

  throw lastError
}
