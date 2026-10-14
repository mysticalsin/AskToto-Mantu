import { describe, expect, it } from 'vitest'
import { exactKey } from './incremental-meeting-journal-format'

describe('incremental journal key ownership', () => {
  it('copies only an exact fixed-size ordinary array buffer view', () => {
    const input = Uint8Array.from({ length: 32 }, (_, index) => index)
    const copy = exactKey(input)
    expect(copy).not.toBeNull()
    input.fill(0)
    expect(copy?.[31]).toBe(31)
    copy?.fill(0)
  })

  it('rejects borrowed, spoofed, shared, resizable, and detached views', () => {
    const backing = new Uint8Array(64)
    const borrowed = backing.subarray(8, 40)
    expect(exactKey(borrowed)).toBeNull()

    const short = new Uint8Array(16)
    Object.defineProperty(short, 'byteLength', { configurable: true, value: 32 })
    Object.defineProperty(short, 'byteOffset', { configurable: true, value: 0 })
    Object.defineProperty(short, 'buffer', { configurable: true, value: new ArrayBuffer(32) })
    expect(exactKey(short)).toBeNull()

    if (typeof SharedArrayBuffer !== 'undefined') expect(exactKey(new Uint8Array(new SharedArrayBuffer(32)))).toBeNull()

    const resizable = Reflect.construct(ArrayBuffer, [32, { maxByteLength: 64 }]) as ArrayBuffer
    expect(exactKey(new Uint8Array(resizable))).toBeNull()

    const detached = new Uint8Array(new ArrayBuffer(32))
    structuredClone(detached.buffer, { transfer: [detached.buffer] })
    expect(exactKey(detached)).toBeNull()
  })
})
