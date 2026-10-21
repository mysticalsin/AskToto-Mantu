/**
 * custom-endpoint.ts — the inline check for the Custom provider's endpoint, shared so Settings explains a refusal
 * with the same rule the settings schema enforces (an https:// address; BaseSettingsSchema.customBaseUrl).
 */

/** Why `url` cannot be saved as the custom endpoint, or null when it can. Empty is allowed only when optional. */
export function customEndpointError(url: string, options: { required?: boolean } = {}): string | null {
  const value = url.trim()
  if (value === '') return options.required ? 'Enter the endpoint address. It starts with https://.' : null
  if (!/^https:\/\//i.test(value)) return 'Use an address that starts with https://.'
  try {
    if (!new URL(value).hostname) return 'Enter a full address, like https://your-endpoint/v1.'
  } catch {
    return 'Enter a full address, like https://your-endpoint/v1.'
  }
  return null
}
