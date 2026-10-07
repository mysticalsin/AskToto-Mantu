#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// Invariant: a kit registry carries exactly one skill entry and neither auto flag is ever true, so
// loading the skill can never install or capture anything on its own.
export function registryEntries(registry) {
  if (Array.isArray(registry)) return registry
  if (registry && Array.isArray(registry.skills)) return registry.skills
  return null
}

export function registryProblems(registry) {
  const entries = registryEntries(registry)
  if (!entries) return ['registry has no skills array']
  const problems = []
  if (entries.length !== 1) problems.push(`expected exactly one skill entry, found ${entries.length}`)
  entries.forEach((entry, index) => {
    const label = entry?.name ?? entry?.id ?? `#${index}`
    for (const flag of ['auto_install', 'auto_capture']) {
      if (entry?.[flag] !== false) problems.push(`skill ${label}: ${flag} must be false`)
    }
  })
  return problems
}

function main() {
  const { values } = parseArgs({ options: { registry: { type: 'string' } } })
  if (!values.registry) {
    console.error('usage: check-skill-registry.mjs --registry <REGISTRY.json>')
    process.exit(2)
  }
  const problems = registryProblems(JSON.parse(readFileSync(values.registry, 'utf8')))
  for (const problem of problems) console.error(`FAIL ${problem}`)
  if (problems.length) process.exit(1)
  console.log('skill registry ok: one entry, auto_install and auto_capture false')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
