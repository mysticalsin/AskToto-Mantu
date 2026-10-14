import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync, unlinkSync, writeFileSync as writeFileSyncNow } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalPrivateTemporaryRoot,
  captureElectronFactoryTemplate,
  electronFactoryArchiveMemberPath,
  electronFactoryArchivePath,
  electronFactoryTemplatePath,
  removeElectronDefaultAppTemplate
} from './lean-package-stage.mjs'

const roots: string[] = []

async function fixture() {
  const root = canonicalPrivateTemporaryRoot(await mkdtemp(join(tmpdir(), 'metis-lean-package-')))
  roots.push(root)
  const resources = join(root, 'resources')
  const electronDist = join(root, 'electron-dist')
  await Promise.all([mkdir(resources), mkdir(electronDist)])
  return { resources, electronDist }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('lean package factory template cleanup', () => {
  it('removes only the byte-identical Electron default app from packaged resources', async () => {
    const { resources, electronDist } = await fixture()
    const template = Buffer.from('owned Electron factory template')
    const templatePath = electronFactoryTemplatePath(electronDist, 'win32')
    await mkdir(join(electronDist, 'resources'))
    await Promise.all([writeFile(join(resources, 'default_app.asar'), template), writeFile(templatePath, template)])

    await expect(removeElectronDefaultAppTemplate(resources, templatePath)).resolves.toBe(true)
    await expect(readFile(join(resources, 'default_app.asar'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves absent or byte-different resources untouched and rejects links', async () => {
    const { resources, electronDist } = await fixture()
    await expect(removeElectronDefaultAppTemplate(resources, electronDist)).resolves.toBe(false)

    const packaged = join(resources, 'default_app.asar')
    const template = electronFactoryTemplatePath(electronDist, 'win32')
    await mkdir(join(electronDist, 'resources'))
    await Promise.all([writeFile(packaged, 'unknown resource'), writeFile(template, 'factory template')])
    await expect(removeElectronDefaultAppTemplate(resources, template)).rejects.toThrow(/differs/)
    await expect(readFile(packaged, 'utf8')).resolves.toBe('unknown resource')

    await rm(packaged)
    await symlink(template, packaged)
    await expect(removeElectronDefaultAppTemplate(resources, template)).rejects.toThrow(/ELOOP|regular file/)
    await expect(readFile(packaged)).resolves.toEqual(await readFile(template))
  })

  it('preserves a replacement installed after byte comparison and before unlink', async () => {
    const { resources, electronDist } = await fixture()
    const packaged = join(resources, 'default_app.asar')
    const template = electronFactoryTemplatePath(electronDist, 'win32')
    await mkdir(join(electronDist, 'resources'))
    await Promise.all([writeFile(packaged, 'factory bytes'), writeFile(template, 'factory bytes')])

    await expect(
      removeElectronDefaultAppTemplate(resources, template, () => {
        unlinkSync(packaged)
        writeFileSyncNow(packaged, 'foreign replacement')
      })
    ).rejects.toThrow(/namespace changed|changed before cleanup/)
    await expect(readFile(packaged, 'utf8')).resolves.toBe('foreign replacement')
  })

  it('binds deletion to the template FD captured before a path substitution', async () => {
    const { resources, electronDist } = await fixture()
    const packaged = join(resources, 'default_app.asar')
    const template = electronFactoryTemplatePath(electronDist, 'darwin')
    await mkdir(join(electronDist, 'Electron.app', 'Contents', 'Resources'), { recursive: true })
    await Promise.all([writeFile(packaged, 'factory bytes'), writeFile(template, 'factory bytes')])
    const ticket = await captureElectronFactoryTemplate(
      template,
      undefined,
      createHash('sha256').update('factory bytes').digest('hex')
    )
    unlinkSync(template)
    writeFileSyncNow(template, 'foreign replacement')
    try {
      await expect(removeElectronDefaultAppTemplate(resources, ticket)).rejects.toThrow(
        /changed before cleanup|namespace changed/
      )
      await expect(readFile(packaged, 'utf8')).resolves.toBe('factory bytes')
    } finally {
      await ticket.handle.close()
    }
  })

  it('rejects a held-template mutation after admission instead of adopting its new bytes', async () => {
    const { resources, electronDist } = await fixture()
    const packaged = join(resources, 'default_app.asar')
    const template = electronFactoryTemplatePath(electronDist, 'win32')
    await mkdir(join(electronDist, 'resources'))
    await Promise.all([writeFile(packaged, 'factory bytes'), writeFile(template, 'factory bytes')])
    const ticket = await captureElectronFactoryTemplate(
      template,
      undefined,
      createHash('sha256').update('factory bytes').digest('hex')
    )
    try {
      const foreignBytes = Buffer.from('foreign bytes')
      await writeFile(template, foreignBytes)
      await expect(removeElectronDefaultAppTemplate(resources, ticket)).rejects.toThrow(/differs/)
      await expect(readFile(packaged, 'utf8')).resolves.toBe('factory bytes')
    } finally {
      await ticket.handle.close()
    }
  })

  it('canonicalizes an aliased private temp root before checking its children', async () => {
    const { resources } = await fixture()
    const alias = join(tmpdir(), `metis-lean-alias-${process.pid}`)
    roots.push(alias)
    await symlink(resources, alias, 'dir')
    expect(canonicalPrivateTemporaryRoot(alias)).toBe(realpathSync(resources))
  })

  it.each([
    ['win32', 'resources/default_app.asar'],
    ['linux', 'resources/default_app.asar'],
    ['darwin', 'Electron.app/Contents/Resources/default_app.asar']
  ])('selects the actual %s Electron factory resource layout', (platform, relativePath) => {
    expect(electronFactoryTemplatePath('/selected/electron-dist', platform)).toBe(
      join('/selected/electron-dist', relativePath)
    )
  })

  it('uses ZIP forward slashes for the Windows Electron factory member', () => {
    expect(electronFactoryArchiveMemberPath('win32')).toBe('resources/default_app.asar')
  })

  it('selects the verified architecture-specific custom Mac Electron archive', () => {
    expect(electronFactoryArchivePath('/selected/resources/electron-dist', '43.6.0', 'darwin', 'arm64')).toBe(
      join('/selected/resources/electron-dist', 'electron-v43.6.0-darwin-arm64.zip')
    )
    expect(electronFactoryArchivePath('/selected/resources/electron-dist', '43.6.0', 'darwin', 'x64')).toBe(
      join('/selected/resources/electron-dist', 'electron-v43.6.0-darwin-x64.zip')
    )
  })
})
