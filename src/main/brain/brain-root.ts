import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import { memoryRelRoot } from '../memory-partition/memory-access'
import { resolveMeetingsFolder } from '../transcripts'

/**
 * Where the knowledge store lives (Métis 2.12 G19). It is the derived memory of one verified owner, so the root is
 * the partition in force: `.brain/` for the owner that adopted the single-owner data, `.brain-p-<id>/` for every
 * other owner, and a root that never exists while nobody is verified. The meetings themselves stay where they are.
 */
export function brainRelDir(): string {
  return memoryRelRoot()
}

/** Sits beside the partition root: the preserved index copies of one owner are never listed under another. */
export function brainPreservedRelDir(): string {
  return `${memoryRelRoot()}-preserved`
}

export function brainDir(settings: Settings, relRoot: string = brainRelDir()): string {
  return join(resolveMeetingsFolder(settings), relRoot)
}
