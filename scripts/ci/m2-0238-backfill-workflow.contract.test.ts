import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'm2-0238-backfill.yml'), 'utf8').replace(/\r\n/g, '\n')
const stalePrivateLedgerWording = ['private', 'program', 'repository'].join(' ')

type Step = {
  name?: string
  uses?: string
  usesVersionComment?: string
  if?: string
  with: Record<string, string>
  run?: string
}

function jobsBlock(source: string): string {
  const start = source.indexOf('\njobs:\n')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start + 1)
}

function workflowSteps(source: string): Step[] {
  const steps: Step[] = []
  let current: Step | undefined
  let inWith = false
  let runLines: string[] | undefined

  for (const line of jobsBlock(source).split('\n')) {
    const stepStart = /^ {6}- (?:name: (.*)|uses: (.*))$/.exec(line)
    if (stepStart) {
      if (current) steps.push(current)
      current = { with: {} }
      inWith = false
      runLines = undefined
      if (stepStart[1]) current.name = stepStart[1]
      if (stepStart[2]) {
        const parsedUses = parseUses(stepStart[2])
        current.uses = parsedUses.ref
        current.usesVersionComment = parsedUses.versionComment
      }
      continue
    }
    if (!current) continue

    const key = /^ {8}(name|uses|if): (.*)$/.exec(line)
    if (key) {
      if (key[1] === 'uses') {
        const parsedUses = parseUses(key[2])
        current.uses = parsedUses.ref
        current.usesVersionComment = parsedUses.versionComment
      } else {
        current[key[1] as 'name' | 'if'] = key[2]
      }
      inWith = false
      runLines = undefined
      continue
    }

    if (line === '        with:') {
      inWith = true
      runLines = undefined
      continue
    }
    const withEntry = /^ {10}([A-Za-z0-9_-]+): (.*)$/.exec(line)
    if (inWith && withEntry) {
      current.with[withEntry[1]] = withEntry[2]
      continue
    }

    const run = /^ {8}run: (.*)$/.exec(line)
    if (run) {
      inWith = false
      if (run[1] === '|') {
        runLines = []
        current.run = ''
      } else {
        current.run = run[1]
        runLines = undefined
      }
      continue
    }
    if (runLines && /^ {10}/.test(line)) {
      runLines.push(line.slice(10))
      current.run = runLines.join('\n')
    }
  }

  if (current) steps.push(current)
  return steps
}

function parseUses(value: string): { ref: string; versionComment?: string } {
  const match = /^(\S+)(?:\s+(#\s*v\d+\.\d+\.\d+))?$/.exec(value)
  expect(match).not.toBeNull()
  return { ref: match?.[1] ?? value, versionComment: match?.[2] }
}

const steps = workflowSteps(workflow)
const stepNamed = (name: string): Step => {
  const step = steps.find((candidate) => candidate.name === name)
  expect(step).toBeDefined()
  return step as Step
}

describe('M2-0238 evidence back-fill workflow', () => {
  it('documents that the public program ledger can use the job token and the dedicated secret is optional', () => {
    const header = workflow.slice(0, workflow.indexOf('\nrun-name:'))
    expect(header).toContain('program ledger repository is public since OD-37')
    expect(header).toContain('LEDGER_REPO_TOKEN is optional')
    expect(header).toContain('When LEDGER_REPO_TOKEN is configured it still takes precedence.')
    expect(header).not.toContain('LEDGER_REPO_TOKEN repository secret with read access')
    expect(workflow).not.toContain(stalePrivateLedgerWording)
  })

  it('checks out a supplied ledger repository with the optional secret first and github.token fallback', () => {
    const checkout = stepNamed('Checkout the ledger repository')
    expect(checkout.if).toBe("inputs.ledger_repository != ''")
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/)
    expect(checkout.usesVersionComment).toBe('# v4.4.0')
    expect(checkout.with.repository).toBe('${{ inputs.ledger_repository }}')
    expect(checkout.with.ref).toBe('${{ inputs.ledger_ref }}')
    expect(checkout.with.token).toBe('${{ secrets.LEDGER_REPO_TOKEN || github.token }}')
    expect(checkout.with.path).toBe('.ledger-repo')
    expect(checkout.with['persist-credentials']).toBe('false')
  })

  it('summarizes only when the bundle README exists, preserving the first failing step as the only error', () => {
    const summarize = stepNamed('Summarize the back-fill bundle')
    expect(summarize.if).toBe('always()')
    expect(summarize.run).toBe(
      [
        'if [ -f out/m2-0238-backfill/README.md ]; then',
        '  cat out/m2-0238-backfill/README.md >> "$GITHUB_STEP_SUMMARY"',
        'fi'
      ].join('\n')
    )
  })
})
