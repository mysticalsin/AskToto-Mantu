import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { formatCommand, formatStepResult, parseArgs, releasePlans, runPlan } from './orchestrate.mjs'

function commandText(target: keyof typeof releasePlans): string[] {
  return releasePlans[target].map(formatCommand)
}

function stepIndex(commands: string[], needle: string): number {
  const index = commands.findIndex((command) => command.includes(needle))
  expect(index, `missing release step: ${needle}`).toBeGreaterThanOrEqual(0)
  return index
}

describe('M2-0054 release orchestrator', () => {
  it('keeps existing npm release script names mapped to their platform plans', () => {
    expect(parseArgs(['--script-name', 'release']).target).toBe('mac')
    expect(parseArgs(['--script-name', 'release:build:mac']).target).toBe('mac')
    expect(parseArgs(['--script-name', 'release:win']).target).toBe('win')
    expect(parseArgs(['--script-name', 'release:build:win']).target).toBe('win')
    expect(parseArgs(['--script-name', 'release:mas']).target).toBe('mas')
    expect(parseArgs(['--script-name', 'release:win:store']).target).toBe('win-store')
  })

  it('dry-run lists every step without executing embedding, signing, or packaging commands', async () => {
    const log: string[] = []
    const code = await runPlan('mac', {
      dryRun: true,
      log: (line: string) => log.push(line),
      runner: () => {
        throw new Error('dry-run must not execute commands')
      }
    })

    expect(code).toBe(0)
    expect(log).toHaveLength(releasePlans.mac.length)
    expect(log[0]).toContain('name="Embed Cloudflare key"')
    expect(log[0]).toContain('exitCode=not-run')
    expect(log[0]).toContain('durationMs=0')
    expect(log.join('\n')).toContain('verify-signing.mjs --require-notarized')
    expect(log.join('\n')).toContain('electron-builder --mac --universal')
  })

  it('reports every executed step with name, exit code, and duration', async () => {
    const log: string[] = []
    const runner = () => {
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    }

    const code = await runPlan('win-store', { log: (line: string) => log.push(line), runner })
    const results = log.filter((line) => line.startsWith('[release:ok]'))

    expect(code).toBe(0)
    expect(results).toHaveLength(releasePlans['win-store'].length)
    expect(results[0]).toMatch(/name="[^"]+"/)
    expect(results[0]).toContain('exitCode=0')
    expect(results[0]).toMatch(/durationMs=\d+/)
  })

  it('stops at the first failing step and reports the failed exit code', async () => {
    let calls = 0
    const log: string[] = []
    const runner = () => {
      calls += 1
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('close', calls === 2 ? 7 : 0, null))
      return child
    }

    const code = await runPlan('win-store', { log: (line: string) => log.push(line), runner })

    expect(code).toBe(7)
    expect(calls).toBe(2)
    expect(log.some((line) => line.includes('exitCode=7'))).toBe(true)
  })

  it('formats dry-run and executed step reports with the same diagnostic fields', () => {
    expect(formatStepResult({
      index: 1,
      total: 2,
      name: 'Fixture',
      exitCode: 0,
      durationMs: 12,
      command: 'node fixture.mjs',
      dryRun: false
    })).toBe('[release:ok] step=1/2 name="Fixture" exitCode=0 durationMs=12 command="node fixture.mjs"')
  })
})

describe('release plan invariants', () => {
  it('keeps mac release signing and launch checks after packaging', () => {
    const commands = commandText('mac')
    const pack = stepIndex(commands, 'electron-builder --mac --universal')
    expect(stepIndex(commands, 'scripts/check-provisioned-secrets.mjs --profile release')).toBeLessThan(pack)
    expect(stepIndex(commands, 'scripts/check-packaged-runtime.mjs mac')).toBeGreaterThan(pack)
    expect(stepIndex(commands, 'scripts/verify-signing.mjs --require-notarized')).toBeGreaterThan(pack)
    expect(stepIndex(commands, 'ASKTOTO_MAC_LAUNCH_GATE=1')).toBeGreaterThan(pack)
    expect(stepIndex(commands, 'scripts/check-embedded-cloudflare-key.mjs release/mac-universal')).toBeGreaterThan(pack)
  })

  it('keeps Windows host and credential gates before packaging', () => {
    const commands = commandText('win')
    const pack = stepIndex(commands, 'electron-builder --config electron-builder.win.yml --win --x64')
    expect(stepIndex(commands, 'scripts/check-build-host.mjs win')).toBe(0)
    expect(stepIndex(commands, 'scripts/check-cloudflare-key-valid.mjs')).toBeLessThan(pack)
    expect(stepIndex(commands, 'scripts/check-provisioned-secrets.mjs --profile release')).toBeLessThan(pack)
    expect(stepIndex(commands, 'scripts/verify-signing.mjs')).toBeGreaterThan(pack)
    expect(stepIndex(commands, 'scripts/check-packaged-launch.mjs release/win-unpacked/Metis.exe')).toBeGreaterThan(pack)
  })

  it('keeps platform-specific Electron Builder configuration in the release targets', () => {
    expect(commandText('win').join('\n')).toContain('electron-builder --config electron-builder.win.yml --win --x64')
    expect(commandText('win-store').join('\n')).toContain(
      'electron-builder --config electron-builder.win.yml --win appx --x64'
    )
    expect(commandText('mas').join('\n')).toContain('scripts/provision-electron-dist.mjs --platform=mas arm64')
    expect(commandText('mas').join('\n')).toContain('electron-builder --mac mas --arm64 -c.electronDist=resources/electron-dist')
  })
})
