import { resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localAiRoot, resolveLocalAiResource } from './resource-path'

interface LocalAiContext {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

const packagedContext: LocalAiContext = {
  isPackaged: true,
  resourcesPath: resolve('/opt/app/resources'),
  appPath: resolve('/opt/app')
}

const devContext: LocalAiContext = {
  isPackaged: false,
  resourcesPath: resolve('/dev/tree/resources'),
  appPath: resolve('/dev/tree/app')
}

const packagedRoot = resolve(packagedContext.resourcesPath, 'local-ai')
const devRoot = resolve(devContext.appPath, 'resources', 'local-ai', 'payload')

function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : root + sep
  return candidate === root || candidate.startsWith(normalizedRoot)
}

describe('localAiRoot', () => {
  it('returns resourcesPath/local-ai when packaged', () => {
    expect(localAiRoot(packagedContext)).toBe(packagedRoot)
  })

  it('returns appPath/resources/local-ai/payload in development', () => {
    expect(localAiRoot(devContext)).toBe(devRoot)
  })
})

describe('resolveLocalAiResource', () => {
  it.each([
    [packagedContext, packagedRoot],
    [devContext, devRoot]
  ])('resolves a normal nested model path below the selected root', (context, root) => {
    const result = resolveLocalAiResource(context, 'models/llama/weights.bin')
    expect(isWithinRoot(root, result)).toBe(true)
  })

  const rejectedPaths = [
    '',
    '/etc/passwd',
    'C:\\Windows\\System32',
    'C:/Windows/System32',
    '\\\\server\\share\\file',
    'models\\llama\\weights.bin',
    './models/weights.bin',
    'models/./weights.bin',
    '..',
    '../weights.bin',
    'models/../../etc/passwd',
    'models/..%2f..%2fetc/passwd',
    'models\u0000weights.bin',
    'models/weights.bin?x=1',
    'models/weights.bin#frag'
  ]

  it.each([
    ...rejectedPaths.map((path) => [packagedContext, path] as const),
    ...rejectedPaths.map((path) => [devContext, path] as const)
  ])('rejects unsafe relative path %#', (context, unsafePath) => {
    expect(() => resolveLocalAiResource(context, unsafePath)).toThrow()
  })

  it('does not cross from the packaged root into the development root', () => {
    const result = resolveLocalAiResource(packagedContext, 'runtimes/onnx/lib/libonnxruntime.so')
    expect(isWithinRoot(packagedRoot, result)).toBe(true)
    expect(isWithinRoot(devRoot, result)).toBe(false)
  })
})
