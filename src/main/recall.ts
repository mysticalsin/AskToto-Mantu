import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveMeetingsFolder, decodeSaved } from './transcripts'
import { getSettings } from './store'
import type { MeetingSummary, RecallHit } from '@shared/ipc'

// Independent meeting-history backend (own implementation, no third-party source). Reads the saved
// transcript markdown files and provides list + keyword search so managers (and Dust agents) can
// recall past meetings. Reads are ASYNC (off the main-process event loop) and each file is read once.

function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return out
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i)
    if (kv) out[kv[1]] = kv[2].replace(/^["[]|["\]]$/g, '').trim()
  }
  return out
}

function meetingFiles(folder: string): string[] {
  try {
    return readdirSync(folder).filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'index.md')
  } catch {
    return []
  }
}

interface Read {
  sum: MeetingSummary
  text: string
}

/** Read + decode one file once (async), parse its frontmatter. Null if it isn't a meeting transcript. */
async function readMeeting(folder: string, file: string): Promise<Read | null> {
  try {
    const text = decodeSaved(await readFile(join(folder, file)))
    const fm = frontmatter(text)
    if (fm.type && fm.type !== 'meeting-transcript') return null
    return {
      text,
      sum: {
        file,
        title: fm.title || file.replace(/\.md$/, ''),
        date: fm.date || '',
        mode: fm.mode || 'general',
        durationMin: Number(fm.duration_min || 0),
        participants: (fm.participants || '').split(',').map((s) => s.trim()).filter(Boolean)
      }
    }
  } catch {
    return null
  }
}

/** Newest-first list of saved meetings. */
export async function listMeetings(): Promise<MeetingSummary[]> {
  const folder = resolveMeetingsFolder(getSettings())
  const read = await Promise.all(meetingFiles(folder).map((f) => readMeeting(folder, f)))
  return read
    .filter((r): r is Read => r !== null)
    .map((r) => r.sum)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

/** Keyword search across saved meetings; returns scored hits with a snippet. */
export async function searchMeetings(query: string): Promise<RecallHit[]> {
  const folder = resolveMeetingsFolder(getSettings())
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1)
  if (!terms.length) return []
  const read = await Promise.all(meetingFiles(folder).map((f) => readMeeting(folder, f)))
  const hits: RecallHit[] = []
  for (const r of read) {
    if (!r) continue
    const { sum, text } = r
    const lc = text.toLowerCase()
    let score = 0
    for (const t of terms) {
      const inTitle = sum.title.toLowerCase().includes(t) ? 3 : 0
      const count = lc.split(t).length - 1
      score += inTitle + count
    }
    if (score === 0) continue
    const first = lc.indexOf(terms[0])
    const start = Math.max(0, first - 60)
    const snippet = text.slice(start, start + 200).replace(/\s+/g, ' ').trim()
    hits.push({ ...sum, snippet, score })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 25)
}
