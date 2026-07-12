import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

export interface NetworkDenyGuard {
  attempts(): number
  denyRemoteModelResolver(): never
  restore(): void
}

interface ElectronNetLike {
  fetch?: unknown
  request?: unknown
}

interface NetworkDenyOptions {
  electronNet?: ElectronNetLike
}

interface PatchedFunction {
  target: object
  key: string
  descriptor: PropertyDescriptor | undefined
}

let activeGuard: NetworkDenyGuard | undefined

export function installNetworkDeny(options: NetworkDenyOptions = {}): NetworkDenyGuard {
  if (activeGuard) return activeGuard

  let attemptCount = 0
  let restored = false
  const deny = (..._arguments: unknown[]): never => {
    attemptCount += 1
    throw new Error('LOCAL_AI_NETWORK_DISABLED')
  }
  const patches: PatchedFunction[] = [
    { target: globalThis, key: 'fetch', descriptor: Object.getOwnPropertyDescriptor(globalThis, 'fetch') },
    { target: http, key: 'request', descriptor: Object.getOwnPropertyDescriptor(http, 'request') },
    { target: http, key: 'get', descriptor: Object.getOwnPropertyDescriptor(http, 'get') },
    { target: https, key: 'request', descriptor: Object.getOwnPropertyDescriptor(https, 'request') },
    { target: https, key: 'get', descriptor: Object.getOwnPropertyDescriptor(https, 'get') },
    { target: http2, key: 'connect', descriptor: Object.getOwnPropertyDescriptor(http2, 'connect') },
    { target: net, key: 'connect', descriptor: Object.getOwnPropertyDescriptor(net, 'connect') },
    {
      target: net,
      key: 'createConnection',
      descriptor: Object.getOwnPropertyDescriptor(net, 'createConnection')
    },
    { target: tls, key: 'connect', descriptor: Object.getOwnPropertyDescriptor(tls, 'connect') },
    ...(options.electronNet
      ? (['fetch', 'request'] as const).map((key) => ({
          target: options.electronNet as object,
          key,
          descriptor: Object.getOwnPropertyDescriptor(options.electronNet as object, key)
        }))
      : [])
  ]

  for (const { target, key, descriptor } of patches) {
    Object.defineProperty(target, key, {
      ...(descriptor ?? { configurable: true, enumerable: true, writable: true }),
      value: deny
    })
  }

  const guard: NetworkDenyGuard = {
    attempts: () => attemptCount,
    denyRemoteModelResolver: deny,
    restore: () => {
      if (restored) return
      restored = true
      for (const { target, key, descriptor } of patches) {
        if (descriptor) Object.defineProperty(target, key, descriptor)
        else Reflect.deleteProperty(target, key)
      }
      if (activeGuard === guard) activeGuard = undefined
    }
  }
  activeGuard = guard
  return guard
}
