import { describe, expect, it, vi } from 'vitest'
import {
  buildAuditInsertStatement,
  buildSelectSql,
  buildUpdateStatement,
  chunk,
  decodeVaultKey,
  formatAuditDetail,
  keyBytesEqual,
  parseArgs,
  rewrapCiphertext,
  rewrapTable,
  runRewrap,
  sqlString
} from './rewrap.mjs'

function randomKeyB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

async function encryptWithKey(plaintext: string, keyB64: string): Promise<{ cipher: string; iv: string }> {
  const keyBytes = decodeVaultKey(keyB64, 'test key')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const cipherBytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)))
  const toB64 = (bytes: Uint8Array) => {
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin)
  }
  return { cipher: toB64(cipherBytes), iv: toB64(iv) }
}

describe('keyBytesEqual', () => {
  it('true for two identical byte arrays, false for any difference (including length)', () => {
    const a = decodeVaultKey(randomKeyB64(), 'a')
    const same = new Uint8Array(a)
    expect(keyBytesEqual(a, same)).toBe(true)
    const different = new Uint8Array(a)
    different[0] ^= 0xff
    expect(keyBytesEqual(a, different)).toBe(false)
    expect(keyBytesEqual(a, a.slice(0, 16))).toBe(false)
  })
})

describe('decodeVaultKey', () => {
  it('accepts a 32-byte base64 key', () => {
    const b64 = randomKeyB64()
    expect(decodeVaultKey(b64, 'X')).toHaveLength(32)
  })
  it('throws for a key that is not 32 bytes', () => {
    expect(() => decodeVaultKey(btoa('too short'), 'X')).toThrow(/32 bytes/)
  })
})

describe('rewrapCiphertext (real AES-256-GCM round trips)', () => {
  it('already-new: a row that decrypts with the new key is left untouched', async () => {
    const newKeyB64 = randomKeyB64()
    const oldKeyB64 = randomKeyB64()
    const row = await encryptWithKey('sk-live-secret', newKeyB64)
    const result = await rewrapCiphertext(row, decodeVaultKey(oldKeyB64, 'old'), decodeVaultKey(newKeyB64, 'new'))
    expect(result.status).toBe('already-new')
  })

  it('rewrapped: a row encrypted with the old key decrypts to the exact same plaintext under the new key', async () => {
    const oldKeyB64 = randomKeyB64()
    const newKeyB64 = randomKeyB64()
    const row = await encryptWithKey('sk-live-secret-xyz', oldKeyB64)
    const oldKeyBytes = decodeVaultKey(oldKeyB64, 'old')
    const newKeyBytes = decodeVaultKey(newKeyB64, 'new')
    const result = await rewrapCiphertext(row, oldKeyBytes, newKeyBytes)
    expect(result.status).toBe('rewrapped')
    // Round-trip proof: decrypting the NEW cipher with the NEW key returns the original plaintext.
    const key = await crypto.subtle.importKey('raw', newKeyBytes, 'AES-GCM', false, ['decrypt'])
    const bin = atob(result.iv!)
    const ivBytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) ivBytes[i] = bin.charCodeAt(i)
    const cbin = atob(result.cipher!)
    const cipherBytes = new Uint8Array(cbin.length)
    for (let i = 0; i < cbin.length; i++) cipherBytes[i] = cbin.charCodeAt(i)
    const plain = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, cipherBytes))
    expect(plain).toBe('sk-live-secret-xyz')
  })

  it('undecryptable: a row that decrypts with neither key is left untouched, never throws', async () => {
    const oldKeyB64 = randomKeyB64()
    const newKeyB64 = randomKeyB64()
    const thirdKeyB64 = randomKeyB64()
    const row = await encryptWithKey('orphaned', thirdKeyB64)
    const result = await rewrapCiphertext(row, decodeVaultKey(oldKeyB64, 'old'), decodeVaultKey(newKeyB64, 'new'))
    expect(result.status).toBe('undecryptable')
    expect(result.cipher).toBeUndefined()
  })
})

describe('SQL building (pure, no wrangler)', () => {
  it('sqlString doubles a single quote', () => {
    expect(sqlString("o'brien")).toBe("o''brien")
  })
  it('buildSelectSql only reads non-empty ciphertext', () => {
    expect(buildSelectSql('vault_keys')).toContain('cipher IS NOT NULL')
  })
  it('buildUpdateStatement escapes every interpolated value', () => {
    const stmt = buildUpdateStatement('vault_keys', "id'1", "c'2", "i'3")
    expect(stmt).toBe("UPDATE vault_keys SET cipher = 'c''2', iv = 'i''3' WHERE id = 'id''1';")
  })
  it('buildAuditInsertStatement never embeds a key or a plaintext, only counts text', () => {
    const stmt = buildAuditInsertStatement('audit-id', 1000, 'vault_keys 1 rewrapped/0 ok/0 failed')
    expect(stmt).toContain("'vault-rewrap'")
    expect(stmt).toContain('vault_keys 1 rewrapped')
  })
  it('chunk splits into groups of the given size, last group short', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
  it('formatAuditDetail summarises both tables', () => {
    const detail = formatAuditDetail({
      vault_keys: { total: 2, rewrapped: 1, alreadyOk: 1, failed: 0 },
      integrations: { total: 1, rewrapped: 0, alreadyOk: 0, failed: 1 }
    })
    expect(detail).toContain('vault_keys 1 rewrapped/1 ok/0 failed')
    expect(detail).toContain('integrations 0 rewrapped/0 ok/1 failed')
  })
})

describe('parseArgs', () => {
  it('reads --remote/--local, --dry-run, --env', () => {
    expect(parseArgs(['--remote'])).toMatchObject({ target: 'remote', dryRun: false, env: null })
    expect(parseArgs(['--local', '--dry-run'])).toMatchObject({ target: 'local', dryRun: true })
    expect(parseArgs(['--remote', '--env', 'staging'])).toMatchObject({ target: 'remote', env: 'staging' })
  })
})

describe('rewrapTable (fake exec, no wrangler/network)', () => {
  it('selects rows, batches an UPDATE per rewrapped row, and skips already-new/undecryptable rows', async () => {
    const oldKeyB64 = randomKeyB64()
    const newKeyB64 = randomKeyB64()
    const rewrapMe = await encryptWithKey('secret-a', oldKeyB64)
    const alreadyNew = await encryptWithKey('secret-b', newKeyB64)
    const selectResult = [{ id: 'row-rewrap', ...rewrapMe }, { id: 'row-ok', ...alreadyNew }]

    const exec = vi.fn((_cmd: string, args: string[]) => {
      if (args.includes('--json')) return JSON.stringify([{ results: selectResult }])
      return ''
    })

    const counts = await rewrapTable('vault_keys', {
      oldKeyBytes: decodeVaultKey(oldKeyB64, 'old'),
      newKeyBytes: decodeVaultKey(newKeyB64, 'new'),
      dryRun: false,
      databaseName: 'metis-operator',
      target: 'remote',
      envName: null,
      exec
    })

    expect(counts).toEqual({ total: 2, rewrapped: 1, alreadyOk: 1, failed: 0 })
    // One select call, one batch-file execute call (the single rewrapped row).
    const fileCalls = exec.mock.calls.filter(([, args]) => args.some((a: string) => a.startsWith('--file=')))
    expect(fileCalls).toHaveLength(1)
  })

  it('--dry-run never calls exec a second time to write anything', async () => {
    const oldKeyB64 = randomKeyB64()
    const newKeyB64 = randomKeyB64()
    const rewrapMe = await encryptWithKey('secret-a', oldKeyB64)
    const exec = vi.fn((_cmd: string, args: string[]) => {
      if (args.includes('--json')) return JSON.stringify([{ results: [{ id: 'row-1', ...rewrapMe }] }])
      throw new Error('should not write in dry-run')
    })
    const counts = await rewrapTable('integrations', {
      oldKeyBytes: decodeVaultKey(oldKeyB64, 'old'),
      newKeyBytes: decodeVaultKey(newKeyB64, 'new'),
      dryRun: true,
      databaseName: 'metis-operator',
      target: 'remote',
      envName: null,
      exec
    })
    expect(counts.rewrapped).toBe(1)
    expect(exec).toHaveBeenCalledTimes(1)
  })
})

describe('runRewrap (fake exec, no wrangler/network)', () => {
  it('throws when either key is missing from env', async () => {
    await expect(runRewrap({ args: { target: 'remote', dryRun: false, env: null }, env: {}, exec: vi.fn() })).rejects.toThrow(
      /OPERATOR_VAULT_KEY_OLD/
    )
  })

  it('refuses when OPERATOR_VAULT_KEY_OLD equals OPERATOR_VAULT_KEY byte for byte, before touching D1 (security review, medium)', async () => {
    const sameKeyB64 = randomKeyB64()
    const exec = vi.fn()
    await expect(
      runRewrap({
        args: { target: 'remote', dryRun: false, env: null },
        env: { OPERATOR_VAULT_KEY_OLD: sameKeyB64, OPERATOR_VAULT_KEY: sameKeyB64 },
        exec,
        log: () => {}
      })
    ).rejects.toThrow(/identical/)
    expect(exec).not.toHaveBeenCalled()
  })

  it('does not refuse when the two keys merely encode to the same length but differ in bytes', async () => {
    const oldKeyB64 = randomKeyB64()
    const newKeyB64 = randomKeyB64()
    const exec = vi.fn((_cmd: string, args: string[]) => (args.includes('--json') ? JSON.stringify([{ results: [] }]) : ''))
    await expect(
      runRewrap({
        args: { target: 'remote', dryRun: true, env: null },
        env: { OPERATOR_VAULT_KEY_OLD: oldKeyB64, OPERATOR_VAULT_KEY: newKeyB64 },
        exec,
        log: () => {}
      })
    ).resolves.toBeTruthy()
  })

  it('a real run writes one vault-rewrap audit row after both tables are processed; dry-run writes none', async () => {
    const oldKeyB64 = randomKeyB64()
    const newKeyB64 = randomKeyB64()
    const exec = vi.fn((_cmd: string, args: string[]) => {
      if (args.includes('--json')) return JSON.stringify([{ results: [] }])
      return ''
    })
    await runRewrap({
      args: { target: 'remote', dryRun: false, env: null },
      env: { OPERATOR_VAULT_KEY_OLD: oldKeyB64, OPERATOR_VAULT_KEY: newKeyB64 },
      exec,
      log: () => {}
    })
    const fileCalls = exec.mock.calls.filter(([, args]) => args.some((a: string) => a.startsWith('--file=')))
    expect(fileCalls).toHaveLength(1) // the audit insert batch (no rows to rewrap in either table)

    exec.mockClear()
    await runRewrap({
      args: { target: 'remote', dryRun: true, env: null },
      env: { OPERATOR_VAULT_KEY_OLD: oldKeyB64, OPERATOR_VAULT_KEY: newKeyB64 },
      exec,
      log: () => {}
    })
    const fileCallsDry = exec.mock.calls.filter(([, args]) => args.some((a: string) => a.startsWith('--file=')))
    expect(fileCallsDry).toHaveLength(0)
  })
})
