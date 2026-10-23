/**
 * diagnostics-bundle.ts — what the support bundle contains: logs, crash dumps, the boot sentinel and a
 * MANIFEST. Logs out, content never: this module never reaches for meetings, the brain store, the wiki
 * mirror or settings. The files are handed to the export service, which writes them conflict-safely.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface DiagnosticsBundleInfo {
  userData: string
  version: string
  platform: string
  arch: string
  packaged: boolean
  now?: () => Date
}

export interface DiagnosticsBundle {
  entries: { name: string; bytes: Buffer }[]
  files: number
}

export async function collectDiagnosticsBundle(info: DiagnosticsBundleInfo): Promise<DiagnosticsBundle> {
  const entries: { name: string; bytes: Buffer }[] = []
  const take = async (src: string, name: string): Promise<void> => {
    try {
      entries.push({ name, bytes: await readFile(src) })
    } catch {
      /* a locked/absent file is skipped, and the manifest shows exactly what made it */
    }
  }
  const logsDir = join(info.userData, 'logs')
  for (const f of await readdir(logsDir).catch(() => [] as string[])) {
    if (/\.log$|^responsiveness-report\.json$/.test(f)) await take(join(logsDir, f), f)
  }
  for (const f of await readdir(info.userData)) {
    if (/^crash-.*\.log$/.test(f)) await take(join(info.userData, f), f)
  }
  const sentinel = join(info.userData, 'boot-incomplete.json')
  await take(sentinel, 'boot-incomplete.json')
  const copied = entries.map((e) => e.name)
  const manifest = [
    `Métis diagnostics bundle`,
    `exported: ${(info.now ?? ((): Date => new Date()))().toISOString()}`,
    `version: ${info.version}`,
    `platform: ${info.platform} ${info.arch}`,
    `packaged: ${info.packaged}`,
    ``,
    `files (${copied.length}):`,
    ...copied.map((f) => `  ${f}`),
    ``,
    `Deliberately NOT included: meeting transcripts, the .brain/ knowledge store, the wiki mirror,`,
    `and settings.json — this bundle is for diagnosing the app, never for moving content.`
  ].join('\n')
  entries.push({ name: 'MANIFEST.txt', bytes: Buffer.from(manifest, 'utf8') })
  return { entries, files: copied.length }
}
