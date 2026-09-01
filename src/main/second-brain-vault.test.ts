import { describe, expect, it } from 'vitest'
import { join, win32 } from 'node:path'
import {
  AI_SECOND_BRAIN_VAULT_NAME,
  DUST_VAULT_INBOX_REL,
  candidateVaultPaths,
  createSecondBrainVault,
  detectSecondBrainVault,
  dustInboxPath,
  normalizeVaultPath,
  preferredCreatePath,
  type PathKind,
  type SecondBrainEnv,
  type VaultFs
} from './second-brain-vault'
import { DEFAULT_SETTINGS, SettingsSchema } from '@shared/ipc'

function env(partial: Partial<SecondBrainEnv> = {}): SecondBrainEnv {
  return {
    home: '/Users/tony',
    documents: '/Users/tony/Documents',
    oneDriveRoots: [],
    cloudStorage: '/Users/tony/Library/CloudStorage',
    ...partial
  }
}

/** Fixtures stay POSIX; path.join on win32 uses `\`. Look up by normalized separators. */
function memFs(map: Record<string, PathKind | string[]>): VaultFs {
  const normalized = Object.fromEntries(
    Object.entries(map).map(([k, v]) => [normalizeVaultPath(k), v])
  )
  return {
    inspect(path: string) {
      const hit = normalized[normalizeVaultPath(path)]
      if (Array.isArray(hit)) return { kind: 'dir', names: hit }
      if (hit === 'dir') return { kind: 'dir', names: [] }
      if (hit === 'offline') return { kind: 'offline' }
      if (hit === 'file') return { kind: 'file' }
      return { kind: 'absent' }
    }
  }
}

function expectPath(actual: string | undefined, posix: string): void {
  expect(actual === undefined ? actual : normalizeVaultPath(actual)).toBe(normalizeVaultPath(posix))
}

describe('second-brain vault paths', () => {
  it('names the Obsidian vault AI Second Brain and Dust inbox 00_Inbox/from-dust', () => {
    expect(AI_SECOND_BRAIN_VAULT_NAME).toBe('AI Second Brain')
    expect(DUST_VAULT_INBOX_REL).toBe('00_Inbox/from-dust')
    expect(dustInboxPath('/vault')).toBe(join('/vault', '00_Inbox', 'from-dust'))
  })

  it('probes CloudStorage OneDrive-*/Documents, OneDrive Documents, then ~/Documents', () => {
    const paths = candidateVaultPaths(
      env({ oneDriveRoots: ['/Users/tony/OneDrive'] }),
      ['/Users/tony/Library/CloudStorage/OneDrive-Mantu']
    )
    expectPath(
      paths[0],
      '/Users/tony/Library/CloudStorage/OneDrive-Mantu/Documents/AI Second Brain'
    )
    expect(paths.map(normalizeVaultPath)).toContain(
      normalizeVaultPath('/Users/tony/OneDrive/Documents/AI Second Brain')
    )
    expect(paths.map(normalizeVaultPath)).toContain(
      normalizeVaultPath('/Users/tony/OneDrive/AI Second Brain')
    )
    expectPath(paths[paths.length - 1], '/Users/tony/Documents/AI Second Brain')
  })

  it('prefers OneDrive Documents for create when OneDrive is present', () => {
    expectPath(
      preferredCreatePath(env({ oneDriveRoots: ['/Users/tony/OneDrive'] }), []),
      '/Users/tony/OneDrive/Documents/AI Second Brain'
    )
    expectPath(
      preferredCreatePath(env(), ['/Users/tony/Library/CloudStorage/OneDrive-Personal']),
      '/Users/tony/Library/CloudStorage/OneDrive-Personal/Documents/AI Second Brain'
    )
    expectPath(preferredCreatePath(env(), []), '/Users/tony/Documents/AI Second Brain')
  })

  it('treats slash and backslash as the same vault path', () => {
    expect(normalizeVaultPath('\\Users\\tony\\OneDrive\\Documents\\AI Second Brain')).toBe(
      normalizeVaultPath('/Users/tony/OneDrive/Documents/AI Second Brain')
    )
    const posix = '/Users/tony/Documents/AI Second Brain'
    const fs = memFs({ [posix]: 'dir' })
    expect(fs.inspect(win32.join('/Users/tony/Documents', 'AI Second Brain')).kind).toBe('dir')
  })
})

describe('detectSecondBrainVault', () => {
  it('uses an existing CloudStorage vault as the single source of truth', () => {
    const vault = '/Users/tony/Library/CloudStorage/OneDrive-Mantu/Documents/AI Second Brain'
    const r = detectSecondBrainVault(
      env(),
      memFs({
        '/Users/tony/Library/CloudStorage': ['OneDrive-Mantu'],
        '/Users/tony/Library/CloudStorage/OneDrive-Mantu': ['Documents'],
        [vault]: 'dir'
      })
    )
    expect(r.status).toBe('found')
    expectPath(r.path, vault)
  })

  it('finds ~/Documents/AI Second Brain when OneDrive is not installed', () => {
    const r = detectSecondBrainVault(
      env(),
      memFs({
        '/Users/tony/Library/CloudStorage': 'absent',
        '/Users/tony/Documents/AI Second Brain': 'dir'
      })
    )
    expect(r.status).toBe('found')
    expectPath(r.path, '/Users/tony/Documents/AI Second Brain')
  })

  it('does not require .obsidian inside the folder', () => {
    const r = detectSecondBrainVault(
      env({ oneDriveRoots: ['/Users/tony/OneDrive'] }),
      memFs({
        '/Users/tony/Library/CloudStorage': 'absent',
        '/Users/tony/OneDrive': ['Documents'],
        '/Users/tony/OneDrive/Documents': ['AI Second Brain'],
        '/Users/tony/OneDrive/Documents/AI Second Brain': 'dir'
      })
    )
    expect(r.status).toBe('found')
    expectPath(r.path, '/Users/tony/OneDrive/Documents/AI Second Brain')
  })

  it('returns not-found plus a typical create path when the vault is absent and OneDrive is readable', () => {
    const r = detectSecondBrainVault(
      env({ oneDriveRoots: ['/Users/tony/OneDrive'] }),
      memFs({
        '/Users/tony/Library/CloudStorage': 'absent',
        '/Users/tony/OneDrive': ['Documents'],
        '/Users/tony/OneDrive/Documents': ['Other']
      })
    )
    expect(r.status).toBe('not-found')
    expect(r.path).toBeUndefined()
    expectPath(r.suggestedPath, '/Users/tony/OneDrive/Documents/AI Second Brain')
  })

  it('returns offline when CloudStorage exists but cannot be listed (do not fake a vault)', () => {
    const r = detectSecondBrainVault(env(), memFs({ '/Users/tony/Library/CloudStorage': 'offline' }))
    expect(r.status).toBe('offline')
    expect(r.path).toBeUndefined()
    expect(r.reason).toMatch(/OneDrive is not available/)
  })

  it('returns offline when the vault path is a OneDrive placeholder, not not-found-so-create', () => {
    const vault = '/Users/tony/OneDrive/Documents/AI Second Brain'
    const r = detectSecondBrainVault(
      env({ oneDriveRoots: ['/Users/tony/OneDrive'] }),
      memFs({
        '/Users/tony/Library/CloudStorage': 'absent',
        '/Users/tony/OneDrive': ['Documents'],
        '/Users/tony/OneDrive/Documents': ['AI Second Brain'],
        [vault]: 'offline'
      })
    )
    expect(r.status).toBe('offline')
    expect(r.path).toBeUndefined()
  })

  it('skips OneDrive-SharedLibraries when a personal OneDrive root exists', () => {
    const personal = '/Users/tony/Library/CloudStorage/OneDrive-Mantu/Documents/AI Second Brain'
    const r = detectSecondBrainVault(
      env(),
      memFs({
        '/Users/tony/Library/CloudStorage': ['OneDrive-SharedLibraries-Mantu', 'OneDrive-Mantu'],
        [personal]: 'dir'
      })
    )
    expect(r.status).toBe('found')
    expectPath(r.path, personal)
  })
})

describe('createSecondBrainVault', () => {
  it('creates the vault and the Dust inbox, never a competing name', () => {
    const made: string[] = []
    const r = createSecondBrainVault('/Users/tony/Documents/AI Second Brain', {
      mkdir: (p) => {
        made.push(p)
      }
    })
    expect(r.ok).toBe(true)
    if (r.ok) expectPath(r.path, '/Users/tony/Documents/AI Second Brain')
    expectPath(made[0], '/Users/tony/Documents/AI Second Brain')
    expectPath(made[1], join('/Users/tony/Documents/AI Second Brain', '00_Inbox', 'from-dust'))
    expect(made.join(' ')).not.toMatch(/Métis Second Brain|Metis Second Brain/)
  })

  it('refuses to mkdir when OneDrive is offline', () => {
    const r = createSecondBrainVault('/Users/tony/OneDrive/Documents/AI Second Brain', {
      mkdir: () => {
        const err = new Error('offline') as Error & { code: string }
        err.code = 'ENOTCONN'
        throw err
      }
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe('offline')
      expect(r.reason).toMatch(/OneDrive is not available/)
    }
  })
})

describe('Dust write-in default ON (schema lock)', () => {
  it('dustWriteToVault defaults true; publishBrainPages stays the existing false lock', () => {
    expect(DEFAULT_SETTINGS.dustWriteToVault).toBe(true)
    expect(SettingsSchema.parse(DEFAULT_SETTINGS).dustWriteToVault).toBe(true)
    const { dustWriteToVault: _omit, ...without } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(without).dustWriteToVault).toBe(true)
    expect(DEFAULT_SETTINGS.publishBrainPages).toBe(false)
    expect(SettingsSchema.parse(DEFAULT_SETTINGS).publishBrainPages).toBe(false)
  })

  it('does not invent a Reagan product setting', () => {
    expect(DEFAULT_SETTINGS).not.toHaveProperty('reagan')
    expect(DEFAULT_SETTINGS).not.toHaveProperty('reaganWriter')
    expect(JSON.stringify(DEFAULT_SETTINGS)).not.toMatch(/reagan/i)
  })
})
