/** Parse the intentionally unsigned-only lean checker command line. */
export function parseLeanCheckerArgs(args) {
  const [target, resourcesArg, ...options] = args
  let arch
  let executableName = 'Metis.exe'
  let executableProvided = false
  for (const item of options) {
    if (item.startsWith('--arch=') && arch === undefined) arch = item.slice('--arch='.length)
    else if (item.startsWith('--executable=') && !executableProvided) {
      executableName = item.slice('--executable='.length)
      executableProvided = true
    }
    else throw new Error(`Unknown or duplicate option: ${item}`)
  }
  if (!['mac', 'win'].includes(target) || !resourcesArg || !['arm64', 'x64'].includes(arch)) {
    throw new Error('Usage: node scripts/check-lean-package.mjs <mac|win> <resources-directory> --arch=<arm64|x64> [--executable=Metis.exe]')
  }
  const platform = target === 'mac' ? 'darwin' : 'win32'
  if (platform === 'win32' && arch !== 'x64') throw new Error('Lean Windows packages support x64 only')
  if (executableName !== 'Metis.exe') throw new Error(`Unexpected Windows executable identity: ${executableName}`)
  return { target, resourcesArg, arch, executableName, platform }
}
