import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from '@azure/msal-common'

/**
 * MSAL's network transport on the main-process `fetch`. MSAL's default client opens raw `https.request`
 * sockets, which the egress guard (egress-guard.ts) never sees; this one resolves `fetch` on every call, so
 * it always goes through whatever `globalThis.fetch` is at that moment: the guarded one under a managed
 * `egressAllowlist`, and the proxy-aware dispatcher either way.
 */
export function createGuardedNetworkClient(getFetch: () => typeof fetch = () => globalThis.fetch): INetworkModule {
  const send = async <T>(method: 'GET' | 'POST', url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> => {
    const response = await getFetch()(url, { method, headers: options?.headers, body: options?.body })
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    const text = await response.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      // Non-JSON error pages reach MSAL as text, as its own client does.
    }
    return { headers, body: body as T, status: response.status }
  }
  return {
    sendGetRequestAsync: (url, options) => send('GET', url, options),
    sendPostRequestAsync: (url, options) => send('POST', url, options)
  }
}
