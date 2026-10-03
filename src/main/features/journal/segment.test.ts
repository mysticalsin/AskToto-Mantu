import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  encodeFrame,
  listSegments,
  MAX_FRAME_BYTES,
  parseSegmentName,
  scanFrames,
  SegmentWriter,
  segmentName
} from './segment'

describe('journal frames', () => {
  it('round-trips frames in order', () => {
    const bytes = Buffer.concat([encodeFrame(Buffer.from('one')), encodeFrame(Buffer.from('two'))])
    expect(scanFrames(bytes)).toEqual({ payloads: [Buffer.from('one'), Buffer.from('two')], tornTail: false })
  })

  it('returns every whole frame before a torn header or a torn payload', () => {
    const whole = encodeFrame(Buffer.from('kept'))
    const next = encodeFrame(Buffer.from('lost in the crash'))
    for (const cut of [1, 3, 4, 10]) {
      expect(scanFrames(Buffer.concat([whole, next.subarray(0, cut)]))).toEqual({
        payloads: [Buffer.from('kept')],
        tornTail: true
      })
    }
  })

  it('treats a zero or impossible length as a torn tail, never as a frame', () => {
    const whole = encodeFrame(Buffer.from('kept'))
    const zero = Buffer.alloc(8)
    const huge = Buffer.alloc(8)
    huge.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(scanFrames(Buffer.concat([whole, zero])).tornTail).toBe(true)
    expect(scanFrames(Buffer.concat([whole, huge])).payloads).toEqual([Buffer.from('kept')])
  })

  it('refuses to encode an empty or oversize payload', () => {
    expect(() => encodeFrame(Buffer.alloc(0))).toThrow()
    expect(() => encodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1))).toThrow()
  })
})

describe('segment files', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metis-journal-seg-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('names segments seg-<n>.jnl and lists only those, in numeric order', async () => {
    expect(segmentName(3)).toBe('seg-3.jnl')
    expect(parseSegmentName('seg-12.jnl')).toBe(12)
    for (const name of ['seg-0.jnl', 'seg-01.jnl', 'seg-1.jnl.tmp', 'seg-x.jnl', 'notes.md']) {
      expect(parseSegmentName(name)).toBeNull()
    }
    for (const name of ['seg-10.jnl', 'seg-2.jnl', 'seg-1.jnl', 'other.txt']) writeFileSync(join(dir, name), '')
    expect(await listSegments(dir)).toEqual([1, 2, 10])
    expect(await listSegments(join(dir, 'missing'))).toEqual([])
  })

  it('appends to a segment it created and never reopens one that already exists', async () => {
    const writer = await SegmentWriter.create(dir, 1)
    await writer.appendDurably(encodeFrame(Buffer.from('a')))
    await writer.appendDurably(encodeFrame(Buffer.from('b')))
    await writer.close()
    expect(scanFrames(readFileSync(join(dir, 'seg-1.jnl'))).payloads).toEqual([Buffer.from('a'), Buffer.from('b')])
    expect(writer.size).toBe(10)
    await expect(SegmentWriter.create(dir, 1)).rejects.toMatchObject({ code: 'EEXIST' })
  })
})
