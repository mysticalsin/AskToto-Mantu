import type { PublicSettings } from '@shared/ipc'

type AsrCorrection = PublicSettings['asrCorrections'][number]

/** One `heard => correct` line per correction, in order. */
export function serializeAsrCorrections(items: AsrCorrection[]): string {
  return items.map((item) => `${item.from} => ${item.to}`).join('\n')
}

/** Parses only complete correction rows and caps the list at the settings schema limit. */
export function parseAsrCorrections(raw: string): AsrCorrection[] {
  return raw
    .split('\n')
    .map((line) => {
      const separator = line.indexOf('=>')
      if (separator < 0) return null
      const from = line.slice(0, separator).trim()
      const to = line.slice(separator + 2).trim()
      return from ? { from, to } : null
    })
    .filter((correction): correction is AsrCorrection => correction !== null)
    .slice(0, 100)
}

/** Order-sensitive equality for the correction editor. */
export function sameAsrCorrections(a: AsrCorrection[], b: AsrCorrection[]): boolean {
  return (
    a.length === b.length &&
    a.every((correction, index) => correction.from === b[index].from && correction.to === b[index].to)
  )
}
