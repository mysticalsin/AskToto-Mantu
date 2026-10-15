import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV_NAME = 'ASKTOTO_LOCAL_KEYSTORE'
let originalProcessValue: string | undefined
let originallyPresent = false

async function loadIntentModule() {
  vi.resetModules()
  return import('./native-key-intent')
}

function setOriginalIntent(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_NAME]
  else process.env[ENV_NAME] = value
}

beforeEach(() => {
  originallyPresent = Object.prototype.hasOwnProperty.call(process.env, ENV_NAME)
  originalProcessValue = process.env[ENV_NAME]
})

afterEach(() => {
  if (originallyPresent) process.env[ENV_NAME] = originalProcessValue ?? ''
  else delete process.env[ENV_NAME]
  vi.resetModules()
})

describe('shared native key intent', () => {
  it('keeps the legacy pure classifier semantics', async () => {
    const intent = await loadIntentModule()
    expect(intent.captureNativeKeyIntent(undefined)).toBe('allowed')
    expect(intent.captureNativeKeyIntent('')).toBe('allowed')
    expect(intent.captureNativeKeyIntent('0')).toBe('explicitly-disabled')
    expect(intent.captureNativeKeyIntent('1')).toBe('explicitly-disabled')
  })

  it('captures immutable original presence and value independently of classification', async () => {
    setOriginalIntent('0')
    const intent = await loadIntentModule()

    expect(intent.PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT).toEqual({ present: true, value: '0' })
    expect(Object.isFrozen(intent.PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT)).toBe(true)
    expect(intent.PERSISTENCE_NATIVE_KEY_INTENT).toBe('explicitly-disabled')
    expect(intent.captureNativeKeyIntent('')).toBe('allowed')
    expect(intent.PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT).toEqual({ present: true, value: '0' })
    expect(process.env[ENV_NAME]).toBe('0')
  })

  it.each([
    '0',
    '1',
    'false',
    'disabled',
    'unexpected'
  ])('preserves explicit nonempty original value %s as opted out', async (value) => {
    setOriginalIntent(value)
    const intent = await loadIntentModule()
    intent.applyLegacyPersistenceNativeKeyDefault()

    expect(intent.PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT).toEqual({ present: true, value })
    expect(intent.PERSISTENCE_NATIVE_KEY_INTENT).toBe('explicitly-disabled')
    expect(process.env[ENV_NAME]).toBe(value)
    expect(() => intent.assertPersistenceNativeKeyIntentCurrent()).not.toThrow()
  })

  it('seals the real platform default without changing an explicit empty value', async () => {
    setOriginalIntent('')
    const intent = await loadIntentModule()
    intent.applyLegacyPersistenceNativeKeyDefault()

    expect(intent.PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT).toEqual({ present: true, value: '' })
    expect(intent.PERSISTENCE_NATIVE_KEY_INTENT).toBe('allowed')
    expect(process.env[ENV_NAME]).toBe('')
    expect(() => intent.assertPersistenceNativeKeyIntentCurrent()).not.toThrow()
  })

  it('defaults only an originally absent Darwin intent and preserves absent intent as allowed', async () => {
    setOriginalIntent(undefined)
    const intent = await loadIntentModule()
    intent.applyLegacyPersistenceNativeKeyDefault()

    expect(intent.PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT).toEqual({ present: false, value: null })
    expect(intent.PERSISTENCE_NATIVE_KEY_INTENT).toBe('allowed')
    expect(process.env[ENV_NAME]).toBe(process.platform === 'darwin' ? '1' : undefined)
    expect(() => intent.assertPersistenceNativeKeyIntentCurrent()).not.toThrow()
    expect(() => intent.applyLegacyPersistenceNativeKeyDefault()).not.toThrow()
  })

  it('permanently refuses a mutation and a repeated default never repairs it', async () => {
    setOriginalIntent('0')
    const intent = await loadIntentModule()
    intent.applyLegacyPersistenceNativeKeyDefault()
    process.env[ENV_NAME] = '1'

    expect(() => intent.assertPersistenceNativeKeyIntentCurrent()).toThrow('QA_NATIVE_KEY_INTENT_CHANGED')
    expect(() => intent.applyLegacyPersistenceNativeKeyDefault()).toThrow('QA_NATIVE_KEY_INTENT_CHANGED')
    expect(process.env[ENV_NAME]).toBe('1')
    process.env[ENV_NAME] = '0'
    expect(() => intent.assertPersistenceNativeKeyIntentCurrent()).toThrow('QA_NATIVE_KEY_INTENT_CHANGED')
    expect(() => intent.applyLegacyPersistenceNativeKeyDefault()).toThrow('QA_NATIVE_KEY_INTENT_CHANGED')
    expect(process.env[ENV_NAME]).toBe('0')
  })

  it('refuses a change before the first seal without applying the default', async () => {
    setOriginalIntent(undefined)
    const intent = await loadIntentModule()
    process.env[ENV_NAME] = '0'

    expect(() => intent.applyLegacyPersistenceNativeKeyDefault()).toThrow('QA_NATIVE_KEY_INTENT_CHANGED')
    expect(() => intent.applyLegacyPersistenceNativeKeyDefault()).toThrow('QA_NATIVE_KEY_INTENT_CHANGED')
    expect(process.env[ENV_NAME]).toBe('0')
  })

  it('refuses currentness until the legacy entry point has sealed the effective intent', async () => {
    setOriginalIntent(undefined)
    const intent = await loadIntentModule()

    expect(() => intent.assertPersistenceNativeKeyIntentCurrent()).toThrow('QA_NATIVE_KEY_INTENT_UNSEALED')
  })
})
