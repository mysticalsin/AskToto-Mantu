import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleDir, captureDir, collectStallCaptures, exportableStallBundles, projectSample, MAX_BUNDLES, MAX_BUNDLE_BYTES } from './stall-bundle'

const POSIX = process.platform !== 'win32'
const BOOT_ID = '0123abcd-1111-2222-3333-444455556666'

// --- Fixture: a real sample(1) report shape, planted with content that must never survive projection. ---
const USER = 'jane.doe'
const TITLE = 'Q3 pricing review with Acme'
const TRANSCRIPT = 'we agreed to cut the price by twelve percent'
const EMAIL = 'jane.doe@example.com'
const FILE = '2026-09-26 Q3 pricing review.md'

const REPORT = [
  'Analysis of sampling Metis (pid 4242) every 10 milliseconds',
  'Process:         Metis [4242]',
  `Path:            /Users/${USER}/Applications/Metis.app/Contents/MacOS/Metis`,
  'Identifier:      com.mantu.asktoto',
  'Version:         1.9.7 (1.9.7)',
  'Parent Process:  launchd [1]',
  'Date/Time:       2026-09-26 12:00:00.000 +0200',
  'Analysis Tool:   /usr/bin/sample',
  '----',
  '',
  'Call graph:',
  `    500 Thread_81234: ${TITLE}`,
  '    + 500 thread_start  (in libsystem_pthread.dylib) + 8  [0x18d4210c0]',
  '    +   500 _pthread_start  (in libsystem_pthread.dylib) + 136  [0x18d4212e4]',
  '    +     500 worker  (in Electron Framework) + 64  [0x10a1b2c3d]  threadpool.c:77',
  '    +       500 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x18d3e2c4c]',
  `    500 Thread_81230: ${FILE}   DispatchQueue_1: com.apple.main-thread  (serial)`,
  '    + 500 start  (in dyld) + 6076  [0x18d0e2b98]',
  '    +   500 main  (in Metis) + 128  [0x1000034a0]',
  '    +     500 ???  (in Electron Framework)  load address 0x104000000 + 0x5c6a1c8  [0x109c6a1c8]',
  `    +       494 uv_fs_read  (in Electron Framework) + 300  [0x10a000000]  /Users/${USER}/src/fs.c:12`,
  '    +       ! 494 __pread_nocancel  (in libsystem_kernel.dylib) + 8  [0x18d3e1234]',
  `    +       3 open:/Users/${USER}/Meetings/${FILE}  (in libfoo.dylib) + 4  [0x10b000004]`,
  `    +       1 notify ${EMAIL}  (in /Users/${USER}/Library/libbar.dylib) + 1  [0x10b000008]`,
  '    +       1 ???  [0x10b00000c]',
  `    +       1 ${TRANSCRIPT}`,
  '',
  'Total number in stack (recursive counted multiple, when >=5):',
  '        5       _pthread_start  (in libsystem_pthread.dylib) + 136  [0x18d4212e4]',
  '',
  'Sort by top of stack, same collapsed (when >= 5):',
  '        __pread_nocancel  (in libsystem_kernel.dylib)        494',
  `        ${TRANSCRIPT}        5`,
  '',
  'Binary Images:',
  `       0x100000000 -        0x100007fff +com.mantu.asktoto (1.9.7) <00000000-0000-0000-0000-000000000000> /Users/${USER}/Applications/Metis.app/Contents/MacOS/Metis`,
  ''
].join('\n')

const EXPECTED = [
  'Thread 1 (main)  500',
  '+ 500 start  (in dyld) + 6076',
  '+   500 main  (in Metis) + 128',
  '+     500 ???  (in Electron Framework) + 0x5c6a1c8',
  '+       494 uv_fs_read  (in Electron Framework) + 300',
  '+       ! 494 __pread_nocancel  (in libsystem_kernel.dylib) + 8',
  '+       3 <redacted>  (in libfoo.dylib) + 4',
  '+       1 <redacted>  (in <redacted>) + 1',
  '+       1 ???',
  '+       1 <redacted>',
  'Thread 0  500',
  '+ 500 thread_start  (in libsystem_pthread.dylib) + 8',
  '+   500 _pthread_start  (in libsystem_pthread.dylib) + 136',
  '+     500 worker  (in Electron Framework) + 64',
  '+       500 __psynch_cvwait  (in libsystem_kernel.dylib) + 8'
]
const PLANTED = [USER, 'Users', TITLE, 'Acme', TRANSCRIPT, 'twelve', EMAIL, 'example.com', FILE, '.md', 'fs.c', 'threadpool.c']

function noPlantedContent(text: string): void {
  const lower = text.toLowerCase()
  for (const planted of PLANTED) expect(lower, `bundle leaked "${planted}"`).not.toContain(planted.toLowerCase())
  expect(text, "bundle contains '/'").not.toContain('/')
  expect(text, "bundle contains '\\\\'").not.toContain('\\')
  expect(text, "bundle contains '@'").not.toContain('@')
}

describe('projectSample', () => {
  it('keeps each thread as count, symbol, image and offset, main thread first', () => {
    expect(projectSample(REPORT)).toEqual(EXPECTED)
  })

  it('drops the header, thread names, queue labels, source locations, summary sections and Binary Images', () => {
    noPlantedContent(projectSample(REPORT).join('\n'))
  })

  it('redacts a symbol or image name holding a path, an email, a backslash or a control character, keeping count and tree', () => {
    const report = [
      'Call graph:',
      '    4 Thread_1: some thread name',
      '    + 1 foo/bar  (in Electron Framework) + 10  [0x1]',
      '    + 1 run  (in /Applications/Metis.app) + 20  [0x2]',
      '    + 1 C:\\Users\\x  (in libwin.dll) + 30  [0x3]',
      '    + 1 foo\tbar  (in lib.dylib) + 40  [0x4]',
      ''
    ].join('\n')
    expect(projectSample(report)).toEqual([
      'Thread 0  4',
      '+ 1 <redacted>  (in Electron Framework) + 10',
      '+ 1 run  (in <redacted>) + 20',
      '+ 1 <redacted>  (in libwin.dll) + 30',
      '+ 1 <redacted>  (in lib.dylib) + 40'
    ])
  })

  it('keeps an unknown frame as ??? and redacts a line outside the frame grammar, never its text', () => {
    const report = ['Call graph:', '    2 Thread_1: t', '    + 1 ???  [0x1]', '    + 1 some raw text with no frame markers', ''].join('\n')
    expect(projectSample(report)).toEqual(['Thread 0  2', '+ 1 ???', '+ 1 <redacted>'])
  })

  it('projects a report without a call graph to []', () => {
    expect(projectSample('Sampling failed: process not found')).toEqual([])
    expect(projectSample('')).toEqual([])
  })
})

describe('collectStallCaptures', () => {
  let userData: string
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'metis-stall-'))
    mkdirSync(captureDir(userData), { recursive: true })
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  function writeCapture(name: string, content: string): void {
    writeFileSync(join(captureDir(userData), name), content)
  }

  it('turns a pending capture into a bundle, deletes the capture, and reports the bundled outcome', async () => {
    const name = `${BOOT_ID}.1790000000000.23456.sample`
    writeCapture(name, REPORT)
    const outcomes = await collectStallCaptures(userData)
    const bundle = `${BOOT_ID}.1790000000000.23456.txt`
    expect(outcomes).toEqual([{ kind: 'bundled', bootId: BOOT_ID, stalledMs: 23456, bundle }])

    const bundlePath = join(bundleDir(userData), bundle)
    const contents = readFileSync(bundlePath, 'utf8')
    const lines = contents.split('\n')
    expect(lines.slice(0, 5)).toEqual([
      'metis stall bundle v1',
      `bootId: ${BOOT_ID}`,
      'capturedAt: 2026-09-21T14:13:20.000Z',
      'stalledMs: 23456',
      'source: sample(1), 5 s at 10 ms; thread stacks and symbol names only'
    ])
    expect(lines[5]).toBe('')
    expect(lines.slice(6, 6 + EXPECTED.length)).toEqual(EXPECTED)

    expect(() => statSync(join(captureDir(userData), name))).toThrow()
    if (POSIX) expect(statSync(bundlePath).mode & 0o777).toBe(0o600)
  })

  it('privacy: the whole bundle file contains no planted content and no /, \\ or @', async () => {
    writeCapture(`${BOOT_ID}.1790000000000.23456.sample`, REPORT)
    await collectStallCaptures(userData)
    const bundle = `${BOOT_ID}.1790000000000.23456.txt`
    noPlantedContent(readFileSync(join(bundleDir(userData), bundle), 'utf8'))
  })

  it('fails closed (no bundle, capture deleted) for a call-graph-free capture, an oversized capture, and a directory named like a capture', async () => {
    const noGraphName = `${BOOT_ID}.1790000000001.1000.sample`
    const hugeName = `${BOOT_ID}.1790000000002.2000.sample`
    const dirName = `${BOOT_ID}.1790000000003.3000.sample`
    writeCapture(noGraphName, 'Sampling failed: process not found')
    writeCapture(hugeName, 'placeholder')
    truncateSync(join(captureDir(userData), hugeName), 16 * 1024 * 1024 + 1) // sparse, so fast
    mkdirSync(join(captureDir(userData), dirName))

    const outcomes = await collectStallCaptures(userData)
    expect(outcomes).toEqual([
      { kind: 'failed', bootId: BOOT_ID },
      { kind: 'failed', bootId: BOOT_ID },
      { kind: 'failed', bootId: BOOT_ID }
    ])
    expect(() => statSync(join(captureDir(userData), noGraphName))).toThrow()
    expect(() => statSync(join(captureDir(userData), hugeName))).toThrow()
    // A non-file entry's rm rejects and is swallowed — it stays, harmlessly, since only names matching
    // the capture grammar are ever read.
    expect(statSync(join(captureDir(userData), dirName)).isDirectory()).toBe(true)
  })

  it('deletes a file in raw/ that is not named like a capture, and reports no outcome for it', async () => {
    writeCapture('notes.txt', 'not a capture')
    const outcomes = await collectStallCaptures(userData)
    expect(outcomes).toEqual([])
    expect(() => statSync(join(captureDir(userData), 'notes.txt'))).toThrow()
  })

  it('keeps only the newest MAX_BUNDLES bundles by capture time, leaving an unrelated file in the bundle directory untouched', async () => {
    mkdirSync(bundleDir(userData), { recursive: true })
    for (let i = 0; i < 12; i++) {
      const capturedAtMs = 1_790_000_000_000 + i
      writeFileSync(join(bundleDir(userData), `${BOOT_ID}.${capturedAtMs}.100.txt`), 'old bundle', { mode: 0o600 })
    }
    writeFileSync(join(bundleDir(userData), 'notes.txt'), 'keep me', { mode: 0o600 })
    writeCapture(`${BOOT_ID}.1790000000999.500.sample`, REPORT)

    await collectStallCaptures(userData)

    const names = readdirSync(bundleDir(userData))
    const bundles = names.filter((n) => n.endsWith('.txt') && n !== 'notes.txt')
    expect(bundles).toHaveLength(MAX_BUNDLES)
    expect(names).toContain('notes.txt')
    // The newest (highest capturedAtMs) 10 of the 13 candidate bundles survive — that is the new one plus
    // the 9 most recent of the 12 pre-existing ones (i = 3..11).
    const survivingCapturedAtMs = bundles.map((n) => Number(n.split('.')[1])).sort((a, b) => a - b)
    expect(survivingCapturedAtMs[0]).toBe(1_790_000_000_003)
    expect(survivingCapturedAtMs[survivingCapturedAtMs.length - 1]).toBe(1790000000999)
  })

  it('truncates a bundle over MAX_BUNDLE_BYTES with the main thread first and a trailing [truncated] line, staying within the cap apart from that line', async () => {
    const bigFrames = Array.from(
      { length: 25_000 },
      () => '    +       1 w  (in Electron Framework) + 1  [0x1]'
    ).join('\n')
    const report = [
      'Call graph:',
      '    2 Thread_1: not the main thread',
      '    + 1 helper  (in libsystem_pthread.dylib) + 1  [0x1]',
      '    5 Thread_2: main   DispatchQueue_1: com.apple.main-thread  (serial)',
      bigFrames,
      ''
    ].join('\n')
    writeCapture(`${BOOT_ID}.1790000000123.9999.sample`, report)
    await collectStallCaptures(userData)
    const bundle = `${BOOT_ID}.1790000000123.9999.txt`
    const lines = readFileSync(join(bundleDir(userData), bundle), 'utf8').split('\n')
    const stackSection = lines.slice(6, -1) // drop the 5 headers + blank line, and the trailing '' from the join
    expect(stackSection[0]).toBe('Thread 1 (main)  5')
    expect(stackSection[stackSection.length - 1]).toBe('[truncated]')
    const stackBytesExceptLast = stackSection
      .slice(0, -1)
      .reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
    expect(stackBytesExceptLast).toBeLessThanOrEqual(MAX_BUNDLE_BYTES)
  })

  it('resolves to [] for a missing capture directory, and for a userData path that is a file', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'metis-stall-bare-'))
    const fileParent = mkdtempSync(join(tmpdir(), 'metis-stall-file-'))
    try {
      expect(await collectStallCaptures(bare)).toEqual([])

      const file = join(fileParent, 'not-a-dir')
      writeFileSync(file, 'x')
      expect(await collectStallCaptures(file)).toEqual([])
    } finally {
      rmSync(bare, { recursive: true, force: true })
      rmSync(fileParent, { recursive: true, force: true })
    }
  })
})

describe('exportableStallBundles', () => {
  let userData: string
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'metis-stall-export-'))
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('lists a bundle the collector wrote, and never a raw capture or a stray file', async () => {
    mkdirSync(captureDir(userData), { recursive: true })
    writeFileSync(join(captureDir(userData), `${BOOT_ID}.1790000000000.23456.sample`), REPORT)
    await collectStallCaptures(userData)
    writeFileSync(join(captureDir(userData), `${BOOT_ID}.1790000000001.7000.sample`), REPORT)
    writeFileSync(join(bundleDir(userData), 'notes.txt'), 'not a bundle')

    expect(await exportableStallBundles(userData)).toEqual([`${BOOT_ID}.1790000000000.23456.txt`])
  })

  // Exactly what the collector writes for a capture named <BOOT_ID>.<capturedAtMs>.<stalledMs>.
  const bundleText = (capturedAtMs: number, stalledMs: number): string =>
    [
      'metis stall bundle v1',
      `bootId: ${BOOT_ID}`,
      `capturedAt: ${new Date(capturedAtMs).toISOString()}`,
      `stalledMs: ${stalledMs}`,
      'source: sample(1), 5 s at 10 ms; thread stacks and symbol names only',
      '',
      ...EXPECTED,
      ''
    ].join('\n')

  it('returns at most MAX_BUNDLES names, newest capture first', async () => {
    mkdirSync(bundleDir(userData), { recursive: true })
    for (let i = 0; i < 12; i++) {
      const capturedAtMs = 1_790_000_000_000 + i
      writeFileSync(join(bundleDir(userData), `${BOOT_ID}.${capturedAtMs}.6000.txt`), bundleText(capturedAtMs, 6000), { mode: 0o600 })
    }
    const names = await exportableStallBundles(userData)
    expect(names).toHaveLength(MAX_BUNDLES)
    expect(names[0]).toBe(`${BOOT_ID}.1790000000011.6000.txt`)
    expect(names[names.length - 1]).toBe(`${BOOT_ID}.1790000000002.6000.txt`)
  })

  it('never lists a bundle-named file whose content is not a collector bundle', async () => {
    mkdirSync(bundleDir(userData), { recursive: true })
    const good = `${BOOT_ID}.1790000000000.6000.txt`
    writeFileSync(join(bundleDir(userData), good), bundleText(1_790_000_000_000, 6000))
    const planted: Record<string, string> = {
      // arbitrary text
      [`${BOOT_ID}.1790000000001.6000.txt`]: `${TRANSCRIPT}\n${EMAIL}\n`,
      // a real bundle under another capture's name: the header no longer matches
      [`${BOOT_ID}.1790000000002.6000.txt`]: bundleText(1_790_000_000_000, 6000),
      // the right header, then a path and an email appended
      [`${BOOT_ID}.1790000000003.6000.txt`]: `${bundleText(1_790_000_000_003, 6000)}+ 1 open  (in libfoo.dylib) + 4\n/Users/${USER}/Meetings/${FILE}\n`,
      // the right header, then prose shaped like a frame line
      [`${BOOT_ID}.1790000000004.6000.txt`]: `${bundleText(1_790_000_000_004, 6000)}+ 1 ${TRANSCRIPT}\n`,
      // the right header and no stacks
      [`${BOOT_ID}.1790000000005.6000.txt`]: bundleText(1_790_000_000_005, 6000).split('Thread 1')[0]
    }
    for (const [name, text] of Object.entries(planted)) writeFileSync(join(bundleDir(userData), name), text)
    mkdirSync(join(bundleDir(userData), `${BOOT_ID}.1790000000006.6000.txt`))

    expect(await exportableStallBundles(userData)).toEqual([good])
  })

  it.skipIf(!POSIX)('never lists a bundle-named symlink, even to a well-formed bundle or to a file outside the bundle directory', async () => {
    mkdirSync(bundleDir(userData), { recursive: true })
    const outside = join(userData, 'settings.json')
    writeFileSync(outside, `{"email":"${EMAIL}"}`)
    const elsewhere = join(userData, `${BOOT_ID}.1790000000002.6000.txt`)
    writeFileSync(elsewhere, bundleText(1_790_000_000_002, 6000))
    symlinkSync(outside, join(bundleDir(userData), `${BOOT_ID}.1790000000001.6000.txt`))
    symlinkSync(elsewhere, join(bundleDir(userData), `${BOOT_ID}.1790000000002.6000.txt`))

    expect(await exportableStallBundles(userData)).toEqual([])
  })

  it('resolves to [] when there is no bundle directory, or when userData is a file', async () => {
    expect(await exportableStallBundles(userData)).toEqual([])
    const file = join(userData, 'not-a-dir')
    writeFileSync(file, 'x')
    expect(await exportableStallBundles(file)).toEqual([])
  })
})
