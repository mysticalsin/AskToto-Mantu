import { describe, expect, it } from 'vitest'
import { classify, descendantsOf, parsePs, strays, survivors } from './fault-fatal-relaunch.mjs'

const BUNDLE = '/Applications/Metis QA.app'

describe('parsePs', () => {
  it('P1: reads pid, ppid, start time and a command with spaces, including a space-padded day', () => {
    const text = [
      '   501     1 Sun Sep  5 09:05:03 2026 /Applications/Metis QA.app/Contents/MacOS/Metis QA --remote-debugging-port=9334',
      '   777   501 Mon Sep 27 10:15:00 2026 /Applications/Metis QA.app/Contents/Frameworks/Metis Helper.app/Contents/MacOS/Metis Helper --type=gpu-process'
    ].join('\n')

    expect(parsePs(text)).toEqual([
      {
        pid: 501,
        ppid: 1,
        started: 'Sun Sep  5 09:05:03 2026',
        command: '/Applications/Metis QA.app/Contents/MacOS/Metis QA --remote-debugging-port=9334'
      },
      {
        pid: 777,
        ppid: 501,
        started: 'Mon Sep 27 10:15:00 2026',
        command: '/Applications/Metis QA.app/Contents/Frameworks/Metis Helper.app/Contents/MacOS/Metis Helper --type=gpu-process'
      }
    ])
  })
})

describe('descendantsOf', () => {
  it('P2: finds grandchildren and nothing outside the tree', () => {
    const processes = [
      { pid: 1000, ppid: 1, started: 't0', command: 'root' },
      { pid: 1001, ppid: 1000, started: 't0', command: 'child' },
      { pid: 1002, ppid: 1001, started: 't0', command: 'grandchild' },
      { pid: 2000, ppid: 1, started: 't0', command: 'unrelated' }
    ]

    const descendants = descendantsOf(processes, 1000)

    expect(descendants.map((p) => p.pid).sort()).toEqual([1001, 1002])
  })
})

describe('survivors', () => {
  it('P3: ignores a reused pid (same pid, different start time)', () => {
    const before = [{ pid: 100, ppid: 1, started: 'A', command: 'x' }]
    const reused = [{ pid: 100, ppid: 1, started: 'B', command: 'y' }]
    const same = [{ pid: 100, ppid: 1, started: 'A', command: 'x' }]

    expect(survivors(before, reused)).toEqual([])
    expect(survivors(before, same)).toEqual(before)
  })
})

describe('classify', () => {
  it('P5: returns content-free classes for every owned kind and never the command', () => {
    const cases: Array<[string, string]> = [
      [`${BUNDLE}/Contents/Resources/llama/llama-server`, 'llama-server'],
      [`${BUNDLE}/Contents/Resources/mac-helper/metis-mac-helper watch-frontmost`, 'mac-helper'],
      [`${BUNDLE}/Contents/Resources/ffmpeg/ffmpeg -i foo`, 'ffmpeg'],
      ['/usr/bin/fm serve --port 1234', 'fm-serve'],
      [
        `${BUNDLE}/Contents/Frameworks/Metis Helper.app/Contents/MacOS/Metis Helper --type=utility --utility-sub-type=node.mojom.NodeService`,
        'utility-process'
      ],
      [`${BUNDLE}/Contents/Frameworks/Metis Helper.app/Contents/MacOS/Metis Helper --type=gpu-process`, 'electron-helper'],
      [`${BUNDLE}/Contents/MacOS/Metis QA`, 'main'],
      ['/sbin/launchd', 'other']
    ]

    const classes = cases.map(([command]) => classify(command, BUNDLE))

    expect(classes).toEqual(cases.map(([, expected]) => expected))
    // Content-free: the class never carries the path, the bundle name or any command text.
    expect(classes.every((c) => !c.includes('/') && !c.includes(BUNDLE))).toBe(true)
  })
})

describe('strays', () => {
  it('P4: counts an orphan from the bundle and an orphaned fm serve, never the relaunched main or its children', () => {
    const now = [
      { pid: 1, ppid: 0, started: 't0', command: '/sbin/launchd' },
      { pid: 2001, ppid: 1, started: 't1', command: `${BUNDLE}/Contents/MacOS/Metis QA` },
      { pid: 2002, ppid: 1, started: 't1', command: `${BUNDLE}/Contents/Resources/llama/llama-server` },
      { pid: 2003, ppid: 1, started: 't1', command: '/usr/bin/fm serve --port 1234' },
      { pid: 2004, ppid: 2001, started: 't1', command: `${BUNDLE}/Contents/Resources/llama/llama-server` }
    ]

    expect(
      strays(now, BUNDLE)
        .map((p) => p.pid)
        .sort((a, b) => a - b)
    ).toEqual([2002, 2003])
  })
})
