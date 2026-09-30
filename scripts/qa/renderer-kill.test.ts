import { describe, expect, it } from 'vitest'
import { contentProblems } from './candidate-scenarios.mjs'
import {
  ALIVE_RESET_MS,
  buildReport,
  dialogScript,
  emptyObservation,
  eventCounts,
  overlayRendererMapping,
  parsePs,
  rendererRows,
  verdict
} from './renderer-kill.mjs'

const MAIN = 500

/** The audit records a run leaves: `crashes` render-process-gone crashes, `halts` halts, `reloadFailures`. */
function audit({ crashes = 4, halts = 1, reloadFailures = 0 } = {}) {
  return [
    { event: 'app.started' },
    { event: 'app.renderer.ready' },
    ...Array.from({ length: crashes }, () => ({ event: 'app.crash', kind: 'render-process-gone', reason: 'killed', exitCode: 9, fatal: false })),
    { event: 'app.crash', kind: 'uncaught-exception', fatal: true },
    ...Array.from({ length: halts }, () => ({ event: 'app.render_loop_halted', reason: 'killed', exitCode: 9 })),
    ...Array.from({ length: reloadFailures }, () => ({ event: 'app.error.reload_failed', recoveryStatus: 'unrecovered' }))
  ]
}

/** A run where every kill lands `spacingMs` after the previous one and the product behaves as specified. */
function passingRun(spacingMs = 2_500) {
  const observation = emptyObservation({ times: 4, windowS: 60 })
  observation.pids = { main: MAIN, overlayRenderers: [601, 602, 603, 604] }
  observation.kills = [601, 602, 603, 604].map((pid, index) => ({
    pid,
    atMs: index * spacingMs,
    sincePreviousKillMs: index === 0 ? null : spacingMs
  }))
  observation.reloads = [602, 603, 604].map((pid, index) => ({ afterKill: index + 1, pid, latencyMs: 1_800 }))
  observation.afterHalt = { ...observation.afterHalt, overlayRenderers: 0, rendererProcesses: 0, dialog: 'sheet', dialogMs: 400 }
  observation.events = eventCounts(audit())
  observation.quit = { viaDialog: true, exitMs: 900 }
  observation.census = { settleMs: 5_000, owned: 6, survivors: 0, orphans: 0, roles: {} }
  return observation
}

describe('verdict', () => {
  it('passes 4 kills, 3 reloads, one halt audit, the dialog, no 4th reload and a clean census', () => {
    expect(verdict(passingRun())).toEqual({ result: 'PASS', failures: [], preconditions: [] })
  })

  it('fails a reload storm: a 4th reload after the last kill and no halt', () => {
    const storm = passingRun()
    storm.afterHalt.overlayRenderers = 1
    storm.afterHalt.dialog = null
    storm.quit = { viaDialog: false, exitMs: null }
    storm.census = null
    storm.events = eventCounts(audit({ halts: 0 }))
    const judged = verdict(storm)
    expect(judged.result).toBe('FAIL')
    expect(judged.failures).toEqual([
      '0 app.render_loop_halted audits, expected 1',
      'an overlay renderer came back within 20000 ms of the last kill (reload storm)',
      'no halted dialog with Reload and Quit buttons was found through System Events',
      'the post-quit census did not run'
    ])
  })

  it('fails a missing app.render_loop_halted even when the dialog showed', () => {
    const run = passingRun()
    run.events = eventCounts(audit({ halts: 0 }))
    expect(verdict(run)).toEqual({ result: 'FAIL', failures: ['0 app.render_loop_halted audits, expected 1'], preconditions: [] })
  })

  it('fails a missing dialog even when the halt audit landed; the audit alone never proves it', () => {
    const run = passingRun()
    run.afterHalt.dialog = null
    run.quit = { viaDialog: false, exitMs: null }
    run.census = null
    expect(verdict(run)).toEqual({
      result: 'FAIL',
      failures: ['no halted dialog with Reload and Quit buttons was found through System Events', 'the post-quit census did not run'],
      preconditions: []
    })
  })

  it('is a PRECONDITION, not a FAIL, when a slow cadence let the budget reset, even if a 4th reload followed', () => {
    const slow = passingRun()
    slow.kills[3] = { ...slow.kills[3], atMs: slow.kills[2].atMs + ALIVE_RESET_MS + 1_000, sincePreviousKillMs: ALIVE_RESET_MS + 1_000 }
    slow.afterHalt.overlayRenderers = 1
    slow.events = eventCounts(audit({ halts: 0 }))
    expect(verdict(slow)).toEqual({
      result: 'PRECONDITION',
      failures: [],
      preconditions: ['kill 4 landed 31000 ms after the previous one; the budget may have reset']
    })
    expect(verdict(passingRun(ALIVE_RESET_MS - 1)).result).toBe('PRECONDITION')
    expect(verdict(passingRun(ALIVE_RESET_MS - 1)).preconditions).toEqual(['the kills spanned 89997 ms, not within 60 s'])
  })

  it('fails a reload that never came, a failed reload, a dead main and a census survivor or orphan', () => {
    const noReload = passingRun()
    noReload.kills = noReload.kills.slice(0, 2)
    noReload.reloads = noReload.reloads.slice(0, 1)
    expect(verdict(noReload).failures).toContain('2 of 4 kills landed')
    expect(verdict(noReload).failures).toContain('1 automatic reloads were observed, expected 3')

    const reloadFailed = passingRun()
    reloadFailed.events = eventCounts(audit({ reloadFailures: 1 }))
    expect(verdict(reloadFailed).failures).toEqual(['1 app.error.reload_failed audits'])

    const mainDied = passingRun()
    mainDied.mainAliveThroughout = false
    expect(verdict(mainDied).failures).toEqual(['the main process died during the run'])

    const stray = passingRun()
    stray.census = { settleMs: 5_000, owned: 6, survivors: 1, orphans: 1, roles: { 'llama-server': 1 } }
    expect(verdict(stray).failures).toEqual([
      '1 owned processes survived the quit',
      '1 orphans remained under the install root'
    ])
  })

  it('reports an aborted harness as its own outcome', () => {
    const ambiguous = emptyObservation({ times: 4, windowS: 60 })
    ambiguous.aborted = { kind: 'PRECONDITION', reason: 'the overlay renderer pid is ambiguous: CDP reports 2 renderer processes' }
    expect(verdict(ambiguous).result).toBe('PRECONDITION')
    const failed = emptyObservation({ times: 4, windowS: 60 })
    failed.aborted = { kind: 'FAIL', reason: 'the app never recorded app.renderer.ready' }
    expect(verdict(failed)).toEqual({ result: 'FAIL', failures: ['the app never recorded app.renderer.ready'], preconditions: [] })
  })
})

describe('eventCounts', () => {
  it('counts only render-process-gone crashes, halts and reload failures', () => {
    expect(eventCounts(audit({ crashes: 4, halts: 1, reloadFailures: 2 }))).toEqual({
      'app.renderer.ready': 1,
      'app.crash render-process-gone': 4,
      'app.render_loop_halted': 1,
      'app.error.reload_failed': 2
    })
  })
})

describe('overlayRendererMapping', () => {
  it('maps the one toto page to the one renderer that CDP and the process table agree on', () => {
    expect(overlayRendererMapping({ totoPages: 1, cdpRendererPids: [601], psRendererPids: [601] })).toEqual({ pid: 601 })
  })

  it('refuses to guess when the mapping is ambiguous or missing', () => {
    expect(overlayRendererMapping({ totoPages: 0, cdpRendererPids: [601], psRendererPids: [601] })).toEqual({ problem: 'no page exposes window.toto' })
    expect(overlayRendererMapping({ totoPages: 2, cdpRendererPids: [601], psRendererPids: [601] })).toHaveProperty('problem')
    expect(overlayRendererMapping({ totoPages: 1, cdpRendererPids: [601, 602], psRendererPids: [601, 602] })).toEqual({
      problem: 'CDP reports 2 renderer processes'
    })
    expect(overlayRendererMapping({ totoPages: 1, cdpRendererPids: [], psRendererPids: [601] })).toHaveProperty('problem')
    expect(overlayRendererMapping({ totoPages: 1, cdpRendererPids: [601], psRendererPids: [700] })).toHaveProperty('problem')
    expect(overlayRendererMapping({ totoPages: 1, cdpRendererPids: [601], psRendererPids: [601, 700] })).toHaveProperty('problem')
  })
})

describe('rendererRows', () => {
  it('finds renderer processes at any depth below main only', () => {
    const rows = parsePs(
      [
        '  500     1 Wed Sep 30 10:00:00 2026 /Applications/X.app/Contents/MacOS/X --remote-debugging-port=9',
        '  510   500 Wed Sep 30 10:00:01 2026 /Applications/X.app/Contents/Frameworks/X Helper (GPU).app/X --type=gpu-process',
        '  601   500 Wed Sep 30 10:00:02 2026 /Applications/X.app/Contents/Frameworks/X Helper (Renderer).app/X --type=renderer --lang=en',
        '  602   510 Wed Sep 30 10:00:03 2026 /Applications/X.app/Contents/Frameworks/X Helper (Renderer).app/X --type=renderer',
        '  700     1 Wed Sep 30 10:00:04 2026 /Applications/Other.app/Other --type=renderer',
        'garbage line'
      ].join('\n')
    )
    expect(rows).toHaveLength(5)
    expect(rendererRows(rows, MAIN).map((row) => row.pid)).toEqual([601, 602])
  })
})

describe('dialogScript', () => {
  it('looks for a sheet or window with both Reload and Quit buttons in the main process only', () => {
    const find = dialogScript(MAIN, 'find')
    expect(find).toContain('first process whose unix id is 500')
    expect(find).toContain('(exists button "Reload" of s) and (exists button "Quit" of s)')
    expect(find).toContain('return "sheet"')
    expect(find).not.toContain('click')
    const quit = dialogScript(MAIN, 'quit')
    expect(quit).toContain('click button "Quit" of s')
    expect(quit).toContain('click button "Quit" of w')
    expect(() => dialogScript(Number.NaN, 'find')).toThrow(/positive integer pid/)
  })
})

describe('the report', () => {
  it('is content-free: pids, counts, timings and event counts only', () => {
    const report = buildReport(passingRun())
    expect(report).toMatchObject({ schema: 1, ticket: 'M2-0469', proves: 'M2-0037', result: 'PASS' })
    expect(report.kills.map((kill) => kill.atMs)).toEqual([0, 2_500, 5_000, 7_500])
    expect(report.reloads.map((reload) => reload.latencyMs)).toEqual([1_800, 1_800, 1_800])
    expect(contentProblems(JSON.stringify(report), { account: 'runner' })).toEqual([])
    expect(JSON.stringify(report)).not.toMatch(/\/|\\|Métis keeps crashing/)
  })
})
