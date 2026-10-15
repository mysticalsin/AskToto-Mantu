const NATIVE_KEY_INTENT_ENV = 'ASKTOTO_LOCAL_KEYSTORE'

type PersistenceNativeKeyIntent = 'allowed' | 'explicitly-disabled'

function readEnvironmentIntent(): Readonly<{ present: boolean; value: string | null }> {
  const present = Object.prototype.hasOwnProperty.call(process.env, NATIVE_KEY_INTENT_ENV)
  return Object.freeze({
    present,
    value: present ? (process.env[NATIVE_KEY_INTENT_ENV] ?? '') : null
  })
}

function sameIntent(
  left: Readonly<{ present: boolean; value: string | null }>,
  right: Readonly<{ present: boolean; value: string | null }>
): boolean {
  return left.present === right.present && left.value === right.value
}

export function captureNativeKeyIntent(value: string | undefined): PersistenceNativeKeyIntent {
  return value === undefined || value === '' ? 'allowed' : 'explicitly-disabled'
}

export const PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT = readEnvironmentIntent()
export const PERSISTENCE_NATIVE_KEY_INTENT = captureNativeKeyIntent(
  PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT.present ? (PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT.value ?? '') : undefined
)

let sealedEffectiveIntent: Readonly<{ present: boolean; value: string | null }> | null = null
let permanentlyInvalid = false

function invalidate(): never {
  permanentlyInvalid = true
  throw new Error('QA_NATIVE_KEY_INTENT_CHANGED')
}

function assertEffectiveIntentCurrent(): void {
  if (permanentlyInvalid) throw new Error('QA_NATIVE_KEY_INTENT_CHANGED')
  if (sealedEffectiveIntent === null) throw new Error('QA_NATIVE_KEY_INTENT_UNSEALED')
  if (!sameIntent(readEnvironmentIntent(), sealedEffectiveIntent)) invalidate()
}

export function applyLegacyPersistenceNativeKeyDefault(): void {
  if (permanentlyInvalid) throw new Error('QA_NATIVE_KEY_INTENT_CHANGED')

  if (sealedEffectiveIntent !== null) {
    assertEffectiveIntentCurrent()
    return
  }

  if (!sameIntent(readEnvironmentIntent(), PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT)) invalidate()

  if (process.platform === 'darwin' && !PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT.present) {
    process.env[NATIVE_KEY_INTENT_ENV] = '1'
  }

  sealedEffectiveIntent = readEnvironmentIntent()
}

export function assertPersistenceNativeKeyIntentCurrent(): void {
  assertEffectiveIntentCurrent()
}
