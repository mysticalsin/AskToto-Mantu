import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const listPath = join(root, 'scripts', 'qa', 'windows-qa-scenarios.json')
const files: string[] = (JSON.parse(readFileSync(listPath, 'utf8')) as { files: string[] }).files
const workflow = readFileSync(join(root, '.github', 'workflows', 'windows-qa.yml'), 'utf8').replace(/\r\n/g, '\n')

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.win32\.test\.tsx?$/.test(name)) out.push(relative(root, full).split(sep).join('/'))
  }
}

describe('windows-qa scenarios list', () => {
  it('lists existing test files only', () => {
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(file, file).toMatch(/\.test\.tsx?$/)
      expect(existsSync(join(root, file)), file).toBe(true)
    }
  })

  it('is sorted and has no duplicates', () => {
    expect(files).toEqual([...new Set(files)].sort())
  })

  it('lists every win32 test file under src/ and scripts/', () => {
    const found: string[] = []
    walk(join(root, 'src'), found)
    walk(join(root, 'scripts'), found)
    for (const file of found) expect(files, file).toContain(file)
  })

  it('is read by the scenarios job, which runs vitest with it', () => {
    expect(workflow).toContain('scripts/qa/windows-qa-scenarios.json')
    expect(workflow).toMatch(/npx vitest run @files/)
  })
})
