import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keepBothName, nameKey, planDestination, validateExportName, writeTimeCheck } from './export-destination'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'export-dest-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('validateExportName', () => {
  it.each(['CON', 'con.md', 'NUL.txt', 'COM1', 'lpt9.pdf', 'Aux'])('refuses reserved Windows name %s on win32', (n) => {
    expect(validateExportName(n, 'win32')).toMatch(/reserved/i)
  })
  it('allows a reserved-looking name on linux/darwin but not as a path separator', () => {
    expect(validateExportName('CON.md', 'linux')).toBeNull()
    expect(validateExportName('a/b.md', 'darwin')).not.toBeNull()
    expect(validateExportName('a\\b.md', 'win32')).not.toBeNull()
  })
  it('refuses trailing dot or space, illegal characters and control characters on win32', () => {
    expect(validateExportName('x.md.', 'win32')).not.toBeNull()
    expect(validateExportName('x.md ', 'win32')).not.toBeNull()
    expect(validateExportName('a:b.md', 'win32')).not.toBeNull()
    expect(validateExportName('a\u0001b.md', 'darwin')).not.toBeNull()
  })
  it('refuses empty, dot and dotdot names', () => {
    for (const n of ['', '.', '..']) expect(validateExportName(n, 'linux')).not.toBeNull()
  })
})

describe('nameKey', () => {
  it('folds case and Unicode normalisation on darwin and win32 only', () => {
    const nfc = 'café.md'
    const nfd = 'café.MD'
    expect(nameKey(nfc, 'darwin')).toBe(nameKey(nfd, 'darwin'))
    expect(nameKey(nfc, 'win32')).toBe(nameKey(nfd, 'win32'))
    expect(nameKey(nfc, 'linux')).not.toBe(nameKey(nfd, 'linux'))
  })
})

describe('keepBothName', () => {
  it('suffixes before the extension and skips taken names, case-insensitively on win32', () => {
    expect(keepBothName('Recap.md', ['Recap.md', 'RECAP (2).md'], 'win32', false)).toBe('Recap (3).md')
    expect(keepBothName('Recap.md', ['Recap.md'], 'linux', false)).toBe('Recap (2).md')
    expect(keepBothName('bundle', ['bundle'], 'linux', true)).toBe('bundle (2)')
    expect(keepBothName('.hidden', ['.hidden'], 'linux', false)).toBe('.hidden (2)')
  })
})

describe('planDestination', () => {
  it('plans a free destination with the resolved absolute directory', async () => {
    const plan = await planDestination(join(dir, 'a.md'), { platform: process.platform })
    if ('refused' in plan) throw new Error(plan.refused)
    expect(plan.existing).toBeNull()
    expect(plan.name).toBe('a.md')
    expect(plan.destination.endsWith('a.md')).toBe(true)
  })
  it('detects a case and normalisation variant as a conflict on darwin', async () => {
    await writeFile(join(dir, 'café.md'), 'x')
    const plan = await planDestination(join(dir, 'CAFÉ.md'), { platform: 'darwin' })
    if ('refused' in plan) throw new Error(plan.refused)
    expect(plan.existing?.name).toBe('café.md')
  })
  it('does not treat a case variant as a conflict on linux', async () => {
    await writeFile(join(dir, 'a.md'), 'x')
    const plan = await planDestination(join(dir, 'A.md'), { platform: 'linux' })
    if ('refused' in plan) throw new Error(plan.refused)
    expect(plan.existing).toBeNull()
  })
  it('refuses a missing folder, a relative path and a reserved name', async () => {
    expect(await planDestination(join(dir, 'nope', 'a.md'), { platform: 'linux' })).toHaveProperty('refused')
    expect(await planDestination('a.md', { platform: 'linux' })).toHaveProperty('refused')
    expect(await planDestination(join(dir, 'NUL.md'), { platform: 'win32' })).toHaveProperty('refused')
  })
  it('refuses a symlink at the target and a directory at a file target', async () => {
    await writeFile(join(dir, 'real.md'), 'x')
    await symlink(join(dir, 'real.md'), join(dir, 'link.md'))
    await mkdir(join(dir, 'folder.md'))
    expect(await planDestination(join(dir, 'link.md'), { platform: 'linux' })).toHaveProperty('refused')
    expect(await planDestination(join(dir, 'folder.md'), { platform: 'linux' })).toHaveProperty('refused')
  })
  it('resolves a symlinked chosen folder to its real directory so the preview shows where bytes land', async () => {
    const real = join(dir, 'real')
    await mkdir(real)
    await symlink(real, join(dir, 'alias'))
    const plan = await planDestination(join(dir, 'alias', 'a.md'), { platform: 'linux' })
    if ('refused' in plan) throw new Error(plan.refused)
    expect(plan.destination.includes('alias')).toBe(false)
  })
})

describe('writeTimeCheck (TOCTOU)', () => {
  it('refuses when a file appears after a conflict-free preview', async () => {
    const plan = await planDestination(join(dir, 'a.md'), { platform: 'linux' })
    if ('refused' in plan) throw new Error(plan.refused)
    await writeFile(join(dir, 'a.md'), 'appeared')
    expect(() => writeTimeCheck(plan, plan.name, 'none', 'linux')).toThrow(/appeared|exists/i)
  })
  it('refuses keep-both when the suffixed name was taken meanwhile', async () => {
    await writeFile(join(dir, 'a.md'), 'x')
    const plan = await planDestination(join(dir, 'a.md'), { platform: 'linux' })
    if ('refused' in plan) throw new Error(plan.refused)
    await writeFile(join(dir, 'a (2).md'), 'y')
    expect(() => writeTimeCheck(plan, 'a (2).md', 'keep-both', 'linux')).toThrow()
  })
  it('refuses replace when the existing file changed since the preview', async () => {
    await writeFile(join(dir, 'a.md'), 'x')
    const plan = await planDestination(join(dir, 'a.md'), { platform: 'linux' })
    if ('refused' in plan) throw new Error(plan.refused)
    expect(() => writeTimeCheck(plan, plan.name, 'replace', 'linux')).not.toThrow()
    await writeFile(join(dir, 'a.md'), 'changed by someone else, different size')
    expect(() => writeTimeCheck(plan, plan.name, 'replace', 'linux')).toThrow(/changed/i)
  })
})
