#!/usr/bin/env node
import assert from 'node:assert/strict'
import { assertRequiredFulcioClaims, decodeDerUtf8String, FULCIO_OID } from './sigstore-identity-claims.mjs'

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux') {
  throw new Error('RUNTIME_SIGSTORE_DER_ACTIONS_ONLY')
}

const expected = new Map([
  [FULCIO_OID.issuer, 'https://token.actions.githubusercontent.com'],
  [
    FULCIO_OID.signerUri,
    'https://github.com/mysticalsin/AskToto-Mantu/.github/workflows/runtime-llama-candidate.yml@refs/heads/m2/M2-0475-runtime-artifact-publisher'
  ],
  [FULCIO_OID.signerDigest, 'a78de2590a05c09ecc5198009c3509085a4f5053'],
  [FULCIO_OID.runnerEnvironment, 'github-hosted'],
  [FULCIO_OID.repositoryUri, 'https://github.com/mysticalsin/AskToto-Mantu'],
  [FULCIO_OID.sourceDigest, 'a78de2590a05c09ecc5198009c3509085a4f5053'],
  [FULCIO_OID.sourceRef, 'refs/heads/m2/M2-0475-runtime-artifact-publisher'],
  [FULCIO_OID.repositoryId, '1282463398']
])

function encodeDerUtf8String(value) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length < 0x80) return Buffer.concat([Buffer.from([0x0c, bytes.length]), bytes])
  let length = bytes.length
  const encodedLength = []
  while (length > 0) {
    encodedLength.unshift(length & 0xff)
    length = Math.floor(length / 256)
  }
  return Buffer.concat([Buffer.from([0x0c, 0x80 | encodedLength.length, ...encodedLength]), bytes])
}

function extensionsFor(claims) {
  return [...claims].map(([oid, value]) => ({
    oid: { id: oid.split('.').map(Number) },
    value: encodeDerUtf8String(value)
  }))
}

function rejectsClaimSet(claims) {
  assert.throws(
    () => assertRequiredFulcioClaims(claims, expected),
    (error) => error?.message === 'RUNTIME_READBACK_CERTIFICATE_CLAIMS_INVALID'
  )
}

const positiveExtensions = extensionsFor(expected)
positiveExtensions.push({ oid: { id: [2, 5, 29, 19] }, value: Buffer.from([0xff, 0x00, 0x80]) })
assertRequiredFulcioClaims(positiveExtensions, expected)
const longDer = Buffer.concat([Buffer.from([0x0c, 0x81, 0x80]), Buffer.alloc(128, 0x41)])
assert.equal(decodeDerUtf8String(longDer), 'A'.repeat(128))

const shortDer = Buffer.from('0c0d6769746875622d686f73746564', 'hex')
assert.equal(decodeDerUtf8String(shortDer), 'github-hosted')
for (const malformed of [
  Buffer.from([0x13, 0x01, 0x41]),
  Buffer.from([0x0c, 0x02, 0x41]),
  Buffer.from([0x0c, 0x01, 0x41, 0x00]),
  Buffer.from([0x0c, 0x81, 0x01, 0x41]),
  Buffer.from([0x0c, 0x82, 0x00, 0x80, ...new Array(128).fill(0x41)]),
  Buffer.from([0x0c, 0x80, 0x00, 0x00]),
  Buffer.from([0x0c, 0x01, 0xff]),
  Buffer.from([0x0c, 0x01, 0x00])
]) {
  assert.equal(decodeDerUtf8String(malformed), null)
}

rejectsClaimSet([...positiveExtensions, positiveExtensions[0]])
rejectsClaimSet(positiveExtensions.filter((extension) => extension.oid.id.join('.') !== FULCIO_OID.repositoryId))
rejectsClaimSet(
  positiveExtensions.map((extension) =>
    extension.oid.id.join('.') === FULCIO_OID.sourceRef
      ? { ...extension, value: Buffer.from([0x0c, 0x01, 0xff]) }
      : extension
  )
)

process.stdout.write('RUNTIME_SIGSTORE_DER_CASES_PASSED positives=3 negatives=11\n')
