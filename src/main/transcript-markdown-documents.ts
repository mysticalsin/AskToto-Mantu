import { cleanTitle, pad, yamlSafeTitle } from './features/meetings/transcript-document-format'

// Pure markdown builders for the meetings folder: the self-documenting README/index headers, the index
// row, a saved note, and the post-meeting debrief section. No filesystem, no electron.

export const README = `# Métis — Meeting transcripts

This folder is created and maintained by **Métis**. Every meeting you run the copilot in is
saved here automatically as one markdown file: AI notes + the full timestamped transcript, with
frontmatter (\`type: meeting-transcript\`, \`status: ready-for-followup\`).

## For your Dust agents
- Read **index.md** for the running list of meetings, or scan the \`*.md\` files directly.
- Each file is tagged \`status: ready-for-followup\` — generate follow-ups, then update the status.
- Filenames are \`YYYY-MM-DD_HHMMSS-<slug>.md\`; frontmatter carries date, mode, participants, duration.

Do not rename this folder — Métis and your agents read from here.
`

export const INDEX_HEADER = `# Métis Meetings — Index

| Date | Title | Mode | Duration | File |
|------|-------|------|----------|------|
`

/** Local-time `YYYY-MM-DD HH:MM` stamp used in index.md rows. */
export function indexDateString(ms: number): string {
  const di = new Date(ms)
  return `${di.getFullYear()}-${pad(di.getMonth() + 1)}-${pad(di.getDate())} ${pad(di.getHours())}:${pad(di.getMinutes())}`
}

/** One index.md table row (pipes in title/mode are neutralised so they cannot break the table). */
export function formatIndexRow(
  dateStr: string,
  title: string,
  mode: string,
  durMin: number,
  fileName: string
): string {
  const safeTitle = title.replace(/\|/g, '/')
  const safeMode = mode.replace(/\|/g, '/').replace(/[\r\n]/g, ' ')
  return `| ${dateStr} | ${safeTitle} | ${safeMode} | ${durMin} min | [open](${fileName}) |\n`
}

/** The markdown document (frontmatter + body) for a saved Q&A note. */
export function buildNoteDocument(n: { mode: string; question?: string; answer: string }, title: string, started: number): string {
  const frontmatter = [
    '---',
    'type: note',
    'source: Métis',
    `mode: "${yamlSafeTitle(cleanTitle(n.mode))}"`,
    `date: ${new Date(started).toISOString()}`,
    `title: "${yamlSafeTitle(title)}"`,
    'status: ready-for-followup',
    '---',
    ''
  ].join('\n')
  const body =
    `# ${title}\n\n_${new Date(started).toLocaleString()} · note · Métis_\n\n` +
    (n.question ? `## Question\n\n${n.question}\n\n` : '') +
    `## Answer\n\n${n.answer}\n`
  return frontmatter + body
}

export const DEBRIEF_HEADING = '## Debrief (off the record)'
const DEBRIEF_END_MARKER = '<!-- /debrief -->'

/**
 * Insert or replace the debrief section in a meeting's markdown. `searchFrom` is where the previous
 * heading may be searched for (past any speech-provenance tail). The section is terminated by an explicit
 * end marker so a replace finds the exact end of the previous debrief; files written before the marker
 * existed fall back to the old "next heading" search.
 */
export function applyDebriefSection(md: string, safeText: string, searchFrom: number): string {
  const section =
    `${DEBRIEF_HEADING}\n\n_Captured right after the meeting — impressions, not transcript._\n\n` +
    `${safeText}\n${DEBRIEF_END_MARKER}\n`
  const start = md.indexOf(DEBRIEF_HEADING, searchFrom)
  if (start < 0) return md.trimEnd() + '\n\n' + section
  const markerIdx = md.indexOf(DEBRIEF_END_MARKER, start + DEBRIEF_HEADING.length)
  if (markerIdx >= 0) {
    // Exact boundary: everything after the marker's own line belongs to whatever comes next.
    const afterMarker = md.indexOf('\n', markerIdx)
    return md.slice(0, start) + section + (afterMarker >= 0 ? md.slice(afterMarker + 1) : '')
  }
  // Legacy file written before this marker existed: fall back to the old heuristic.
  const next = md.indexOf('\n## ', start + DEBRIEF_HEADING.length)
  return md.slice(0, start) + section + (next >= 0 ? md.slice(next + 1) : '')
}
