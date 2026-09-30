// Checks for the launch film's pre-production set (M2-0389): the composition brief's shot table and the
// render log's route, sign-offs and reference-clip record. Pure functions, so the tests can feed them
// broken inputs.

export const SHOT_COLUMNS = [
  'Shot', 'Purpose', 'In', 'Out', 'Source capture', 'Claim', 'Screen copy', 'Motion', 'Sound cue', 'Reading hold', 'Status label'
]

/** The brief's shot table as objects keyed by column name. */
export function parseBrief(markdown) {
  const rows = markdown
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()))
  const [header, , ...body] = rows
  if (!header || header.join('|') !== SHOT_COLUMNS.join('|')) throw new Error('composition brief has no shot table with the required columns')
  return body.map((cells) => Object.fromEntries(SHOT_COLUMNS.map((name, i) => [name, cells[i] ?? ''])))
}

/** Problems with the shot rows: empty fields, a claim id missing from the register, a broken timeline. */
export function checkBrief(shots, claimIds) {
  const problems = []
  let cursor = 0
  for (const shot of shots) {
    for (const name of SHOT_COLUMNS) if (!shot[name]) problems.push(`${shot.Shot}: ${name} is empty`)
    if (shot.Claim !== 'none' && !claimIds.includes(shot.Claim)) problems.push(`${shot.Shot}: claim ${shot.Claim} is not in the register`)
    if (Number(shot.In) !== cursor) problems.push(`${shot.Shot}: starts at ${shot.In}, expected ${cursor}`)
    if (!(Number(shot.Out) > Number(shot.In))) problems.push(`${shot.Shot}: out is not after in`)
    cursor = Number(shot.Out)
  }
  return problems
}

/** Problems with the render log: only the full /brag route may render, and only after both sign-offs. */
export function checkRenderLog(log) {
  const problems = []
  if (!/^\/brag\b.*\s--full(\s|$)/.test(log.route?.invocation ?? '')) problems.push('route is not /brag --full')
  const { contact_sheet: sheet, animatic } = log.signoffs ?? {}
  if (sheet?.status !== 'SIGNED_OFF') problems.push('contact sheet is not signed off')
  if (animatic?.status !== 'SIGNED_OFF') problems.push('animatic is not signed off')
  const clip = log.reference_clip
  if (!clip?.attempted || !['viewed', 'not viewed'].includes(clip.result)) problems.push('reference clip attempt and result are not recorded')
  return problems
}

/** Problems with the route alone, for the pre-production check that runs before any sign-off exists. */
export function checkRoute(log) {
  return checkRenderLog(log).filter((problem) => problem.startsWith('route'))
}
