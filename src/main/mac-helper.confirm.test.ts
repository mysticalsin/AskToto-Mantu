import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('./logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
import {
  activatePid,
  askAutomation,
  macActivatePidSpawnSpec,
  macAutomationAskSpawnSpec,
  macHelperPath
} from './mac-helper'

const REPO_ROOT = process.cwd()
const swiftSource = (): string => readFileSync(join(REPO_ROOT, 'native', 'mac-helper', 'main.swift'), 'utf8')

describe('activate-pid (V04: give focus back to the app that was in front before the card)', () => {
  it('spawn spec carries one positive integer pid as a single argv entry', () => {
    const spec = macActivatePidSpawnSpec(4242)
    if (existsSync(macHelperPath())) expect(spec).toEqual({ command: macHelperPath(), args: ['activate-pid', '4242'] })
    else expect(spec).toBeNull()
  })

  it('never spawns for a pid that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expect(macActivatePidSpawnSpec(bad)).toBeNull()
    }
  })

  it('resolves false (never throws) where the helper cannot exist', async () => {
    if (!existsSync(macHelperPath())) await expect(activatePid(4242)).resolves.toBe(false)
    await expect(activatePid(-5)).resolves.toBe(false)
  })

  it('the Swift side activates one running application by pid and is registered as a subcommand', () => {
    const swift = swiftSource().replace(/\/\/[^\r\n]*/g, '')
    expect(swift).toMatch(/case "activate-pid":/)
    expect(swift).toMatch(/NSRunningApplication\(processIdentifier:/)
  })
})

describe('automation-ask (V04: a prompt is raised before dispatch, never during it)', () => {
  it('spawn spec names the bundle id as a single argv entry and rejects an implausible one', () => {
    const spec = macAutomationAskSpawnSpec('com.apple.Notes')
    if (existsSync(macHelperPath())) {
      expect(spec).toEqual({ command: macHelperPath(), args: ['automation-ask', 'com.apple.Notes'] })
    } else {
      expect(spec).toBeNull()
    }
    for (const bad of [undefined, '', '-x', 'a b', 'com.apple.Notes; rm', '../x']) {
      expect(macAutomationAskSpawnSpec(bad as string)).toBeNull()
    }
  })

  it('resolves null (never throws) where the helper cannot exist', async () => {
    if (!existsSync(macHelperPath())) await expect(askAutomation('com.apple.Notes')).resolves.toBeNull()
  })

  it('keeps tcc-status read-only: only the separate automation-ask subcommand may ask the user', () => {
    const source = swiftSource()
    expect(source).toMatch(/case "automation-ask":/)
    const swift = source.replace(/\/\/[^\r\n]*/g, '')
    const askStart = swift.indexOf('func runAutomationAsk')
    expect(askStart).toBeGreaterThan(-1)
    expect(swift.slice(0, askStart)).not.toMatch(/AEDeterminePermissionToAutomateTarget\([^\r\n]*, true\)/)
    expect(swift.slice(askStart)).toMatch(/AEDeterminePermissionToAutomateTarget\([^\r\n]*, true\)/)
  })
})
