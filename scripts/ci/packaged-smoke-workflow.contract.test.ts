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

interface WorkflowStep {
  name: string
  text: string
}

function macSteps(): WorkflowStep[] {
  const macJob = workflow.slice(workflow.indexOf('\n  mac:\n'), workflow.indexOf('\n  windows:\n'))
  return macJob
    .split('\n      - ')
    .slice(1)
    .map((text) => ({ name: text.match(/name:\s+(.+)/)?.[1] ?? text.split('\n')[0], text }))
}

const probeStepName = 'Probe tccutil reset ScreenCapture without sudo (report only)'
const launchStepName = 'Launch, exercise RV reopen routes, quit cleanly, and check that nothing survives'

function probeCommands(): string {
  const step = macSteps().find((candidate) => candidate.name === probeStepName)
  expect(step, 'tccutil probe step not found in the mac job').toBeDefined()
  return step!.text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#') && !line.startsWith('name:'))
    .join('\n')
}

describe('packaged-smoke tccutil probe (M2-0472)', () => {
  it('sits in the mac job after the last app launch and only in the mac job', () => {
    const names = macSteps().map((step) => step.name)
    const probe = names.indexOf(probeStepName)
    expect(probe).toBeGreaterThan(-1)
    expect(probe).toBeGreaterThan(names.indexOf(launchStepName))
    const launchesAfter = macSteps()
      .slice(probe + 1)
      .filter((step) => /packaged-smoke\.mjs|hk-m\.mjs|sidecar-boot-reaper\.mjs/.test(step.text))
    expect(launchesAfter).toEqual([])
    expect(workflow.slice(workflow.indexOf('\n  windows:\n'))).not.toContain('tccutil')
  })

  it('resets only ScreenCapture for the bundle id read from the installed Info.plist', () => {
    const commands = probeCommands()
    expect(commands).toContain("PlistBuddy -c 'Print :CFBundleIdentifier' \"$RUNNER_TEMP/smoke/Metis.app/Contents/Info.plist\"")
    const calls = commands.split('\n').filter((line) => /\/usr\/bin\/tccutil\b/.test(line))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/usr/bin/tccutil reset ScreenCapture "$bundle"')
    expect([...commands.matchAll(/\/usr\/bin\/tccutil\s+(\S+)\s+(\S+)/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(['reset ScreenCapture'])
    expect(commands).toContain('uid=$(id -u)')
    expect(commands).toContain('[ "$uid" -eq 0 ]')
  })

  it('never uses sudo for tccutil', () => {
    const commands = probeCommands()
    for (const line of commands.split('\n')) {
      if (/\btccutil\b/.test(line)) expect(line).not.toMatch(/\bsudo\b/)
    }
    expect(commands).not.toMatch(/sudo\s+(-\S+\s+)*\/usr\/bin/)
    // Every sudo is the row-B sqlite3 seed/cleanup, the `tcc_has sudo` read of that database, or the root-user notice.
    const remaining = commands
      .replace(/\bsudo sqlite3\b/g, '')
      .replace(/\btcc_has sudo\b/g, '')
      .replace(/so a non-sudo reset cannot be measured/, '')
    expect(remaining).not.toMatch(/\bsudo\b/)
    expect(commands.match(/\bsudo sqlite3\b/g)).toHaveLength(2)
  })

  it('cannot fail the job', () => {
    const step = macSteps().find((candidate) => candidate.name === probeStepName)!.text
    expect(step).toContain('continue-on-error: true')
    expect(step).toContain('set +eo pipefail')
    expect(step.trimEnd().endsWith('exit 0')).toBe(true)
    expect(step).toContain('::notice title=tccutil probe::')
  })

  it('gates the row-B seed on workflow_dispatch', () => {
    const commands = probeCommands()
    expect(commands).toContain('EVENT_NAME: ${{ github.event_name }}')
    const gate = commands.indexOf('if [ "$EVENT_NAME" != "workflow_dispatch" ]; then')
    const seed = commands.indexOf('INSERT OR REPLACE INTO access')
    expect(gate).toBeGreaterThan(-1)
    expect(seed).toBeGreaterThan(gate)
    expect(commands.indexOf('else', gate)).toBeLessThan(seed)
    expect(commands).toContain('csrutil: $sip')
  })

  it('writes the content-free report into the uploaded smoke-report directory', () => {
    const commands = probeCommands()
    expect(commands).toContain('smoke-report/tccutil-probe.json')
    expect(commands).toContain('sw_vers -productVersion')
    expect(commands).toContain('|<bundle>|g')
    expect(commands).toContain('<path>')
    for (const field of ['schema', 'macos', 'sip', 'uid_is_root', 'rows']) expect(commands).toContain(field)
    expect(workflow).toMatch(/name: packaged-smoke-macos\n\s+path: smoke-report\/\n/)
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
