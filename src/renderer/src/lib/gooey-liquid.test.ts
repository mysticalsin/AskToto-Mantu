import { describe, expect, it } from 'vitest'
import { loadLiquidGooey } from './gooey-liquid'
import {
  LIQUID_GOOEY_ID,
  LIQUID_GOOEY_MISSING_ID,
  LIQUID_GOOEY_STUB,
  loadOptionalLiquidGooeyStub,
  resolveOptionalLiquidGooey
} from '@shared/optional-liquid-gooey'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const host = readFileSync(join(__dirname, '../components/GooeySurface.tsx'), 'utf8')
const lock = readFileSync(join(__dirname, '../../../../package-lock.json'), 'utf8')
const pkg = readFileSync(join(__dirname, '../../../../package.json'), 'utf8')
const vite = readFileSync(join(__dirname, '../../../../electron.vite.config.ts'), 'utf8')

describe('liquid-gooey pin + fail-closed load', () => {
  it('pins 0.2.1 in package.json and package-lock.json', () => {
    expect(pkg).toMatch(/"liquid-gooey": "0\.2\.1"/)
    expect(lock).toMatch(/"node_modules\/liquid-gooey": \{[\s\S]*?"version": "0\.2\.1"/)
    expect(lock).toMatch(/liquid-gooey-0\.2\.1\.tgz/)
  })

  it('GooeySurface never static-imports liquid-gooey', () => {
    expect(host).not.toMatch(/from ['"]liquid-gooey['"]/)
    expect(host).toMatch(/loadLiquidGooey/)
    expect(host).toMatch(/data-gooey-live="0"/)
    expect(vite).toMatch(/optionalLiquidGooey/)
  })

  it('loadLiquidGooey returns null on throw or a module without Liquid', async () => {
    await expect(loadLiquidGooey(async () => { throw new Error('missing') })).resolves.toBeNull()
    await expect(loadLiquidGooey(async () => ({}))).resolves.toBeNull()
    const Liquid = Object.assign(function Liquid() { return null }, { Item: function Item() { return null } })
    await expect(loadLiquidGooey(async () => ({ Liquid }))).resolves.toBe(Liquid)
  })

  it('Vite stub resolves only when the package is missing', () => {
    expect(resolveOptionalLiquidGooey(LIQUID_GOOEY_ID, true)).toBeNull()
    expect(resolveOptionalLiquidGooey(LIQUID_GOOEY_ID, false)).toBe(LIQUID_GOOEY_MISSING_ID)
    expect(resolveOptionalLiquidGooey('thinking-orbs', false)).toBeNull()
    expect(loadOptionalLiquidGooeyStub(LIQUID_GOOEY_MISSING_ID)).toBe(LIQUID_GOOEY_STUB)
    expect(loadOptionalLiquidGooeyStub(LIQUID_GOOEY_ID)).toBeNull()
    expect(LIQUID_GOOEY_STUB).toMatch(/export const Liquid = null/)
  })
})
