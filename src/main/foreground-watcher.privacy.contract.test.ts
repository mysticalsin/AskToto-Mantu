/**
 * G47 / R111 / owner decision D-19: the ambient foreground watcher is only a transient, in-memory trigger.
 * No history is persisted, nothing is logged or audited, and nothing runs while no consumer is active.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const macHelperMock = vi.hoisted(() => ({
  macWatcherSpawnSpec: vi.fn((): { command: string; args: string[] } | null => null)
}))
vi.mock('./mac-helper', () => macHelperMock)

import { readModuleSource } from '../test-helpers/module-source'
import { startForegroundWatcher, type ForegroundInfo, type ForegroundWatcher } from './foreground-watcher'
import { createFrontmostVerifier } from './desktop-frontmost-verifier'

const SRC = join(__dirname, '..')
const read = (name: string): string => readModuleSource(__dirname, `../${name}`).text

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

describe('foreground watcher keeps observations in memory only (R111, D-19)', () => {
  it('the module imports nothing that can persist, log, audit, report or remember', () => {
    const source = read('main/foreground-watcher')
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort()
    // Only the child process, the mac spawn spec and the pinned PowerShell path. No fs, store, logger, brain, operator.
    expect(imports).toEqual(['./mac-helper', './win-security', 'node:child_process'])
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|localStorage|auditLog|telemetry|operator|brain/i)
  })

  it('holds one latest value: thirty window changes leave a handle that can only report the last one', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `app.${i}\\t${100 + i}\\tTitle ${i}`).join('\\n')
    macHelperMock.macWatcherSpawnSpec.mockReturnValue({
      command: process.execPath,
      args: ['-e', `process.stdout.write("${lines}\\n");setTimeout(()=>{},30000)`]
    })
    const seen: ForegroundInfo[] = []
    const w = startForegroundWatcher((info) => seen.push(info), { platform: 'darwin' })
    try {
      await vi.waitFor(() => expect(seen).toHaveLength(30), { timeout: 5000 })
      expect(w.current()).toEqual({ windowId: 'app.29', pid: 129, title: 'Title 29' })
      expect(Object.keys(w).sort()).toEqual(['current', 'healthy', 'stop'])
    } finally {
      w.stop()
    }
  })

  it('a stopped watcher stays unhealthy and spawns nothing more (idle means no process, no samples)', () => {
    macHelperMock.macWatcherSpawnSpec.mockReturnValue({
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>{},30000)']
    })
    const w = startForegroundWatcher(() => undefined, { platform: 'darwin' })
    w.stop()
    expect(w.healthy()).toBe(false)
    w.stop()
    expect(w.healthy()).toBe(false)
  })

  it('every production consumer is a known, on-demand one', () => {
    const importers = sourceFiles(join(SRC, 'main'))
      .concat(sourceFiles(join(SRC, 'shared')), sourceFiles(join(SRC, 'preload')))
      .filter((f) =>
        /from '(\.\.?\/)+(main\/)?foreground-watcher'|from '\.\/foreground-watcher'/.test(readFileSync(f, 'utf8'))
      )
      .map((f) =>
        relative(SRC, f)
          .replace(/\\/g, '/')
          .replace(/\.tsx?$/, '')
      )
      .filter((f) => f !== 'main/foreground-watcher')
      .sort()
    expect(importers).toEqual([
      'main/desktop-adapter-deps',
      'main/desktop-frontmost-verifier',
      'main/index',
      'main/screen-preprocess',
      'main/voice/command-confirm-runtime'
    ])
  })

  it('index.ts starts the watcher only through the opt-in screen-preprocess engine', () => {
    const index = read('main/index')
    const calls = [...index.matchAll(/startForegroundWatcher\(/g)]
    expect(calls).toHaveLength(1)
    const at = index.indexOf('startForegroundWatcher(')
    expect(index.slice(Math.max(0, at - 80), at)).toContain('startWatcher: (onChange) =>')
    // screen-preprocess starts it only from start(), reached only when canRun() holds the opt-in.
    const engine = read('main/screen-preprocess')
    expect(engine.match(/deps\.startWatcher\(/g)).toHaveLength(1)
    expect(engine).toMatch(/if \(canRun\(\)\) start\(\)\s*\n\s*else if \(started\) stop\(\)/)
  })

  it('the action-verification consumer starts a watcher only per observation and always stops it', async () => {
    const stops: ReturnType<typeof vi.fn>[] = []
    let starts = 0
    const verifier = createFrontmostVerifier({
      start: () => {
        starts++
        const stop = vi.fn()
        stops.push(stop)
        const handle: ForegroundWatcher = { stop, current: () => null, healthy: () => true }
        return handle
      }
    })
    expect(starts).toBe(0) // creating the verifier runs nothing
    const observation = verifier.observe('com.apple.notes', 50)
    expect(starts).toBe(1)
    observation.cancel()
    expect(stops[0]).toHaveBeenCalledTimes(1)
  })

  it('the voice-action consumer starts its watcher lazily, stops it when idle and on dispose', () => {
    const runtime = read('main/voice/command-confirm-runtime')
    expect(runtime.match(/startForegroundWatcher/g)).toHaveLength(3) // import, option type, default
    expect(runtime).toMatch(/watcher \?\?= start\(\(\) => \{\}/) // no onChange sink: latest value only
    expect(runtime).toMatch(/dispose: \(\) => \{[\s\S]*stopWatcher\(\)/)
    expect(runtime).toMatch(/FOREGROUND_IDLE_STOP_MS = 60_000/)
    expect(runtime).not.toMatch(/writeFile|appendFile|auditLog|localStorage/)
  })

  it('no consumer writes the observed window anywhere durable', () => {
    for (const rel of ['main/desktop-frontmost-verifier', 'main/screen-preprocess']) {
      const source = read(rel)
      expect(source, rel).not.toMatch(/writeFile|appendFile|createWriteStream|localStorage/)
    }
    const engine = read('main/screen-preprocess')
    // Window id, pid and title never reach a log line or an audit record.
    for (const m of engine.matchAll(/(?:audit\?\.|log\()[\s\S]*?\)\n/g)) {
      expect(m[0]).not.toMatch(/windowId|\.title|\.pid|currentWindowId/)
    }
    expect(read('main/index')).not.toMatch(/mainLog\.\w+\([^)]*(windowId|info\.title)/)
  })
})
