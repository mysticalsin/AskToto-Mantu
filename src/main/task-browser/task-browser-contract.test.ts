import { describe, expect, it } from 'vitest'
import { TASK_BROWSER_WINDOW_TITLE } from '../../shared/task-browser'
import { readModuleSource } from '../../test-helpers/module-source'

const src = (specifier: string): string => readModuleSource(__dirname, specifier).text

describe('task browser source contract', () => {
  const electron = src('../windows/task-browser-window')
  it('builds the window from the hardened preferences, on the task partition, with no preload', () => {
    expect(electron).toMatch(/webPreferences:\s*taskBrowserWebPreferences\(/)
    expect(electron).not.toMatch(/preload/)
    expect(electron).not.toMatch(/defaultSession/)
    expect(electron).toMatch(/fromPartition\(TASK_BROWSER_PARTITION\)/)
    expect(electron).toMatch(/applyTaskBrowserSessionPolicy\(/)
  })
  it('guards navigation, redirects and new windows, and keeps the title', () => {
    expect(electron).toMatch(/'will-navigate'/)
    expect(electron).toMatch(/'will-redirect'/)
    expect(electron).toMatch(/setWindowOpenHandler/)
    expect(electron).toMatch(/action:\s*'deny'/)
    expect(electron).toMatch(/'page-title-updated'/)
  })
  it('keeps the window title equal to the shared constant and follows the capture setting', () => {
    expect(electron).toContain(`title: '${TASK_BROWSER_WINDOW_TITLE}'`)
    expect(electron).toMatch(/win\.setContentProtection\(contentProtection\)/)
  })
  it('keeps the window title equal to the shared constant and follows the capture setting', () => {
    expect(electron).toContain(`title: '${TASK_BROWSER_WINDOW_TITLE}'`)
    expect(electron).toMatch(/win\.setContentProtection\(contentProtection\)/)
  })
  it('clears only the task partition', () => {
    expect(electron).toMatch(/taskBrowserElectronSession\(\)/)
    expect(electron).not.toMatch(/clearStorageData\([^)]/)
  })
  it('never wires the current-tab capability to a real browser (D-21)', () => {
    const manager = src('./task-browser-manager')
    expect(manager).not.toMatch(/desktop-adapters|osascript|applescript|execFile|child_process|shell\./i)
    expect(src('../../shared/task-browser')).toMatch(/status:\s*'unavailable'/)
  })
  it('the stop path closes task windows and the preload bridge takes no address', () => {
    expect(src('../voice/command-confirm-runtime')).toMatch(/releaseAllTaskBrowserWindows\(\)/)
    const preload = src('../../preload/task-browser')
    expect(preload).not.toMatch(/url|taskId/i)
  })
})
