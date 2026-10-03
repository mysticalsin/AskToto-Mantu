import { access, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function readUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

export async function listDir(path: string): Promise<string[]> {
  return readdir(path)
}

export async function mtimeMs(path: string): Promise<number> {
  return (await stat(path)).mtimeMs
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

export { rename, unlink, writeFile }
