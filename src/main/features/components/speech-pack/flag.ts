/**
 * The named `speech-pack` flag: `--speech-pack=on|off` on argv or METIS_SPEECH_PACK=on|off in the
 * environment (argv wins). Off by default, the same shape as `supervision` in infra/process/supervisor.ts.
 */
export function speechPackEnabled(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): boolean {
  for (const value of ['on', 'off'] as const) {
    if (argv.includes(`--speech-pack=${value}`)) return value === 'on'
  }
  return env.METIS_SPEECH_PACK === 'on'
}
