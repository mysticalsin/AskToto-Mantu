import { describe, expect, it } from 'vitest'
import azureSignHook from './azure-sign-hook.cjs'

const { signWithArtifactSigning, buildSigningScript, selectedEnvironment, resolvePowerShell } = azureSignHook as {
  signWithArtifactSigning: (filePath: string, options?: Record<string, unknown>) => Promise<boolean>
  buildSigningScript: (options: Record<string, string>) => string
  selectedEnvironment: (env: Record<string, string | undefined>) => Record<string, string>
  resolvePowerShell: (spawnImpl: (...args: unknown[]) => { error?: unknown; status?: number | null }) => string
}

const AZURE_ENV = {
  WIN_AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
  WIN_AZURE_SIGNING_ACCOUNT: 'test-account',
  WIN_AZURE_CERT_PROFILE: 'test-profile',
  ARTIFACT_SIGNING_MODULE_PATH: 'C:\\runner-temp\\artifact-signing\\0.1.20\\ArtifactSigning.psd1'
}

function fakeSpawnOk() {
  const calls: unknown[][] = []
  const spawnImpl = (...args: unknown[]) => {
    calls.push(args)
    return { error: undefined, status: 0, stdout: 'ignored PowerShell noise', stderr: '' }
  }
  return { calls, spawnImpl }
}

describe('azure-sign-hook: sign(configuration) — the electron-builder entry point', () => {
  it('refuses to sign on a non-Windows host without touching the filesystem or spawning anything', async () => {
    if (process.platform === 'win32') return // covered by the runIf smoke test below instead
    await expect(azureSignHook({ path: 'C:\\build\\Metis-Setup.exe' })).rejects.toThrow(
      'AZURE_SIGN_HOOK_UNSUPPORTED_PLATFORM'
    )
  })

  it.runIf(process.platform === 'win32')(
    'fails closed with no Azure signing input configured, before spawning PowerShell',
    async () => {
      const names = ['WIN_AZURE_SIGNING_ENDPOINT', 'WIN_AZURE_SIGNING_ACCOUNT', 'WIN_AZURE_CERT_PROFILE', 'ARTIFACT_SIGNING_MODULE_PATH']
      const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
      for (const name of names) delete process.env[name]
      try {
        await expect(azureSignHook({ path: 'C:\\build\\Metis-Setup.exe' })).rejects.toThrow(
          /^AZURE_SIGN_HOOK_ENV_MISSING:/
        )
      } finally {
        for (const name of names) {
          if (previous[name] === undefined) delete process.env[name]
          else process.env[name] = previous[name]
        }
      }
    }
  )

  it('rejects a configuration with no file path, on this host\'s own platform check ordering', async () => {
    // Whichever branch runs first (platform or path) on this host, the result is always a fixed,
    // non-empty AZURE_SIGN_HOOK_* code — never a raw TypeError from reading `.path`.
    await expect(azureSignHook({})).rejects.toThrow(/^AZURE_SIGN_HOOK_/)
    await expect(azureSignHook(undefined)).rejects.toThrow(/^AZURE_SIGN_HOOK_/)
  })
})

describe('azure-sign-hook: signWithArtifactSigning — PowerShell command construction', () => {
  it('spawns the resolved shell as a bare argv array (no shell:true, no string command) with a bounded timeout', async () => {
    const { calls, spawnImpl } = fakeSpawnOk()
    const ok = await signWithArtifactSigning('C:\\build\\Metis-Setup.exe', {
      env: AZURE_ENV, platform: 'win32', spawnImpl, timeoutMs: 42_000
    })
    expect(ok).toBe(true)
    // First call is the pwsh.exe probe, second is the real signing invocation.
    expect(calls).toHaveLength(2)
    const [shell, args, options] = calls[1] as [string, string[], Record<string, unknown>]
    expect(['pwsh.exe', 'powershell.exe']).toContain(shell)
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(args).toHaveLength(4)
    expect(options.shell).toBe(false)
    expect(options.timeout).toBe(42_000)
    expect(options.windowsHide).toBe(true)
  })

  it('never interpolates the file path, endpoint, account or module path into a shell string outside a single-quoted PowerShell literal', async () => {
    const { calls, spawnImpl } = fakeSpawnOk()
    await signWithArtifactSigning("C:\\build\\Metis's Setup.exe", { env: AZURE_ENV, platform: 'win32', spawnImpl })
    const script = (calls[1] as [string, string[]])[1][3]
    // PowerShell single-quote literal escaping: an embedded ' becomes ''.
    expect(script).toContain("-Files 'C:\\build\\Metis''s Setup.exe'")
    expect(script).toContain(`-Endpoint '${AZURE_ENV.WIN_AZURE_SIGNING_ENDPOINT}'`)
    expect(script).toContain(`-CodeSigningAccountName '${AZURE_ENV.WIN_AZURE_SIGNING_ACCOUNT}'`)
    expect(script).toContain(`-CertificateProfileName '${AZURE_ENV.WIN_AZURE_CERT_PROFILE}'`)
  })

  it('imports the module only from ARTIFACT_SIGNING_MODULE_PATH, and never references PSGallery', async () => {
    const { calls, spawnImpl } = fakeSpawnOk()
    await signWithArtifactSigning('C:\\build\\Metis-Setup.exe', { env: AZURE_ENV, platform: 'win32', spawnImpl })
    const script = (calls[1] as [string, string[]])[1][3]
    expect(script).toContain(`Import-Module '${AZURE_ENV.ARTIFACT_SIGNING_MODULE_PATH}' -Force -ErrorAction Stop`)
    expect(script).not.toMatch(/PSGallery|Install-Module|Install-PackageProvider/)
  })

  it('sets FileDigest, timestamp digest and the fixed Microsoft timestamp authority', async () => {
    const { calls, spawnImpl } = fakeSpawnOk()
    await signWithArtifactSigning('C:\\build\\Metis-Setup.exe', { env: AZURE_ENV, platform: 'win32', spawnImpl })
    const script = (calls[1] as [string, string[]])[1][3]
    expect(script).toContain('-FileDigest SHA256')
    expect(script).toContain('-TimestampDigest SHA256')
    expect(script).toContain("-TimestampRfc3161 'http://timestamp.acs.microsoft.com'")
  })

  it('excludes every DefaultAzureCredential source except AzureCliCredential, the one azure/login (OIDC) leaves behind', async () => {
    const { calls, spawnImpl } = fakeSpawnOk()
    await signWithArtifactSigning('C:\\build\\Metis-Setup.exe', { env: AZURE_ENV, platform: 'win32', spawnImpl })
    const script = (calls[1] as [string, string[]])[1][3]
    for (const excluded of [
      'ExcludeEnvironmentCredential', 'ExcludeWorkloadIdentityCredential', 'ExcludeManagedIdentityCredential',
      'ExcludeSharedTokenCacheCredential', 'ExcludeVisualStudioCredential', 'ExcludeVisualStudioCodeCredential',
      'ExcludeAzurePowerShellCredential', 'ExcludeAzureDeveloperCliCredential', 'ExcludeInteractiveBrowserCredential'
    ]) {
      expect(script).toContain(`-${excluded}`)
    }
    expect(script).not.toContain('ExcludeAzureCliCredential')
  })

  it('rejects on any missing required environment variable, naming only the variable', async () => {
    for (const name of ['WIN_AZURE_SIGNING_ENDPOINT', 'WIN_AZURE_SIGNING_ACCOUNT', 'WIN_AZURE_CERT_PROFILE', 'ARTIFACT_SIGNING_MODULE_PATH']) {
      const { spawnImpl } = fakeSpawnOk()
      const env = { ...AZURE_ENV, [name]: '' }
      await expect(
        signWithArtifactSigning('C:\\build\\Metis-Setup.exe', { env, platform: 'win32', spawnImpl })
      ).rejects.toThrow(`AZURE_SIGN_HOOK_ENV_MISSING:${name}`)
    }
  })

  it('turns a spawn timeout into a fixed code, never the raw child_process error', async () => {
    const spawnImpl = () => ({ error: { code: 'ETIMEDOUT' }, status: null })
    await expect(
      signWithArtifactSigning('C:\\build\\Metis-Setup.exe', { env: AZURE_ENV, platform: 'win32', spawnImpl })
    ).rejects.toThrow('AZURE_SIGN_HOOK_TIMEOUT')
  })

  it('turns any other spawn failure into a fixed code', async () => {
    const spawnImpl = () => ({ error: { code: 'ENOENT' }, status: null })
    await expect(
      signWithArtifactSigning('C:\\build\\Metis-Setup.exe', { env: AZURE_ENV, platform: 'win32', spawnImpl })
    ).rejects.toThrow('AZURE_SIGN_HOOK_SPAWN_FAILED')
  })

  it('turns a non-zero PowerShell exit into a fixed code plus only the exit status, never native stdout/stderr', async () => {
    const spawnImpl = () => ({
      error: undefined, status: 1,
      stdout: 'Az.Identity: EnvironmentCredential failed for tenant 11111111-2222-3333-4444-555555555555',
      stderr: 'a raw DefaultAzureCredential probe error naming a subscription id'
    })
    await expect(
      signWithArtifactSigning('C:\\build\\Metis-Setup.exe', { env: AZURE_ENV, platform: 'win32', spawnImpl })
    ).rejects.toThrow('AZURE_SIGN_HOOK_FAILED:1')
    try {
      await signWithArtifactSigning('C:\\build\\Metis-Setup.exe', { env: AZURE_ENV, platform: 'win32', spawnImpl })
    } catch (error) {
      expect((error as Error).message).not.toMatch(/tenant|subscription|EnvironmentCredential/)
    }
  })

  it('refuses to run on a non-Windows platform even when every input is otherwise valid', async () => {
    await expect(
      signWithArtifactSigning('C:\\build\\Metis-Setup.exe', { env: AZURE_ENV, platform: 'darwin', spawnImpl: fakeSpawnOk().spawnImpl })
    ).rejects.toThrow('AZURE_SIGN_HOOK_UNSUPPORTED_PLATFORM')
  })

  it('refuses a missing or empty file path', async () => {
    await expect(
      signWithArtifactSigning('', { env: AZURE_ENV, platform: 'win32', spawnImpl: fakeSpawnOk().spawnImpl })
    ).rejects.toThrow('AZURE_SIGN_HOOK_NO_FILE')
  })
})

describe('azure-sign-hook: environment and shell selection', () => {
  it('never forwards an AZURE_* credential variable to the PowerShell child, even if one is present in-process', () => {
    const selected = selectedEnvironment({
      PATH: '/usr/bin', SystemRoot: 'C:\\Windows',
      AZURE_CLIENT_ID: 'leaked-client-id', AZURE_TENANT_ID: 'leaked-tenant-id',
      AZURE_CLIENT_SECRET: 'leaked-secret', AZURE_FEDERATED_TOKEN_FILE: '/leaked/token/path'
    })
    for (const forbidden of ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_FEDERATED_TOKEN_FILE']) {
      expect(selected).not.toHaveProperty(forbidden)
    }
    expect(selected.PATH).toBe('/usr/bin')
  })

  it('prefers pwsh.exe when it is available, and falls back to powershell.exe otherwise', () => {
    expect(resolvePowerShell(() => ({ error: undefined, status: 0 }))).toBe('pwsh.exe')
    expect(resolvePowerShell(() => ({ error: undefined, status: 1 }))).toBe('powershell.exe')
    expect(resolvePowerShell(() => ({ error: { code: 'ENOENT' }, status: null }))).toBe('powershell.exe')
  })

  it('restricts the pwsh.exe availability probe\'s own environment the same way the real signing call is restricted', () => {
    let seenEnv: Record<string, string> | undefined
    resolvePowerShell((_file: string, _args: string[], options: { env: Record<string, string> }) => {
      seenEnv = options.env
      return { error: undefined, status: 0 }
    }, { PATH: '/usr/bin', AZURE_CLIENT_SECRET: 'leaked-secret' })
    expect(seenEnv).not.toHaveProperty('AZURE_CLIENT_SECRET')
    expect(seenEnv?.PATH).toBe('/usr/bin')
  })

  it('quotes a single quote in the signing script the same way the rest of this repo quotes PowerShell literals', () => {
    const script = buildSigningScript({
      endpoint: AZURE_ENV.WIN_AZURE_SIGNING_ENDPOINT,
      account: AZURE_ENV.WIN_AZURE_SIGNING_ACCOUNT,
      certificateProfile: AZURE_ENV.WIN_AZURE_CERT_PROFILE,
      modulePath: AZURE_ENV.ARTIFACT_SIGNING_MODULE_PATH,
      filePath: "C:\\It's\\Metis-Setup.exe"
    })
    expect(script).toContain("'C:\\It''s\\Metis-Setup.exe'")
  })
})
