import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { getSettings, setSettings } from './store'
import { decryptSecret } from './secrets'

vi.mock('electron')

// A switch the tests flip to make ONLY settings.json unreadable, at the syscall boundary, the way a
// Windows AV/EDR lock or a broken ACL on a redirected %APPDATA% actually presents: readFileSync throws
// EPERM while the file is still very much there. Everything else (managed-config.json, secret-key.bin,
// key-*.bin, the .recovered sibling) reads normally, so the test isolates the one branch under audit.
const fsGate = vi.hoisted(() => ({ denySettingsRead: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync = (p: unknown, ...rest: unknown[]): unknown => {
    if (fsGate.denySettingsRead && typeof p === 'string' && p.endsWith('settings.json')) {
      const err = new Error(`EPERM: operation not permitted, open '${p}'`) as NodeJS.ErrnoException
      err.code = 'EPERM'
      err.syscall = 'open'
      err.path = p
      throw err
    }
    return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
  }
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})

// Mirrors store.ts's at-rest encoding so a test can read exactly what was persisted (V1 = safeStorage,
// V2 = AES-GCM file backend, which is what an unpackaged test run uses).
const ENC_V1 = Buffer.from('ATKENC1\n')
const ENC_V2 = Buffer.from('ATKENC2\n')
function readPersisted(path: string): Record<string, unknown> {
  const buf = readFileSync(path)
  if (buf.subarray(0, ENC_V2.length).equals(ENC_V2)) {
    return JSON.parse(decryptSecret(buf.subarray(ENC_V2.length)))
  }
  if (buf.subarray(0, ENC_V1.length).equals(ENC_V1)) {
    return JSON.parse(safeStorage.decryptString(buf.subarray(ENC_V1.length)))
  }
  return JSON.parse(buf.toString('utf8'))
}

const mockAppGetPath = app.getPath as ReturnType<typeof vi.fn>

describe('settings persistence (MQA-199 / MQA-200 / MQA-204)', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-settings-mqa-'))
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
    }
    mockAppGetPath.mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    fsGate.denySettingsRead = false
    rmSync(userData, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  // MQA-199 — a read that FAILED must never be treated as "the user has no settings".
  it('MQA-199: a settings write fails closed when the existing settings.json cannot be read, instead of erasing every persisted override', () => {
    setSettings({ meetingsFolder: 'D:/Meetings', suggestEverySec: 42, autoSuggest: true })

    fsGate.denySettingsRead = true
    // The one-key patch below merges onto readUserRaw(). With the read denied there is nothing to merge
    // onto, so the only honest outcome is to refuse the write — writing would replace the whole file.
    expect(() => setSettings({ autoSuggest: false })).toThrow(/read/i)
    fsGate.denySettingsRead = false

    const raw = readPersisted(join(userData, 'settings.json'))
    expect(raw.meetingsFolder).toBe('D:/Meetings')
    expect(raw.suggestEverySec).toBe(42)
  })

  // MQA-199 — the defaults served while the file is unreadable must not be memoised: the live file's
  // mtime never changed, so a cached snapshot would outlive the lock and look like a wiped profile.
  it('MQA-199: settings served while settings.json is unreadable are never cached as "this user has no settings"', () => {
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ suggestEverySec: 42 }), 'utf8')

    fsGate.denySettingsRead = true
    expect(getSettings().suggestEverySec).toBe(DEFAULT_SETTINGS.suggestEverySec)
    fsGate.denySettingsRead = false

    // Nothing touched the file, so its mtime is identical — only a skipped cache write lets the real
    // value come back once the transient lock clears.
    expect(getSettings().suggestEverySec).toBe(42)
  })

  // MQA-200 — '' is the codebase's unbind sentinel (resolveShortcut uses ??, registerShortcuts skips
  // falsy), so the schema must accept it or Settings' "Clear" button is a silent no-op.
  it("MQA-200: clearing a keyboard shortcut persists '' instead of silently keeping the old binding", () => {
    setSettings({ shortcuts: { capture: 'CommandOrControl+Shift+K' } })

    const after = setSettings({ shortcuts: { capture: '' } })
    expect(after.shortcuts.capture).toBe('')

    const raw = readPersisted(join(userData, 'settings.json'))
    expect((raw.shortcuts as Record<string, string>).capture).toBe('')
  })

  // MQA-200 — "Reset to default" for the five actions whose shipped default IS '' writes that same
  // empty value, so it has to survive validation too.
  it("MQA-200: resetting an action whose shipped default is '' unbinds it", () => {
    setSettings({ shortcuts: { explain: 'CommandOrControl+Shift+E', capture: 'CommandOrControl+Shift+K' } })

    const after = setSettings({ shortcuts: { explain: '', capture: 'CommandOrControl+Shift+K' } })
    expect(after.shortcuts.explain).toBe('')
    // The sibling binding in the same record must survive — a single empty value used to fail the whole
    // record and drop every shortcut in the patch.
    expect(after.shortcuts.capture).toBe('CommandOrControl+Shift+K')
  })

  // MQA-204 — org policy has to win over a legacy-field migration, not the other way round.
  it('MQA-204: a locked mcpConnections is not overwritten by the legacy BidStack migration', () => {
    const managedConnection = {
      id: 'plane',
      kind: 'plane',
      label: 'Plane',
      endpointUrl: 'https://plane.corp.example/mcp',
      connected: true,
      tools: [],
      extraHeaders: {}
    }
    writeFileSync(
      join(userData, 'managed-config.json'),
      JSON.stringify({ mcpConnections: [managedConnection], locked: ['mcpConnections'] }),
      'utf8'
    )
    // An in-place upgrade from a pre-v1.5.4 build: the legacy single-connection fields are still on
    // disk and no mcpConnections key was ever persisted.
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ bidstackEndpointUrl: 'https://bidstack-old.internal/mcp', bidstackConnected: true }),
      'utf8'
    )

    expect(getSettings().mcpConnections).toEqual([managedConnection])
  })

  it('MQA-204: the legacy BidStack migration still runs when mcpConnections is not locked', () => {
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ bidstackEndpointUrl: 'https://bidstack-old.internal/mcp', bidstackConnected: true }),
      'utf8'
    )

    expect(getSettings().mcpConnections).toEqual([
      {
        id: 'bidstack',
        kind: 'bidstack',
        label: 'Polo Pre-Sales',
        endpointUrl: 'https://bidstack-old.internal/mcp',
        connected: true,
        tools: [],
        extraHeaders: {}
      }
    ])
  })
})
