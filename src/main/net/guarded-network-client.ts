import type { INetworkModule } from '@azure/msal-node'

type SendOptions = Parameters<INetworkModule['sendGetRequestAsync']>[1]
interface SendResult<T> {
  headers: Record<string, string>
  body: T
  status: number
}

/**
 * MSAL's network transport on the main-process `fetch`. MSAL's default client opens raw `https.request`
 * sockets, which the egress guard (egress-guard.ts) never sees; this one resolves `fetch` on every call, so
 * it always goes through whatever `globalThis.fetch` is at that moment: the guarded one under a managed
 * `egressAllowlist`, and the proxy-aware dispatcher either way. Like MSAL's own client it returns any HTTP
 * status as a response (MSAL classifies errors from status and body) and honors the optional timeout.
 */
export function createGuardedNetworkClient(getFetch: () => typeof fetch = () => globalThis.fetch): INetworkModule {
  const send = async <T>(method: 'GET' | 'POST', url: string, options?: SendOptions, timeout?: number): Promise<SendResult<T>> => {
    const response = await getFetch()(url, {
      method,
      headers: options?.headers,
      body: options?.body,
      signal: timeout ? AbortSignal.timeout(timeout) : undefined
    })
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
    sendGetRequestAsync: <T>(url: string, options?: SendOptions, timeout?: number) => send<T>('GET', url, options, timeout),
    sendPostRequestAsync: <T>(url: string, options?: SendOptions, timeout?: number) => send<T>('POST', url, options, timeout)
  }
}
