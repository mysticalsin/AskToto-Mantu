/**
 * The named `speech-pack` flag: `--speech-pack=on|off` on argv or METIS_SPEECH_PACK=on|off in the
 * environment (argv wins; the last argv occurrence wins). Off by default, the same shape as `supervision`
 * in infra/process/supervisor.ts.
 */
export function speechPackEnabled(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): boolean {
  for (let i = argv.length - 1; i >= 0; i--) {
    if (argv[i] === '--speech-pack=on') return true
    if (argv[i] === '--speech-pack=off') return false
  }
  return env.METIS_SPEECH_PACK === 'on'
}
