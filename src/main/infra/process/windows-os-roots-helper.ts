import { execFile } from 'node:child_process'

/** Run the pinned OS-roots probe with a bounded, shell-free process owned by the process boundary. */
export function runWindowsOsRootsHelper(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      path,
      ['--json'],
      {
        encoding: 'utf8',
        maxBuffer: 2048,
        timeout: 3000,
        windowsHide: true,
        shell: false,
        env: { PATH: '' }
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('WINDOWS_OS_ROOT_HELPER_FAILED'))
          return
        }
        resolve(stdout)
      }
    )
  })
}
