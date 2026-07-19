import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('macOS signing dependency', () => {
  it('uses the fixed binary scanner inside osx-sign', async () => {
    const osxSignRequire = createRequire(require.resolve('@electron/osx-sign/package.json'))
    const scannerPackage = osxSignRequire('isbinaryfile/package.json') as { version: string }
    const scanner = osxSignRequire('isbinaryfile') as {
      isBinaryFile(file: Buffer): Promise<boolean>
    }

    expect(scannerPackage.version).toBe('5.0.7')
    await expect(scanner.isBinaryFile(Buffer.from([0, 1, 2, 3]))).resolves.toBe(true)
  })

  it('skips only non-Mach-O data formats during per-file signing', () => {
    const config = readFileSync(resolve('electron-builder.yml'), 'utf8')
    const block = /signIgnore:\s*\n((?:\s+-[^\n]+\n)+)/.exec(config)?.[1]

    expect(block).toBeDefined()
    for (const extension of ['asar', 'bin', 'dat', 'gguf', 'icns', 'jpeg', 'jpg', 'nib', 'onnx', 'pak', 'png', 'wasm', 'wav', 'woff2']) {
      expect(block).toContain(extension)
    }
    for (const signedCode of ['node', 'dylib', 'so']) expect(block).not.toContain(signedCode)
  })
})
