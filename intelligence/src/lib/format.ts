import type { Category, DealOutcome, GraphNode, Grounding, WinLikelihoodBand } from '../types/data'

export const bandColor: Record<WinLikelihoodBand, string> = {
  good: '#35c98f',
  mixed: '#e0a836',
  concerning: '#e05a6b',
}

export const bandLabel: Record<WinLikelihoodBand, string> = {
  good: 'Good',
  mixed: 'Mixed',
  concerning: 'Concerning',
}

export const outcomeLabel: Record<DealOutcome, string> = {
  won: 'Won',
  lost: 'Lost',
  open: 'Open',
}

export const categoryLabel: Record<Category, string> = {
  pricing: 'Pricing',
  'technical-fit': 'Technical fit',
  relationship: 'Relationship',
  timing: 'Timing',
  competitor: 'Competitor',
  process: 'Process',
  'commercial-model': 'Commercial model',
}

export const groundingLabel: Record<Grounding, string> = {
  verified: 'Verified',
  assumed: 'Assumed',
  unknown: 'Unknown',
}

export const groundingColor: Record<Grounding, string> = {
  verified: '#35c98f',
  assumed: '#e0a836',
  unknown: '#8b7a99',
}

// Same going-cold palette GraphView's node-info panel already uses (grey when unknown — never default
// to "fresh", which would fabricate a healthy signal the data never carried).
export function freshnessColor(f: GraphNode['freshness']): string {
  if (f === 'cold') return '#f7768e'
  if (f === 'cooling') return '#e0af68'
  if (f === 'fresh') return '#9ece6a'
  return 'rgba(255,255,255,0.28)'
}

export function freshnessLabel(f: GraphNode['freshness']): string {
  return f ?? 'unknown'
}

/** Simple, transparent "impact" proxy: deciding-factor claims are higher impact;
 *  otherwise n_observations acts as the impact proxy the plan asks for
 *  (confidence x impact sort for the coaching view). */
export function impactScore(nObservations: number): number {
  return Math.log2(nObservations + 1)
}

export function confidenceImpactScore(confidence: number, nObservations: number): number {
  return confidence * impactScore(nObservations)
}
