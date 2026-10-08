/** The candidate's main.log path, synchronously resolved without reading the file. */
const MAIN_LOG_PATH = `(() => {
  const load = process.mainModule?.require
  if (typeof load !== 'function') return { error: 'process.mainModule.require is unavailable in the compiled main' }
  try {
    return { path: load('node:path').join(load('electron').app.getPath('logs'), 'main.log') }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
})()`

/** Await only the bounded transport. Awaiting this synchronous value inside V8 can lose the
 * inspector-created promise to collection; asynchronous ST-1 measurements retain their pinned evaluator. */
export async function queryMainLogPath(cdp, timeoutMs) {
  const answer = await cdp.send('Runtime.evaluate', { expression: MAIN_LOG_PATH, returnByValue: true }, timeoutMs)
  if (answer.late) return answer
  if (answer.result.exceptionDetails) throw new Error(answer.result.exceptionDetails.text)
  return { late: false, value: answer.result.result?.value }
}
