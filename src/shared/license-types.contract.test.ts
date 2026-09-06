import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LICENSE_ACTIVATION_OPEN } from './license-types'

const REPO = join(__dirname, '..', '..')

describe('LICENSE_ACTIVATION_OPEN — selling stays closed', () => {
  it('the shared flag is false', () => {
    expect(LICENSE_ACTIVATION_OPEN).toBe(false)
  })

  it('the source pins the flag as a boolean literal, not an env read', () => {
    const src = readFileSync(join(REPO, 'src/shared/license-types.ts'), 'utf8')
    expect(src).toMatch(/export const LICENSE_ACTIVATION_OPEN = false/)
    expect(src).not.toMatch(/process\.env\.LICENSE_ACTIVATION_OPEN/)
  })
})
