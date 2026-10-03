import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// M2-0457: check-release.mjs refuses quarantine-clearing install helpers in the artifacts directory.
// Each test runs the real CLI against a fresh directory.
const SCRIPT = join(__dirname, 'check-release.mjs')
const XATTR_LINE = 'xattr -dr com.apple.quarantine "/Applications/Metis.app"\n'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'check-release-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run() {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, ASKTOTO_ARTIFACTS_DIR: dir },
    encoding: 'utf8'
  })
}

describe('check-release install-script gate', () => {
  it('passes a directory holding only installers and feed metadata', () => {
    writeFileSync(join(dir, 'Metis-1.9.7.dmg'), 'dmg')
    writeFileSync(join(dir, 'Metis-1.9.7.dmg.blockmap'), 'map')
    writeFileSync(join(dir, 'latest-mac.yml'), 'version: 1.9.7\n')
    const result = run()
    expect(result.status, result.stderr).toBe(0)
  })

  it('fails when the directory contains a .command file', () => {
    writeFileSync(join(dir, 'Install Metis.command'), '#!/bin/bash\necho hi\n')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Install Metis.command')
  })

  it('fails when the directory contains a .sh file', () => {
    writeFileSync(join(dir, 'install-metis.sh'), '#!/bin/bash\necho hi\n')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('install-metis.sh')
  })

  it('fails on a renamed file whose text runs xattr against com.apple.quarantine', () => {
    writeFileSync(join(dir, 'helper.txt'), `#!/bin/bash\n${XATTR_LINE}`)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('helper.txt')
  })

  it('never reads installers: a large .dmg, even one containing the xattr line, is skipped', () => {
    const dmg = join(dir, 'Metis-1.9.7.dmg')
    writeFileSync(dmg, XATTR_LINE)
    truncateSync(dmg, 1.5 * 1024 ** 3)
    const result = run()
    expect(result.status, result.stderr).toBe(0)
  })
})
