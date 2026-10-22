/**
 * team-folder-check.ts — validates a folder picked as a shared "team transcripts" source before it is saved.
 *
 * Brain ingestion treats every team folder as someone else's meetings. A folder that is (or sits inside, or
 * contains) the user's own meetings folder, which also holds the brain index and the wiki mirror, would be
 * ingested twice, and an unreadable one fails later and silently. Paths are compared by real path, so a
 * symlink or a differently-cased spelling of the same folder cannot slip through. Async only.
 */
import { readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { TeamFolderRefusal, TeamFolderRefusalReason } from '@shared/contracts/settings-os-state'

const MESSAGES: Record<TeamFolderRefusalReason, string> = {
  'overlaps-meetings':
    'That folder is already where your own meetings are saved (or contains it). Choose a separate shared folder.',
  'overlaps-team': 'That folder overlaps a shared folder you already added.',
  'not-readable': "Métis can't read that folder. Check its permissions or choose another.",
  managed: "Your organization manages this list, so it can't be changed here."
}

async function comparable(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path) // not on disk (yet): still comparable, and the readability check refuses it later
  }
}

/** Same folder, or one contains the other. */
function overlaps(a: string, b: string): boolean {
  const within = (parent: string, child: string): boolean => {
    const rel = relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  return within(a, b) || within(b, a)
}

async function defaultCanRead(dir: string): Promise<boolean> {
  try {
    await readdir(dir)
    return true
  } catch {
    return false
  }
}

export function teamFolderRefusal(reason: TeamFolderRefusalReason): TeamFolderRefusal {
  return { ok: false, reason, message: MESSAGES[reason] }
}

export async function checkTeamFolder(
  picked: string,
  context: { meetingsFolder: string; teamFolders: readonly string[]; canRead?: (dir: string) => Promise<boolean> }
): Promise<TeamFolderRefusal | null> {
  const refuse = teamFolderRefusal
  const candidate = await comparable(picked)
  if (overlaps(candidate, await comparable(context.meetingsFolder))) return refuse('overlaps-meetings')
  for (const existing of context.teamFolders) {
    if (overlaps(candidate, await comparable(existing))) return refuse('overlaps-team')
  }
  return (await (context.canRead ?? defaultCanRead)(picked)) ? null : refuse('not-readable')
}
