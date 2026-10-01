/** Remote licence credentials travel only over TLS. Plain HTTP is for local development only. */
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '[::1]') return true
  const ipv4 = /^127\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  return !!ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255)
}

export function normalizeLicenseServerUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, '')
  if (!url || /^https?:\/\//i.test(url)) return url
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url
  let loopback = false
  try { loopback = isLoopbackHost(new URL(`http://${url}`).hostname) } catch { /* invalid URL stays invalid */ }
  return `${loopback ? 'http' : 'https'}://${url}`
}

export function isSecureLicenseServerUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))
  } catch {
    return false
  }
}
