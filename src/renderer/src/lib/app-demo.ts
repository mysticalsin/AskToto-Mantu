import type { TranscriptLine } from '@shared/ipc'

// Dev-only visual seed for screenshots (?demo=answer|copilot|settings|onboarding|review). No-op in prod.
export const DEMO =
  import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('demo') : null
export const DEMO_ANSWER = `## Quicksort in TypeScript

\`\`\`ts
function quicksort(a: number[], lo = 0, hi = a.length - 1): number[] {
  if (lo >= hi) return a
  const pivot = a[(lo + hi) >> 1]
  let i = lo, j = hi
  while (i <= j) {
    while (a[i] < pivot) i++
    while (a[j] > pivot) j--
    if (i <= j) { [a[i], a[j]] = [a[j], a[i]]; i++; j-- }
  }
  quicksort(a, lo, j); quicksort(a, i, hi)
  return a
}
\`\`\`

- **Average** \`O(n log n)\` · **Worst** \`O(n^2)\`. Pick a random pivot to avoid the sorted-input case.`
export const DEMO_LINES: TranscriptLine[] = [
  { speaker: 'them', text: 'Can you walk me through a time you led a project under a tight deadline?', t: 1 },
  { speaker: 'you', text: 'Sure, happy to.', t: 2 }
]
export const DEMO_SUG = `**Say this:** "At Mantu I led the Métis build, a Cluely-class AI overlay, solo in one sprint. The deadline was hard: we demoed to leadership Friday. I scoped to a thin vertical, parallelized the build, and shipped a working interview copilot that transcribes both sides and drafts answers live. It landed the demo and became the template for our agent tooling."

- Quantify: 1 sprint, solo, live in front of leadership.
- If pushed: the risk was system-audio capture, so I de-risked it first.`
