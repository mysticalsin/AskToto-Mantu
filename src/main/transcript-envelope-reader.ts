/** Reads only kLocal from an ATKENC2 envelope; the large payload stays opaque for the worker. */
export function readEnvelopeLocalKey(bytes: Buffer): string {
  const maxDescriptorBytes = 16_384
  const keyToken = Buffer.from('"kLocal"')
  const keyStart = bytes.indexOf(keyToken)
  if (keyStart < 0 || bytes.indexOf(keyToken, keyStart + keyToken.length) >= 0)
    throw new Error('malformed transcript envelope')
  const scanEnd = Math.min(bytes.length, keyStart + maxDescriptorBytes)
  let cursor = keyStart + keyToken.length
  const whitespace = (): void => {
    while (
      cursor < scanEnd &&
      (bytes[cursor] === 0x20 || bytes[cursor] === 0x09 || bytes[cursor] === 0x0a || bytes[cursor] === 0x0d)
    )
      cursor++
  }
  const stringToken = (): { start: number; end: number } => {
    if (cursor >= scanEnd) throw new Error('malformed transcript envelope')
    if (bytes[cursor++] !== 0x22) throw new Error('malformed transcript envelope')
    const start = cursor - 1
    while (cursor < scanEnd) {
      const byte = bytes[cursor++]
      if (byte === 0x22) return { start, end: cursor }
      if (byte === 0x5c) {
        if (cursor >= scanEnd) throw new Error('malformed transcript envelope')
        cursor++
      }
      else if (byte < 0x20) throw new Error('malformed transcript envelope')
    }
    throw new Error('malformed transcript envelope')
  }
  whitespace()
  if (cursor >= scanEnd) throw new Error('malformed transcript envelope')
  if (bytes[cursor++] !== 0x3a) throw new Error('malformed transcript envelope')
  whitespace()
  const valueToken = stringToken()
  if (valueToken.end - valueToken.start > maxDescriptorBytes) throw new Error('malformed transcript envelope')
  const localKey = JSON.parse(bytes.subarray(valueToken.start, valueToken.end).toString('utf8')) as unknown
  if (typeof localKey !== 'string' || !localKey) throw new Error('malformed transcript envelope')
  return localKey
}
