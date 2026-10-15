import { describe, expect, it } from 'vitest'
import { assertMachOArchitectures } from './macho-architecture.mjs'

function thinMachO(cpuType: number): Buffer {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(cpuType, 4)
  return header
}

function fatMachO(cpuTypes: number[]): Buffer {
  const header = Buffer.alloc(8 + cpuTypes.length * 20)
  header.writeUInt32BE(0xcafebabe, 0)
  header.writeUInt32BE(cpuTypes.length, 4)
  for (const [index, cpuType] of cpuTypes.entries()) header.writeUInt32BE(cpuType, 8 + index * 20)
  return header
}

describe('lean macOS binary architecture gate', () => {
  it('accepts only the exact requested thin architecture', () => {
    expect(assertMachOArchitectures(thinMachO(0x0100000c), ['arm64'])).toEqual(['arm64'])
    expect(() => assertMachOArchitectures(thinMachO(0x01000007), ['arm64'])).toThrow(/expected Mach-O arches/)
  })

  it('rejects universal binaries for a single-architecture candidate', () => {
    const universal = fatMachO([0x01000007, 0x0100000c])
    expect(() => assertMachOArchitectures(universal, ['arm64'])).toThrow(/expected Mach-O arches/)
    expect(assertMachOArchitectures(universal, ['arm64', 'x64'])).toEqual(['arm64', 'x64'])
  })

  it('rejects truncated and unknown architecture headers', () => {
    expect(() => assertMachOArchitectures(Buffer.alloc(4), ['x64'])).toThrow(/truncated/)
    expect(() => assertMachOArchitectures(thinMachO(0x1234), ['x64'])).toThrow(/unknown\(0x1234\)/)
  })
})
