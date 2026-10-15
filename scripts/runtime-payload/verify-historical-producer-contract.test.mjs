import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { resolve } from 'node:path'
import {
  HISTORICAL_PRODUCER_LOCK_BLOB,
  SOURCE_REF,
  SOURCE_SHA,
  validHistoricalProducerPaths,
  validateHistoricalProducerInputs
} from './retained-candidate-contract.mjs'

const producerRoot = process.env.RUNTIME_HISTORICAL_PRODUCER

test('historical producer bytes stay bound to the pinned producer checkout', async () => {
  assert.ok(producerRoot && resolve(producerRoot) === producerRoot)
  const [lockBytes, catalogBytes, trustRootBytes, receiptBytes, readerTrustRootBytes, readerReceiptBytes] =
    await Promise.all([
      readFile(resolve(producerRoot, 'package-lock.json')),
      readFile(resolve(producerRoot, 'resources/runtime-catalog.json')),
      readFile(resolve(producerRoot, 'resources/runtime-trust/sigstore-trusted-root.json')),
      readFile(resolve(producerRoot, 'resources/runtime-trust/acquisition-receipt.json')),
      readFile('resources/runtime-trust/sigstore-trusted-root.json'),
      readFile('resources/runtime-trust/acquisition-receipt.json')
    ])
  const input = {
    producerCommit: SOURCE_SHA,
    producerRef: SOURCE_REF,
    producerLockBlob: HISTORICAL_PRODUCER_LOCK_BLOB,
    producerLockBytes: lockBytes,
    catalogBytes,
    trustRootBytes,
    receiptBytes,
    readerTrustRootBytes,
    readerReceiptBytes
  }
  assert.ok(validateHistoricalProducerInputs(input))

  const changedVerifierLock = Buffer.from(lockBytes)
  changedVerifierLock[0] ^= 1
  assert.notDeepEqual(changedVerifierLock, lockBytes)
  assert.equal(
    validateHistoricalProducerInputs({ ...input, verifierLockBytes: changedVerifierLock }),
    null,
    'reader dependency bytes cannot be supplied as producer evidence'
  )

  const changedProducerLock = Buffer.from(lockBytes)
  changedProducerLock[changedProducerLock.length - 2] ^= 1
  assert.equal(validateHistoricalProducerInputs({ ...input, producerLockBytes: changedProducerLock }), null)
  assert.equal(validateHistoricalProducerInputs({ ...input, producerRef: 'refs/heads/other' }), null)
  assert.equal(validateHistoricalProducerInputs({ ...input, producerCommit: 'a'.repeat(40) }), null)
  assert.equal(validateHistoricalProducerInputs({ ...input, producerLockBlob: 'b'.repeat(40) }), null)
  assert.equal(validateHistoricalProducerInputs({ ...input, receiptBytes: undefined }), null)
})

test('historical producer checkout is an owned sibling separate from verifier and artifact roots', () => {
  const verifierRoot = resolve(process.cwd())
  const runnerTemp = resolve(process.env.RUNNER_TEMP ?? '/tmp')
  assert.equal(
    validHistoricalProducerPaths({
      verifierRoot,
      producerRoot,
      artifactRoot: resolve(runnerTemp, 'runtime-candidate-readback')
    }),
    true
  )
  assert.equal(
    validHistoricalProducerPaths({
      verifierRoot,
      producerRoot: resolve(verifierRoot, '.'),
      artifactRoot: resolve(runnerTemp, 'runtime-candidate-readback')
    }),
    false
  )
  assert.equal(
    validHistoricalProducerPaths({
      verifierRoot,
      producerRoot: undefined,
      artifactRoot: resolve(runnerTemp, 'runtime-candidate-readback')
    }),
    false
  )
  assert.equal(
    validHistoricalProducerPaths({
      verifierRoot,
      producerRoot,
      artifactRoot: resolve(producerRoot, 'artifact-alias')
    }),
    false
  )
})

test('historical producer artifact path must be disjoint from both checkout roots', () => {
  const fixtureRoot = resolve('/tmp/runtime-historical-path-fixtures')
  const verifierRoot = resolve(fixtureRoot, 'repo')
  const producerRoot = resolve(fixtureRoot, 'producer')
  const validPaths = (artifactRoot) => validHistoricalProducerPaths({ verifierRoot, producerRoot, artifactRoot })

  assert.equal(validPaths(resolve(fixtureRoot, 'artifact')), true, 'disjoint sibling is accepted')
  assert.equal(
    validPaths(resolve('/var/tmp/runtime-historical-path-fixtures/artifact')),
    true,
    'outside path is accepted'
  )
  assert.equal(validPaths(resolve(fixtureRoot, 'repo-artifacts')), true, 'prefix-lookalike sibling is accepted')

  for (const checkoutRoot of [verifierRoot, producerRoot]) {
    assert.equal(validPaths(checkoutRoot), false, 'artifact equal to a checkout root is rejected')
    assert.equal(validPaths(resolve(checkoutRoot, 'artifact')), false, 'artifact below a checkout root is rejected')
    assert.equal(validPaths(resolve(checkoutRoot, '..')), false, 'artifact ancestor of a checkout root is rejected')
  }
})
