import { join } from 'node:path'

export function createAuthStoragePaths(userDataPath: () => string) {
  return Object.freeze({
    managedConfig: () => join(userDataPath(), 'managed-config.json'),
    session: () => join(userDataPath(), 'auth-session.bin'),
    stickyConfigured: () => join(userDataPath(), 'auth-configured.flag'),
    lkgConfig: () => join(userDataPath(), 'auth-lkg-config.json'),
    msalCache: () => join(userDataPath(), 'msal-cache.bin')
  })
}
