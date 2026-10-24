import { describe, expect, it } from 'vitest'
import { CONNECTOR_EFFECTS } from './connector-catalog'
import { CONNECTOR_EFFECT_CLASSES, allowedClassesFor, requiresConfirm } from './connector-effects'

describe('connector effect classes', () => {
  it('maps every effect to its allowed classes', () => {
    expect(allowedClassesFor('read')).toEqual(['read'])
    expect(allowedClassesFor('create')).toEqual(['reversible_write', 'irreversible_write'])
    expect(allowedClassesFor('modify')).toEqual(['reversible_write', 'irreversible_write'])
    expect(allowedClassesFor('delete')).toEqual(['irreversible_write'])
    expect(allowedClassesFor('send')).toEqual(['send'])
    for (const effect of CONNECTOR_EFFECTS) expect(allowedClassesFor(effect).length).toBeGreaterThan(0)
  })

  it('requiresConfirm is false only for read', () => {
    expect(CONNECTOR_EFFECT_CLASSES.filter((c) => !requiresConfirm(c))).toEqual(['read'])
  })
})
