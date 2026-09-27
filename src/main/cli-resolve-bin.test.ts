/**
 * cli-resolve-bin.test.ts — M2-0147.
 *
 * resolveBin's mac/Linux branch used to build a shell command line by splicing the (sometimes free-text,
 * e.g. a model id typed into Settings) binary name directly into `command -v ${bin}` and running it via
 * `$SHELL -lc <script>`. A value containing a shell separator (`;`, `&&`, backticks, `$(...)`) ran as
 * shell SYNTAX, not as the argument `command -v` was meant to receive.
 *
 * Real `/bin/sh`, not a mocked child_process — the precedent is cli-win.test.ts's real-process resolveBin
 * test. `HOME` is already pinned to a throwaway, empty directory by vitest.config.ts's hermetic-home
 * setup, so posixUserBinCandidates() can't accidentally resolve a fake bin name off this machine's PATH.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  shell: { openPath: vi.fn(async () => '') }
}))

// The self-contained installer is irrelevant here but is imported by cli.ts at module load (matches
// cli-setup-script.test.ts's mock).
vi.mock('./cli-installer', () => ({
  managedCliEntry: vi.fn(() => null),
  managedCliCommand: vi.fn(() => null),
  installManagedCli: vi.fn()
}))

import { resolveBin, clearBinCache } from './cli'

describe.skipIf(process.platform === 'win32')(
  'resolveBin — the binary name reaches the login shell only as data, never as shell syntax (M2-0147)',
  () => {
    const REAL_SHELL = process.env.SHELL

    beforeEach(() => {
      clearBinCache()
      process.env.SHELL = '/bin/sh'
    })
    afterEach(() => {
      clearBinCache()
      if (REAL_SHELL === undefined) delete process.env.SHELL
      else process.env.SHELL = REAL_SHELL
    })

    it('C1: passes the binary name to the login shell as data, never as shell syntax', async () => {
      // Pre-fix, `command -v metis-no-such-cli;echo injected` runs `command -v metis-no-such-cli`
      // (not found) THEN, unconditionally, `echo injected` — the shell's last exit code is `echo`'s
      // success, so resolveBin returned "injected" as if it were a resolved path.
      expect(await resolveBin('metis-no-such-cli;echo injected')).toBeNull()
    })

    it('C2: still resolves a real binary through the login shell', async () => {
      const resolved = await resolveBin('sh')
      expect(resolved).toMatch(/^\/.+\/sh$/)
    })
  }
)
