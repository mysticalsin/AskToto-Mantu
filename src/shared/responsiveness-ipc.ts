/** Channel names for the G12 responsiveness bridge. Kept apart from the metric contract so the preload
 *  imports a few strings, not the schemas. */
export const RESPONSIVENESS_IPC = {
  report: 'metrics:responsiveness',
  displayReceipt: 'metrics:display-receipt',
  cardOutcome: 'metrics:card-outcome',
  // G70: one content-free record per intervention decision (enums and integers only).
  interventionShadow: 'metrics:intervention-shadow'
} as const
