import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * M2-0501 — a workflow file that only has a workflow_dispatch trigger is registered by GitHub only when a
 * push to the default branch is processed or when a run of it exists. When a push is not processed the file
 * is on main but the Actions API answers 404 for it, so it cannot be dispatched. Each dispatch-only file
 * therefore also triggers on pull_request for its own path with every job skipped: the PR's first CI round
 * creates a run, which registers the file before it merges, and the run costs no runner minutes.
 *
 * Deliberately no YAML library (see ci-cost-gates.contract.test.ts): the extraction below reads the fixed
 * two-space layout every workflow in this repository uses.
 */

const root = join(__dirname, '..', '..')
const workflowsDir = join(root, '.github', 'workflows')
const DISPATCH_CLAUSE = "github.event_name == 'workflow_dispatch'"

/** Files that first reached main before this rule and stay dispatch-only. baseline-gates forbids pull_request (M2-0263). */
const FROZEN_LEGACY = new Set([
  'freeze-repro.yml',
  'm2-0016-prd-lock.yml',
  'm2-0018-traceability.yml',
  'm2-0025-triage.yml',
  'promote-candidate.yml',
  'resource-census.yml',
  'windows-signing-identity-preflight.yml',
  'baseline-gates.yml'
])

function blockAfter(source: string, header: string): string[] {
  const lines = source.split('\n')
  const start = lines.indexOf(header)
  if (start === -1) return []
  const block: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    block.push(line)
  }
  return block
}

function triggerBlocks(source: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of blockAfter(source, 'on:')) {
    const key = /^ {2}([a-z_]+):/.exec(line)
    if (key) {
      current = []
      blocks.set(key[1], current)
    } else if (current) current.push(line)
  }
  return blocks
}

/** Each job id with its `if:` condition (folded scalars joined into one line), or undefined when it has none. */
function jobConditions(source: string): Map<string, string | undefined> {
  const jobs = new Map<string, string | undefined>()
  let job: string | undefined
  let folded = false
  for (const line of blockAfter(source, 'jobs:')) {
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (id) {
      job = id[1]
      jobs.set(job, undefined)
      folded = false
      continue
    }
    if (!job) continue
    const cond = /^ {4}if:\s*(.*)$/.exec(line)
    if (cond) {
      folded = /^[>|][-+]?$/.test(cond[1])
      jobs.set(job, folded ? '' : cond[1])
    } else if (folded && /^ {6}\S/.test(line)) {
      jobs.set(job, `${jobs.get(job)} ${line.trim()}`.trim())
    } else folded = false
  }
  return jobs
}

function ownPathOnly(file: string, block: string[] | undefined): boolean {
  if (!block) return false
  const text = block.join('\n')
  const own = `.github/workflows/${file}`
  const list = [...text.matchAll(/^ {6}- (\S+)\s*$/gm)].map((m) => m[1])
  const inline = /^ {4}paths:\s*\[([^\]]*)\]/m.exec(text)
  if (inline) list.push(...inline[1].split(',').map((p) => p.trim()))
  return list.length === 1 && list[0] === own
}

/** Violations of the self-registration rule for one workflow file; empty when compliant. */
function registrationViolations(file: string, source: string): string[] {
  const triggers = triggerBlocks(source)
  const names = [...triggers.keys()]
  if (triggers.has('workflow_call')) return []
  if (names.length === 1 && names[0] === 'workflow_dispatch') {
    return FROZEN_LEGACY.has(file) ? [] : [`${file}: dispatch-only without a pull_request trigger on its own path`]
  }
  if (triggers.has('workflow_dispatch') && triggers.has('pull_request') && names.every((name) => name === 'workflow_dispatch' || name === 'pull_request')) {
    if (!ownPathOnly(file, triggers.get('pull_request'))) {
      return [`${file}: pull_request registration trigger is not limited to its own workflow path`]
    }
  }
  if (!ownPathOnly(file, triggers.get('pull_request'))) return []
  const problems: string[] = []
  for (const [job, cond] of jobConditions(source)) {
    if (!cond || !cond.includes(DISPATCH_CLAUSE)) {
      problems.push(`${file}: job ${job} does not require ${DISPATCH_CLAUSE}`)
    }
  }
  if (!/^run-name:.*\(registration\)/m.test(source)) problems.push(`${file}: run-name has no (registration) title`)
  return problems
}

const compliant = `name: Sample
run-name: \${{ github.event_name == 'pull_request' && 'Sample (registration)' || 'Sample' }}
on:
  workflow_dispatch:
  pull_request:
    paths:
      - .github/workflows/sample.yml
jobs:
  plain:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
  folded:
    if: >-
      github.event_name == 'workflow_dispatch'
      && inputs.suite == 'a'
    runs-on: ubuntu-latest
`

describe('registration rule checker', () => {
  it('accepts a compliant file', () => {
    expect(registrationViolations('sample.yml', compliant)).toEqual([])
  })

  it('rejects a job with no condition', () => {
    const source = compliant.replace("    if: github.event_name == 'workflow_dispatch'\n", '')
    expect(registrationViolations('sample.yml', source)).toEqual([`sample.yml: job plain does not require ${DISPATCH_CLAUSE}`])
  })

  it('rejects a job whose existing condition lacks the event clause', () => {
    const source = compliant.replace("github.event_name == 'workflow_dispatch'\n      && inputs", "inputs.suite == 'a'\n      && inputs")
    expect(registrationViolations('sample.yml', source)).toEqual([`sample.yml: job folded does not require ${DISPATCH_CLAUSE}`])
  })

  it('rejects a dispatch-only file that is not frozen legacy', () => {
    const source = 'name: Sample\non:\n  workflow_dispatch:\njobs:\n  a:\n    runs-on: ubuntu-latest\n'
    expect(registrationViolations('sample.yml', source)).toEqual(['sample.yml: dispatch-only without a pull_request trigger on its own path'])
    expect(registrationViolations('freeze-repro.yml', source)).toEqual([])
  })

  it('rejects a registration trigger with no (registration) run-name', () => {
    const source = compliant.replace(/^run-name:.*\n/m, '')
    expect(registrationViolations('sample.yml', source)).toEqual(['sample.yml: run-name has no (registration) title'])
  })

  it('rejects a pull_request registration trigger on another path', () => {
    const source = compliant.replace('.github/workflows/sample.yml', '.github/workflows/other.yml')
    expect(registrationViolations('sample.yml', source)).toEqual(['sample.yml: pull_request registration trigger is not limited to its own workflow path'])
  })

  it('exempts a workflow_call file', () => {
    const source = 'name: Callable\non:\n  workflow_call:\n  workflow_dispatch:\njobs:\n  a:\n    runs-on: ubuntu-latest\n'
    expect(registrationViolations('callable.yml', source)).toEqual([])
  })
})

describe('every workflow in the repository', () => {
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml')).sort()

  for (const file of files) {
    it(`${file} registers itself or is frozen legacy`, () => {
      const source = readFileSync(join(workflowsDir, file), 'utf8').replace(/\r\n/g, '\n')
      expect(registrationViolations(file, source)).toEqual([])
    })
  }

  it.each(['hk-m-candidate.yml', 'windows-qa.yml', 'm2-0238-backfill.yml', 'candidate-scenarios.yml'])(
    '%s has the pull_request self-registration trigger',
    (file) => {
      const source = readFileSync(join(workflowsDir, file), 'utf8').replace(/\r\n/g, '\n')
      expect(ownPathOnly(file, triggerBlocks(source).get('pull_request'))).toBe(true)
      expect(triggerBlocks(source).has('workflow_dispatch')).toBe(true)
    }
  )
})
