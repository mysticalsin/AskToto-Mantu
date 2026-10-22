import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectInstallers, runLeanRelease } from './lean-release.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'metis-lean-release-'))
  roots.push(root)
  return root
}

const plan = {
  outputDir: 'out/lean',
  appDir: 'out/lean/app',
  steps: [
    { name: 'first', command: 'node', args: ['a.mjs'], env: { METIS_PACKAGE_PROFILE: 'lean' } },
    { name: 'second', command: 'npm', args: ['run', 'build'] },
    { name: 'collect', collect: { from: 'out/lean', to: 'out', pattern: '\\.(dmg|zip|exe)$' } }
  ]
}

describe('lean release runner (G11)', () => {
  it('runs each step in order with its own environment layered over the caller environment', async () => {
    const calls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = []
    const code = await runLeanRelease(plan, {
      env: { PATH: 'synthetic-path', METIS_PACKAGE_PROFILE: 'full' },
      log: () => undefined,
      spawnStep: async (command: string, args: string[], env: Record<string, string | undefined>) => {
        calls.push({ command, args, env })
        return 0
      },
      collect: async () => []
    })
    expect(code).toBe(0)
    expect(calls.map((call) => `${call.command} ${call.args.join(' ')}`)).toEqual(['node a.mjs', 'npm run build'])
    // A caller exporting METIS_PACKAGE_PROFILE=full cannot turn a lean step into a full one.
    expect(calls[0].env.METIS_PACKAGE_PROFILE).toBe('lean')
    expect(calls[1].env.METIS_PACKAGE_PROFILE).toBe('lean')
    expect(calls[0].env.PATH).toBe('synthetic-path')
  })

  it('stops at the first failing step and reports its exit code', async () => {
    const calls: string[] = []
    const code = await runLeanRelease(plan, {
      env: {},
      log: () => undefined,
      spawnStep: async (command: string, args: string[]) => {
        calls.push(`${command} ${args.join(' ')}`)
        return calls.length === 1 ? 3 : 0
      },
      collect: async () => {
        throw new Error('must not collect after a failed step')
      }
    })
    expect(code).toBe(3)
    expect(calls).toEqual(['node a.mjs'])
  })

  it('dry-run lists every step and executes nothing', async () => {
    const log: string[] = []
    const code = await runLeanRelease(plan, {
      dryRun: true,
      env: {},
      log: (line: string) => log.push(line),
      spawnStep: async () => {
        throw new Error('dry-run must not spawn')
      },
      collect: async () => {
        throw new Error('dry-run must not move files')
      }
    })
    expect(code).toBe(0)
    expect(log).toHaveLength(plan.steps.length)
    expect(log[0]).toContain('METIS_PACKAGE_PROFILE=lean node a.mjs')
  })

  it('moves only top-level installers into the release directory and leaves unpacked app trees alone', async () => {
    const root = temp()
    const from = join(root, 'lean')
    mkdirSync(join(from, 'mac-arm64', 'Metis.app'), { recursive: true })
    writeFileSync(join(from, 'Metis-2.12.0-arm64.dmg'), 'dmg')
    writeFileSync(join(from, 'Metis-2.12.0-arm64.zip'), 'zip')
    writeFileSync(join(from, 'Metis-2.12.0-arm64.dmg.blockmap'), 'map')
    writeFileSync(join(from, 'builder-debug.yml'), 'debug')
    const moved = await collectInstallers({ from, to: root, pattern: '\\.(dmg|zip|exe)$' })
    expect(moved.sort()).toEqual(['Metis-2.12.0-arm64.dmg', 'Metis-2.12.0-arm64.zip'])
    expect(readdirSync(root).sort()).toEqual(['Metis-2.12.0-arm64.dmg', 'Metis-2.12.0-arm64.zip', 'lean'])
    expect(readdirSync(from).sort()).toEqual(['Metis-2.12.0-arm64.dmg.blockmap', 'builder-debug.yml', 'mac-arm64'])
  })

  it('refuses to collect when the build produced no installer, so an empty lane cannot look green', async () => {
    const root = temp()
    mkdirSync(join(root, 'lean'))
    await expect(
      collectInstallers({ from: join(root, 'lean'), to: root, pattern: '\\.(dmg|zip|exe)$' })
    ).rejects.toThrow(/no installer/)
  })
})
