import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'packaged-smoke.yml'), 'utf8').replace(/\r\n/g, '\n')

interface PushEvent {
  eventName: 'push'
  ref: string
  changedPaths: string[]
}

interface WorkflowDispatchEvent {
  eventName: 'workflow_dispatch'
  ref: string
  changedPaths?: string[]
}

interface PullRequestEvent {
  eventName: 'pull_request'
  action: string
  baseRef: string
  number: number
  ref: string
}

type GitHubEvent = PushEvent | WorkflowDispatchEvent | PullRequestEvent

interface PushFilters {
  branches: string[]
  tagsIgnore: string[]
  paths: string[]
}

interface PullRequestFilters {
  branches: string[]
  types: string[]
}

function eventBlock(eventName: string): string[] {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${eventName}:`)
  expect(start, `workflow event not found: ${eventName}`).toBeGreaterThan(-1)
  const block: string[] = []

  for (const line of lines.slice(start + 1)) {
    if (/^  [A-Za-z_][A-Za-z0-9_-]*:/.test(line)) break
    block.push(line)
  }

  return block
}

function listValue(block: string[], key: string): string[] {
  const start = block.findIndex((line) => line.trimStart().startsWith(`${key}:`))
  if (start === -1) return []

  const line = block[start].trim()
  const inline = line.match(/^[A-Za-z0-9_-]+:\s*\[(.*)\]$/)
  if (inline) {
    return inline[1].split(',').map(cleanScalar).filter(Boolean)
  }

  const values: string[] = []
  for (const child of block.slice(start + 1)) {
    if (/^ {4}[A-Za-z_][A-Za-z0-9_-]*:/.test(child)) break
    const item = child.match(/^ {6}-\s+(.+)$/)
    if (item) values.push(cleanScalar(item[1]))
  }
  return values
}

function cleanScalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function pushFilters(): PushFilters {
  const block = eventBlock('push')
  return {
    branches: listValue(block, 'branches'),
    tagsIgnore: listValue(block, 'tags-ignore'),
    paths: listValue(block, 'paths')
  }
}

function pullRequestFilters(): PullRequestFilters {
  const block = eventBlock('pull_request')
  return {
    branches: listValue(block, 'branches'),
    types: listValue(block, 'types')
  }
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern === '**') return true
  if (!pattern.includes('*')) return pattern === value
  const doubleStar = '\0DOUBLE_STAR\0'
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, doubleStar)
    .replace(/\*/g, '[^/]*')
    .replaceAll(doubleStar, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

function packagedSmokeRuns(event: GitHubEvent): boolean {
  if (event.eventName === 'workflow_dispatch') return true
  if (event.eventName === 'pull_request') {
    const filters = pullRequestFilters()
    if (filters.types.length > 0 && !filters.types.includes(event.action)) return false
    if (filters.branches.length > 0 && !filters.branches.some((pattern) => globMatches(pattern, event.baseRef))) return false
    return true
  }

  const filters = pushFilters()
  const branch = event.ref.startsWith('refs/heads/') ? event.ref.slice('refs/heads/'.length) : null
  const tag = event.ref.startsWith('refs/tags/') ? event.ref.slice('refs/tags/'.length) : null

  if (tag) return !filters.tagsIgnore.some((pattern) => globMatches(pattern, tag))
  if (!branch) return false
  if (filters.branches.length > 0 && !filters.branches.some((pattern) => globMatches(pattern, branch))) return false
  if (filters.paths.length > 0 && !event.changedPaths.some((path) => filters.paths.some((pattern) => globMatches(pattern, path)))) return false
  return true
}

function packagedSmokeConcurrencyGroup(event: GitHubEvent): string {
  const expression = workflow.match(/\nconcurrency:\n  group:\s+(.+)\n/)?.[1]
  expect(expression).toBe("${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref }}")

  if (event.eventName === 'pull_request') return `packaged-smoke-pr-${event.number}`
  return `packaged-smoke-${event.ref}`
}

function packagedSmokeJobRuns(event: GitHubEvent): boolean {
  const jobIfs = [...workflow.matchAll(/\n    if:\s+(.+)\n/g)].map((match) => match[1])
  expect(jobIfs).toEqual([
    "github.event_name == 'pull_request' || startsWith(github.ref, 'refs/heads/')",
    "github.event_name == 'pull_request' || startsWith(github.ref, 'refs/heads/')"
  ])

  return event.eventName === 'pull_request' || event.ref.startsWith('refs/heads/')
}

// Resolves `${{ inputs.hk_m_cycles == '20' && A || B }}`; push and pull_request runs have no input (undefined).
function resolveCyclesExpression(value: string, hkMCycles: string | undefined): string {
  const match = value.match(/^\$\{\{ inputs\.hk_m_cycles == '20' && '?([^' ]+)'? \|\| '?([^' ]+)'? \}\}$/)
  expect(match, `not a hk_m_cycles expression: ${value}`).not.toBeNull()
  return hkMCycles === '20' ? match![1] : match![2]
}

function stepBlock(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`)
  expect(start, `step not found: ${name}`).toBeGreaterThan(-1)
  const next = workflow.indexOf('\n      - ', start + 1)
  return workflow.slice(start, next === -1 ? undefined : next)
}

function hkMStep(hkMCycles: string | undefined) {
  const block = stepBlock('Prove HK-M supervised sidecar cleanup after SIGKILL')
  const field = (pattern: RegExp) => {
    const value = block.match(pattern)?.[1]
    expect(value, `missing ${pattern}`).toBeDefined()
    return resolveCyclesExpression(value!, hkMCycles)
  }
  return {
    timeoutMinutes: Number(field(/\n {8}timeout-minutes: (.+)\n/)),
    cycles: field(/\n {10}HK_M_CYCLES: (.+)\n/),
    budgetMs: field(/\n {10}HK_M_BUDGET_MS: (.+)\n/),
    command: block.match(/\n {8}run: (.+)\n/)?.[1]
  }
}

function macJobTimeout(hkMCycles: string | undefined): number {
  const value = workflow.match(/\n {2}mac:\n(?:.*\n)*? {4}timeout-minutes: (.+)\n/)?.[1]
  expect(value).toBeDefined()
  return Number(resolveCyclesExpression(value!, hkMCycles))
}

describe('packaged-smoke workflow HK-M cycles input', () => {
  it('offers hk_m_cycles on workflow_dispatch as a choice of 1 or 20 defaulting to 1', () => {
    const block = eventBlock('workflow_dispatch')
    expect(block.join('\n')).toContain('    inputs:\n      hk_m_cycles:')
    expect(block.some((line) => line.trim() === 'type: choice')).toBe(true)
    expect(block.filter((line) => /^ {8}- /.test(line)).map((line) => cleanScalar(line.slice(10)))).toEqual(['1', '20'])
    expect(block.some((line) => line.trim() === "default: '1'")).toBe(true)
  })

  it.each([undefined, '1'])('keeps the default path at one cycle, 1200000 ms, step timeout 25 (input %s)', (input) => {
    const step = hkMStep(input)
    expect(step).toMatchObject({ timeoutMinutes: 25, cycles: '1', budgetMs: '1200000' })
    expect(step.command).toBe('node scripts/qa/hk-m.mjs "$RUNNER_TEMP/smoke/Metis.app" smoke-report/hk-m.json --cycles "$HK_M_CYCLES" --budget-ms "$HK_M_BUDGET_MS"')
    expect(macJobTimeout(input)).toBe(120)
  })

  it('runs 20 cycles with the hk-m-candidate budget and step timeout, raising the job timeout to at most 180', () => {
    const candidate = readFileSync(join(root, '.github', 'workflows', 'hk-m-candidate.yml'), 'utf8')
    const step = hkMStep('20')
    expect(step).toMatchObject({ timeoutMinutes: 140, cycles: '20', budgetMs: '8100000' })
    expect(candidate).toContain('--cycles 20 --budget-ms 8100000')
    expect(candidate).toContain('timeout-minutes: 140')
    expect(macJobTimeout('20')).toBeGreaterThan(140)
    expect(macJobTimeout('20')).toBeLessThanOrEqual(180)
  })

  it('fails a 20-cycle rehearsal unless the report is a full pass and names the cycle count', () => {
    const block = stepBlock('Fail the HK-M rehearsal unless every row passed')
    expect(block).toContain("if: always() && inputs.hk_m_cycles == '20'")
    expect(block).toContain('HK-M rehearsal: 20 cycles')
    expect(block).toContain("row.status === 'NOT_RUN'")
    expect(block).toContain("r.result === 'pass' && notRun === 0 ? 0 : 1")
    expect(block).toContain('GITHUB_STEP_SUMMARY')
  })
})

describe('packaged-smoke workflow supply chain', () => {
  it('pins every action to a full commit sha', () => {
    const uses = [...workflow.matchAll(/^\s+- uses: (\S+)/gm)].map((match) => match[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const use of uses) expect(use).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
  })

  it('uses no repository secret', () => {
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./)
  })
})

describe('packaged-smoke workflow trigger', () => {
  it('runs when a pull request into m2/integration is marked ready for review', () => {
    const event: PullRequestEvent = {
      eventName: 'pull_request',
      action: 'ready_for_review',
      baseRef: 'm2/integration',
      number: 234,
      ref: 'refs/pull/234/merge'
    }

    expect(packagedSmokeRuns(event)).toBe(true)
    expect(packagedSmokeJobRuns(event)).toBe(true)
  })

  it('does not run on other pull request actions before review', () => {
    expect(packagedSmokeRuns({
      eventName: 'pull_request',
      action: 'opened',
      baseRef: 'm2/integration',
      number: 234,
      ref: 'refs/pull/234/merge'
    })).toBe(false)
  })

  it('does not run on pull requests into other branches', () => {
    expect(packagedSmokeRuns({
      eventName: 'pull_request',
      action: 'ready_for_review',
      baseRef: 'main',
      number: 234,
      ref: 'refs/pull/234/merge'
    })).toBe(false)
  })

  it('runs on every push to m2/integration, including ordinary source-only app changes', () => {
    const event: PushEvent = {
      eventName: 'push',
      ref: 'refs/heads/m2/integration',
      changedPaths: ['src/main/index.ts']
    }

    expect(packagedSmokeRuns(event)).toBe(true)
    expect(packagedSmokeJobRuns(event)).toBe(true)
  })

  it('does not run on other branch pushes', () => {
    expect(packagedSmokeRuns({
      eventName: 'push',
      ref: 'refs/heads/m2/M2-0229-packaged-smoke',
      changedPaths: ['.github/workflows/packaged-smoke.yml']
    })).toBe(false)
  })

  it('never runs on tag pushes', () => {
    expect(packagedSmokeRuns({
      eventName: 'push',
      ref: 'refs/tags/v2.0.0',
      changedPaths: ['.github/workflows/packaged-smoke.yml']
    })).toBe(false)
  })

  it('keeps workflow_dispatch available for manual smoke runs', () => {
    expect(packagedSmokeRuns({
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/m2/M2-0229-packaged-smoke'
    })).toBe(true)
  })

  it('keeps pull request and integration push concurrency groups separate', () => {
    const pullRequestGroup = packagedSmokeConcurrencyGroup({
      eventName: 'pull_request',
      action: 'ready_for_review',
      baseRef: 'm2/integration',
      number: 234,
      ref: 'refs/pull/234/merge'
    })
    const integrationGroup = packagedSmokeConcurrencyGroup({
      eventName: 'push',
      ref: 'refs/heads/m2/integration',
      changedPaths: ['src/main/index.ts']
    })

    expect(pullRequestGroup).toBe('packaged-smoke-pr-234')
    expect(integrationGroup).toBe('packaged-smoke-refs/heads/m2/integration')
    expect(pullRequestGroup).not.toBe(integrationGroup)
  })
})
