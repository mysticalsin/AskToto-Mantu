import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflowsDir = join(root, '.github', 'workflows')

type Location = 'jobs.<id>.env' | 'jobs.<id>.if' | 'jobs.<id>.runs-on'

type Violation = {
  workflow: string
  job: string
  location: Location
  key?: string
  context: string
}

const CONTEXT_PATTERN = /\$\{\{([^}]+)\}\}/g
const CONTEXT_ROOT_PATTERN = /\b([A-Za-z_][A-Za-z0-9_-]*)\s*\./g

const ALLOWED_CONTEXTS: Record<Location, Set<string>> = {
  // GitHub validates job-level env before the runner exists. Runner, step and job state only exist later.
  'jobs.<id>.env': new Set(['github', 'inputs', 'vars', 'needs', 'strategy', 'matrix', 'secrets']),
  'jobs.<id>.if': new Set(['github', 'inputs', 'vars', 'needs']),
  'jobs.<id>.runs-on': new Set(['github', 'inputs', 'vars', 'needs', 'strategy', 'matrix'])
}

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

function jobBlocks(source: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of blockAfter(source, 'jobs:')) {
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (id) {
      current = []
      jobs.set(id[1], current)
    } else if (current) current.push(line)
  }
  return jobs
}

function valueAt(job: string[], key: 'if' | 'runs-on'): string | undefined {
  for (let index = 0; index < job.length; index += 1) {
    const match = new RegExp(`^ {4}${key}:\\s*(.*)$`).exec(job[index])
    if (!match) continue
    if (match[1] && !/^[>|][-+]?$/.test(match[1])) return match[1]
    const nested: string[] = []
    for (const line of job.slice(index + 1)) {
      if (/^ {4}\S/.test(line)) break
      if (/^ {6}\S/.test(line)) nested.push(line.trim())
    }
    return nested.join(' ')
  }
}

function jobEnvScalars(job: string[]): Map<string, string> {
  const values = new Map<string, string>()
  const start = job.findIndex((line) => line === '    env:')
  if (start === -1) return values
  const env = job.slice(start + 1)
  for (let index = 0; index < env.length; index += 1) {
    const line = env[index]
    if (/^ {4}\S/.test(line)) break
    const match = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!match) continue
    if (match[2] && !/^[>|][-+]?$/.test(match[2])) {
      values.set(match[1], match[2])
      continue
    }
    const nested: string[] = []
    for (const nestedLine of env.slice(index + 1)) {
      if (/^ {6}\S/.test(nestedLine) || /^ {4}\S/.test(nestedLine)) break
      if (/^ {8}\S/.test(nestedLine)) nested.push(nestedLine.trim())
    }
    values.set(match[1], nested.join(' '))
  }
  return values
}

function referencedContexts(value: string | undefined, options: { implicitExpression?: boolean } = {}): string[] {
  if (!value) return []
  const contexts = new Set<string>()
  for (const expression of value.matchAll(CONTEXT_PATTERN)) {
    for (const context of expression[1].matchAll(CONTEXT_ROOT_PATTERN)) {
      const previous = context.index && context.index > 0 ? expression[1][context.index - 1] : ''
      if (previous === '.' || /[A-Za-z0-9_-]/.test(previous)) continue
      contexts.add(context[1])
    }
  }
  if (options.implicitExpression) {
    const unquoted = value.replace(/'[^']*'|"[^"]*"/g, '')
    for (const context of unquoted.matchAll(CONTEXT_ROOT_PATTERN)) {
      const previous = context.index && context.index > 0 ? unquoted[context.index - 1] : ''
      if (previous === '.' || /[A-Za-z0-9_-]/.test(previous)) continue
      contexts.add(context[1])
    }
  }
  return [...contexts].sort()
}

function contextViolations(workflow: string, source: string): Violation[] {
  const violations: Violation[] = []
  for (const [job, block] of jobBlocks(source)) {
    for (const [key, value] of jobEnvScalars(block)) {
      for (const context of referencedContexts(value)) {
        if (!ALLOWED_CONTEXTS['jobs.<id>.env'].has(context)) violations.push({ workflow, job, location: 'jobs.<id>.env', key, context })
      }
    }
    for (const location of ['jobs.<id>.if', 'jobs.<id>.runs-on'] as const) {
      const key = location === 'jobs.<id>.if' ? 'if' : 'runs-on'
      for (const context of referencedContexts(valueAt(block, key), { implicitExpression: location === 'jobs.<id>.if' })) {
        if (!ALLOWED_CONTEXTS[location].has(context)) violations.push({ workflow, job, location, context })
      }
    }
  }
  return violations
}

function summary(violations: Violation[]): string[] {
  return violations.map((violation) => {
    const key = violation.key ? `.${violation.key}` : ''
    return `${violation.workflow}: ${violation.job} ${violation.location}${key} uses disallowed ${violation.context} context`
  })
}

describe('workflow context validator', () => {
  it('rejects the QA candidate regression: runner context in job-level env', () => {
    const source = `name: Broken
on:
  pull_request:
jobs:
  st1-mac-fifo:
    runs-on: [self-hosted, macOS, ARM64, metis-owner-mac]
    env:
      TMPDIR: \${{ runner.temp }}
    steps:
      - run: echo ok
`
    expect(summary(contextViolations('broken.yml', source))).toEqual([
      'broken.yml: st1-mac-fifo jobs.<id>.env.TMPDIR uses disallowed runner context'
    ])
  })

  it('rejects runner, steps and job contexts in job-level env', () => {
    const source = `name: Broken
on:
  pull_request:
jobs:
  invalid-env:
    runs-on: ubuntu-latest
    env:
      FROM_RUNNER: \${{ runner.temp }}
      FROM_STEPS: \${{ steps.build.outputs.path }}
      FROM_JOB: \${{ job.status }}
    steps:
      - run: echo ok
`
    expect(summary(contextViolations('broken.yml', source))).toEqual([
      'broken.yml: invalid-env jobs.<id>.env.FROM_RUNNER uses disallowed runner context',
      'broken.yml: invalid-env jobs.<id>.env.FROM_STEPS uses disallowed steps context',
      'broken.yml: invalid-env jobs.<id>.env.FROM_JOB uses disallowed job context'
    ])
  })

  it('rejects contexts GitHub does not allow in job if and runs-on', () => {
    const source = `name: Broken
on:
  pull_request:
jobs:
  invalid-if:
    if: runner.os == 'macOS'
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  invalid-runs-on:
    runs-on: \${{ steps.labels.outputs.runner }}
    steps:
      - run: echo ok
`
    expect(summary(contextViolations('broken.yml', source))).toEqual([
      'broken.yml: invalid-if jobs.<id>.if uses disallowed runner context',
      'broken.yml: invalid-runs-on jobs.<id>.runs-on uses disallowed steps context'
    ])
  })

  it('rejects disallowed contexts in multiline job env and runs-on forms', () => {
    const source = `name: Broken
on:
  pull_request:
jobs:
  invalid-env:
    runs-on: ubuntu-latest
    env:
      FROM_RUNNER: >-
        \${{ runner.temp }}
    steps:
      - run: echo ok
  invalid-runs-on:
    runs-on:
      - self-hosted
      - \${{ runner.os }}
    steps:
      - run: echo ok
`
    expect(summary(contextViolations('broken.yml', source))).toEqual([
      'broken.yml: invalid-env jobs.<id>.env.FROM_RUNNER uses disallowed runner context',
      'broken.yml: invalid-runs-on jobs.<id>.runs-on uses disallowed runner context'
    ])
  })

  it('accepts contexts GitHub allows at the guarded job locations', () => {
    const source = `name: Valid
on:
  pull_request:
jobs:
  valid:
    if: github.event_name == 'pull_request' && inputs.suite != 'skip' && inputs.version != 'v1.2'
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
    env:
      FROM_GITHUB: \${{ github.run_id }}
      FROM_MATRIX: \${{ matrix.os }}
      FROM_NEEDS: \${{ needs.build.result }}
      FROM_SECRETS: \${{ secrets.SAMPLE }}
    steps:
      - run: echo ok
`
    expect(contextViolations('valid.yml', source)).toEqual([])
  })
})

describe('every workflow in the repository', () => {
  const files = readdirSync(workflowsDir).filter((file) => file.endsWith('.yml')).sort()

  for (const file of files) {
    it(`${file} uses only GitHub-allowed contexts in guarded job fields`, () => {
      const source = readFileSync(join(workflowsDir, file), 'utf8').replace(/\r\n/g, '\n')
      expect(summary(contextViolations(file, source))).toEqual([])
    })
  }
})
