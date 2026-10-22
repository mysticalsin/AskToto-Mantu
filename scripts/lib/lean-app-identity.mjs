// The application identity a lean package must carry. The shipped identity never changes (macOS grants and the
// update channel are keyed to it); the QA identity variant (build/qa-identity.electron-builder.yml) carries its
// own bundle id and executable name so it installs beside the live app. The QA build is marked by
// METIS_QA_IDENTITY=1 at compile and package time, exactly as electron.vite.config.ts reads it.
export function leanAppIdentity(env = process.env) {
  if (env.METIS_QA_IDENTITY === '1') {
    return { bundleIdentifier: 'com.mantu.asktoto.qa', executableName: 'Metis QA' }
  }
  return { bundleIdentifier: 'com.mantu.asktoto', executableName: 'Metis' }
}
