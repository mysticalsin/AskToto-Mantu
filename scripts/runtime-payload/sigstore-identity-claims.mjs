export const FULCIO_OID = Object.freeze({
  issuer: '1.3.6.1.4.1.57264.1.8',
  signerUri: '1.3.6.1.4.1.57264.1.9',
  signerDigest: '1.3.6.1.4.1.57264.1.10',
  runnerEnvironment: '1.3.6.1.4.1.57264.1.11',
  repositoryUri: '1.3.6.1.4.1.57264.1.12',
  sourceDigest: '1.3.6.1.4.1.57264.1.13',
  sourceRef: '1.3.6.1.4.1.57264.1.14',
  repositoryId: '1.3.6.1.4.1.57264.1.15'
})

const REQUIRED_OIDS = Object.freeze(Object.values(FULCIO_OID))
const OID_INTEGER_MAX = 4_294_967_295
const MAX_CLAIM_BYTES = 8192
const UTF8 = new TextDecoder('utf-8', { fatal: true })

function fail() {
  throw new Error('RUNTIME_READBACK_CERTIFICATE_CLAIMS_INVALID')
}

export function decodeDerUtf8String(value) {
  if (!Buffer.isBuffer(value) || value.length < 3 || value.length > MAX_CLAIM_BYTES || value[0] !== 0x0c) return null

  const firstLengthByte = value[1]
  let lengthBytes = 0
  let contentOffset = 2
  let contentLength = firstLengthByte
  if (firstLengthByte >= 0x80) {
    lengthBytes = firstLengthByte & 0x7f
    if (lengthBytes === 0 || lengthBytes > 4 || value.length < 2 + lengthBytes || value[2] === 0) return null
    contentLength = 0
    for (let index = 0; index < lengthBytes; index += 1) {
      contentLength = contentLength * 256 + value[2 + index]
    }
    if (contentLength < 0x80) return null
    const minimalLengthBytes =
      contentLength <= 0xff ? 1 : contentLength <= 0xffff ? 2 : contentLength <= 0xffffff ? 3 : 4
    if (lengthBytes !== minimalLengthBytes) return null
    contentOffset += lengthBytes
  }

  if (contentLength < 1 || contentOffset + contentLength !== value.length) return null
  try {
    const decoded = UTF8.decode(value.subarray(contentOffset))
    if (!decoded || /[\u0000-\u001f\u007f-\u009f]/.test(decoded)) return null
    return decoded
  } catch {
    return null
  }
}

export function assertRequiredFulcioClaims(oids, expected) {
  if (
    !Array.isArray(oids) ||
    oids.length > 256 ||
    !(expected instanceof Map) ||
    expected.size !== REQUIRED_OIDS.length ||
    REQUIRED_OIDS.some((oid) => typeof expected.get(oid) !== 'string')
  )
    fail()

  const found = new Map()
  for (const extension of oids) {
    if (!extension || typeof extension !== 'object' || Array.isArray(extension)) fail()
    const identifier = extension.oid
    if (!identifier || typeof identifier !== 'object' || !Array.isArray(identifier.id)) fail()
    if (
      identifier.id.length < 2 ||
      identifier.id.length > 32 ||
      !identifier.id.every((part) => Number.isInteger(part) && part >= 0 && part <= OID_INTEGER_MAX)
    )
      fail()
    const oid = identifier.id.join('.')
    if (!expected.has(oid)) continue
    if (found.has(oid)) fail()
    // Sigstore exposes X.509 extnValue bytes; Fulcio's required claims encode DER UTF8String values.
    const decoded = decodeDerUtf8String(extension.value)
    if (decoded === null) fail()
    found.set(oid, decoded)
  }

  for (const [oid, expectedValue] of expected) {
    if (!found.has(oid) || found.get(oid) !== expectedValue) fail()
  }
}
