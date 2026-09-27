import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')

interface Job {
  needs: string[]
  concurrency: { group: string; cancelInProgress: boolean } | null
  uploads: string[]
  downloads: string[]
}

interface WorkflowModel {
  workflowConcurrencyGroup: string | null
  jobs: Record<string, Job>
}

const SHARED = ['release-quality']
const MAC = ['release-macos', 'publish-macos']
const WIN = ['release-windows', 'publish-windows']

function parseNeeds(value: string, job: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${job} uses unsupported needs syntax; model it before adding it`)
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  if (trimmed.startsWith('[') || trimmed.endsWith(']')) {
    throw new Error(`${job} uses unsupported needs syntax; model it before adding it`)
  }
  return [trimmed]
}

function parseWorkflow(source: string): WorkflowModel {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const jobs: Record<string, Job> = {}
  const allowedJobKeys = new Set(['name', 'needs', 'runs-on', 'timeout-minutes', 'strategy', 'concurrency', 'steps'])
  let inJobs = false
  let currentJob: string | null = null
  let currentAction: 'upload' | 'download' | null = null
  let waitingForArtifactName = false
  let workflowConcurrencyGroup: string | null = null
  let inWorkflowConcurrency = false

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue

    if (line === 'concurrency:') {
      inWorkflowConcurrency = true
      continue
    }
    if (inWorkflowConcurrency) {
      if (/^\S/.test(line)) inWorkflowConcurrency = false
      else {
        const group = line.match(/^  group:\s*(.+)$/)
        if (group) workflowConcurrencyGroup = group[1].trim()
        continue
      }
    }

    if (line === 'jobs:') {
      inJobs = true
      continue
    }
    if (!inJobs) continue

    const jobHeader = line.match(/^  ([a-z][a-z0-9-]*):$/)
    if (jobHeader) {
      currentJob = jobHeader[1]
      jobs[currentJob] = { needs: [], concurrency: null, uploads: [], downloads: [] }
      currentAction = null
      waitingForArtifactName = false
      continue
    }
    if (!currentJob) continue

    if (line.includes('continue-on-error:')) {
      throw new Error(`${currentJob} uses continue-on-error; model it before adding it`)
    }

    const jobKey = line.match(/^    ([a-zA-Z][\w-]*):\s*(.*)$/)
    if (jobKey) {
      const [, key, value] = jobKey
      if (!allowedJobKeys.has(key)) throw new Error(`${currentJob} has job-level ${key}; model it before adding it`)
      if (key === 'needs') jobs[currentJob].needs = parseNeeds(value, currentJob)
      if (key === 'concurrency') {
        jobs[currentJob].concurrency = { group: '', cancelInProgress: true }
      }
      currentAction = null
      waitingForArtifactName = false
      continue
    }

    if (line.match(/^      - uses:\s*actions\/upload-artifact@/)) {
      currentAction = 'upload'
      waitingForArtifactName = true
      continue
    }
    if (line.match(/^      - uses:\s*actions\/download-artifact@/)) {
      currentAction = 'download'
      waitingForArtifactName = true
      continue
    }
    if (waitingForArtifactName && line.match(/^        pattern:/)) {
      throw new Error(`${currentJob} downloads artifacts by pattern; model it before adding it`)
    }
    if (waitingForArtifactName && currentAction) {
      const artifactName = line.match(/^          name:\s*(.+)$/)
      if (artifactName) {
        jobs[currentJob][currentAction === 'upload' ? 'uploads' : 'downloads'].push(artifactName[1].trim())
        waitingForArtifactName = false
        currentAction = null
      }
    }

    const group = line.match(/^      group:\s*(.+)$/)
    const concurrency = jobs[currentJob].concurrency
    if (group && concurrency) concurrency.group = group[1].trim()
    const cancel = line.match(/^      cancel-in-progress:\s*(true|false)$/)
    if (cancel && concurrency) {
      concurrency.cancelInProgress = cancel[1] === 'true'
    }
  }

  for (const [name, job] of Object.entries(jobs)) {
    if (job.concurrency && (!job.concurrency.group || job.concurrency.cancelInProgress === undefined)) {
      throw new Error(`${name} has incomplete concurrency; model it before adding it`)
    }
  }
  return { workflowConcurrencyGroup, jobs }
}

function dependencyOrder(jobs: Record<string, Job>): string[] {
  const ordered: string[] = []
  const temporary = new Set<string>()
  const permanent = new Set<string>()

  function visit(name: string) {
    if (permanent.has(name)) return
    if (temporary.has(name)) throw new Error(`cycle involving ${name}; model it before adding it`)
    temporary.add(name)
    for (const need of jobs[name]?.needs ?? []) {
      if (!jobs[need]) throw new Error(`${name} needs unknown job ${need}; model it before adding it`)
      visit(need)
    }
    temporary.delete(name)
    permanent.add(name)
    ordered.push(name)
  }

  for (const name of Object.keys(jobs)) visit(name)
  return ordered
}

function jobsThatRun(jobs: Record<string, Job>, failed: string): Set<string> {
  const running = new Set<string>()
  for (const name of dependencyOrder(jobs)) {
    if (name === failed) continue
    if (jobs[name].needs.every((need) => running.has(need))) running.add(name)
  }
  return running
}

function ancestors(jobs: Record<string, Job>, name: string): Set<string> {
  const found = new Set<string>()
  const stack = [...jobs[name].needs]
  while (stack.length > 0) {
    const next = stack.pop()
    if (!next || found.has(next)) continue
    found.add(next)
    stack.push(...jobs[next].needs)
  }
  return found
}

function modelReleaseWorkflow(): WorkflowModel {
  return parseWorkflow(readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8'))
}

describe('release.yml independent platform publication lanes (M2-0053)', () => {
  it('rejects block-sequence needs syntax before modelling the workflow', () => {
    expect(() =>
      parseWorkflow(
        [
          'jobs:',
          '  release-quality:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '  release-macos:',
          '    needs:',
          '      - release-quality',
          '    runs-on: macos-latest',
          '    steps:',
          ''
        ].join('\n')
      )
    ).toThrow('release-macos uses unsupported needs syntax; model it before adding it')
  })

  it('models every job in release.yml', () => {
    const { jobs } = modelReleaseWorkflow()
    expect(Object.keys(jobs).sort()).toEqual([...SHARED, ...MAC, ...WIN].sort())
  })

  for (const job of MAC) {
    it(`a failing ${job} never stops publish-windows`, () => {
      const { jobs } = modelReleaseWorkflow()
      const running = jobsThatRun(jobs, job)
      expect(running.has('publish-windows')).toBe(true)
      expect(running.has('publish-macos')).toBe(false)
    })
  }

  for (const job of WIN) {
    it(`a failing ${job} never stops publish-macos`, () => {
      const { jobs } = modelReleaseWorkflow()
      const running = jobsThatRun(jobs, job)
      expect(running.has('publish-macos')).toBe(true)
      expect(running.has('publish-windows')).toBe(false)
    })
  }

  it('the shared source gate binds both platforms', () => {
    const { jobs } = modelReleaseWorkflow()
    const running = jobsThatRun(jobs, 'release-quality')
    expect(running.has('publish-macos')).toBe(false)
    expect(running.has('publish-windows')).toBe(false)
  })

  it('each publish job stands on exactly its own build and the shared gate', () => {
    const { jobs } = modelReleaseWorkflow()
    expect([...ancestors(jobs, 'publish-macos')].sort()).toEqual(['release-macos', 'release-quality'])
    expect([...ancestors(jobs, 'publish-windows')].sort()).toEqual(['release-quality', 'release-windows'])
  })

  it('each publish job consumes only its own platform bytes', () => {
    const { jobs } = modelReleaseWorkflow()
    expect(jobs['publish-macos'].downloads).toEqual(['metis-release-macos'])
    expect(jobs['publish-windows'].downloads).toEqual(['metis-release-windows'])

    for (const [name, job] of Object.entries(jobs)) {
      const ancestorUploads = new Set([...ancestors(jobs, name)].flatMap((ancestor) => jobs[ancestor].uploads))
      for (const download of job.downloads) {
        expect(ancestorUploads.has(download), `${name} downloads ${download} from one of its ancestors`).toBe(true)
      }
    }
  })

  it('the two publish jobs take turns on the feed release', () => {
    const { workflowConcurrencyGroup, jobs } = modelReleaseWorkflow()
    const mac = jobs['publish-macos'].concurrency
    const win = jobs['publish-windows'].concurrency

    expect(mac).not.toBeNull()
    expect(win).not.toBeNull()
    expect(mac?.group).toBe(win?.group)
    expect(mac?.cancelInProgress).toBe(false)
    expect(win?.cancelInProgress).toBe(false)
    expect(mac?.group).not.toBe(workflowConcurrencyGroup)
    expect(workflowConcurrencyGroup).toBe('metis-release-${{ github.ref }}')
  })
})
