import { describe, expect, it } from 'vitest'
import { registryProblems } from './check-skill-registry.mjs'

const entry = { name: 'skill-a', auto_install: false, auto_capture: false }

describe('skill registry check', () => {
  it('accepts exactly one entry with both auto flags false', () => {
    expect(registryProblems({ skills: [entry] })).toEqual([])
  })

  it('fails on a second entry', () => {
    const problems = registryProblems({ skills: [entry, { ...entry, name: 'skill-b' }] })
    expect(problems).toEqual(['expected exactly one skill entry, found 2'])
  })

  it('fails when either flag is true or missing', () => {
    expect(registryProblems({ skills: [{ ...entry, auto_install: true }] })).toEqual([
      'skill skill-a: auto_install must be false'
    ])
    expect(registryProblems({ skills: [{ name: 'skill-a', auto_install: false }] })).toEqual([
      'skill skill-a: auto_capture must be false'
    ])
  })

  it('fails on an empty or malformed registry', () => {
    expect(registryProblems({ skills: [] })).toEqual(['expected exactly one skill entry, found 0'])
    expect(registryProblems({})).toEqual(['registry has no skills array'])
  })
})
