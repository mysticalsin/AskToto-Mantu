export interface AzureConfig {
  clientId: string
  tenantId: string
  allowedDomain: string
}

export function createAuthLocalConfigState(deps: {
  userDataPath: () => string
  joinPath: (...parts: string[]) => string
  exists: (path: string) => boolean
  readText: (path: string) => string
  writeText: (path: string, value: string) => void
  remove: (path: string) => void
}): {
  writeStickyConfigured: () => void
  clearStickyConfigured: () => void
  isStickyConfigured: () => boolean
  writeLkgConfig: (config: AzureConfig) => void
  readLkgConfig: () => Partial<AzureConfig>
  clearLkgConfig: () => void
} {
  const stickyPath = (): string => deps.joinPath(deps.userDataPath(), 'auth-configured.flag')
  const lkgPath = (): string => deps.joinPath(deps.userDataPath(), 'auth-lkg-config.json')

  return {
    writeStickyConfigured() {
      const path = stickyPath()
      if (!deps.exists(path)) {
        try {
          deps.writeText(path, '1')
        } catch {
          /* best-effort */
        }
      }
    },
    clearStickyConfigured() {
      try {
        const path = stickyPath()
        if (deps.exists(path)) deps.remove(path)
      } catch {
        /* best-effort */
      }
    },
    isStickyConfigured() {
      try {
        return deps.exists(stickyPath())
      } catch {
        return false
      }
    },
    writeLkgConfig(config) {
      try {
        deps.writeText(
          lkgPath(),
          JSON.stringify({ clientId: config.clientId, tenantId: config.tenantId, allowedDomain: config.allowedDomain })
        )
      } catch {
        /* best-effort: without it, recovery falls back to Settings/managed config */
      }
    },
    readLkgConfig() {
      try {
        const record = JSON.parse(deps.readText(lkgPath()))
        const clientId = String(record?.clientId || '').trim()
        const tenantId = String(record?.tenantId || '').trim()
        const allowedDomain = String(record?.allowedDomain || '')
          .trim()
          .replace(/^@/, '')
        if (clientId && tenantId && allowedDomain) return { clientId, tenantId, allowedDomain }
      } catch {
        /* absent, unreadable or malformed */
      }
      return {}
    },
    clearLkgConfig() {
      try {
        const path = lkgPath()
        if (deps.exists(path)) deps.remove(path)
      } catch {
        /* best-effort */
      }
    }
  }
}
