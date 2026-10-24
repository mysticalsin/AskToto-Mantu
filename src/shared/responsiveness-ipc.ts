/** Channel names for the G12 responsiveness bridge. Kept apart from the metric contract so the preload
 *  imports two strings, not the schemas. */
export const RESPONSIVENESS_IPC = {
  report: 'metrics:responsiveness',
  displayReceipt: 'metrics:display-receipt',
  cardOutcome: 'metrics:card-outcome'
} as const
