import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Replace generated resources only after a verified archive has extracted successfully. */
export function provisionManagedNodeArchive(archive, dest, spec, version) {
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (actual !== spec.sha256) throw new Error(`${spec.file} sha256 ${actual} !== ${spec.sha256}`)
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = mkdtempSync(`${dest}.tmp-`)
  try {
    let extracted = tmp
    if (spec.file.endsWith('.zip')) {
      if (process.platform === 'win32') {
        const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        execFileSync(tar, ['-xf', archive, '-C', tmp], { stdio: 'inherit' })
      } else {
        execFileSync('unzip', ['-qo', archive, '-d', tmp], { stdio: 'inherit' })
      }
      extracted = join(tmp, spec.file.replace(/\.zip$/, ''))
    } else {
      execFileSync('tar', ['-xzf', archive, '-C', tmp, '--strip-components=1'], { stdio: 'inherit' })
    }
    if (!existsSync(join(extracted, spec.nodeRelPath))) {
      throw new Error(`${spec.file} did not contain the expected node binary`)
    }
    writeFileSync(join(extracted, '.node-version'), version + '\n')
    const placeholder = join(dest, '.gitkeep')
    if (existsSync(placeholder)) copyFileSync(placeholder, join(extracted, '.gitkeep'))
    // Extraction into the old tree leaves removed npm/native files from the previous release.
    rmSync(dest, { recursive: true, force: true })
    renameSync(extracted, dest)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
