/** Freeze an ASCII HTTP identity before display-name changes or session creation.
 * Electron derives its default UA from the app name. Accented names can become U+FFFD while
 * Chromium request headers cross its protocol bridge, which then rejects the whole request.
 * Normalize the existing UA as well: a packaged product name may already contain accents.
 * This changes only the informational request header, never the visible brand or profile path.
 */
export function freezeAsciiUserAgent(application: { userAgentFallback: string }): void {
  application.userAgentFallback = application.userAgentFallback.normalize('NFKD').replace(/[^\x20-\x7e]/g, '')
}
