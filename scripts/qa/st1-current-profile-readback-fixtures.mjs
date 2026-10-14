import { ARTIFACT, SOURCE } from './st1-current-profile-readback.mjs'

export function profileFixture() {
  const frame = (functionName) => ({
    functionName,
    url: 'private://should-never-be-output',
    lineNumber: 1,
    columnNumber: 2,
    scriptId: 'private-script'
  })
  return {
    startTime: 1_000_000,
    endTime: 4_000_000,
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 3] },
      { id: 2, callFrame: frame('(program)') },
      { id: 3, callFrame: frame('unclassified private function') }
    ],
    samples: [2, 3, 2],
    timeDeltas: [250_000, 1_000_000, 500_000]
  }
}

export function validReportFixture() {
  const timeline = []
  timeline.push({
    tMs: 3_297,
    requestAtMs: 3_297,
    settledAtMs: 5_044,
    diagnosticStatus: 'answered',
    histogramLowerBoundMs: 1_105,
    histogramUpperBoundMs: 5_044,
    histogramBoundsKnown: true,
    late: true,
    writeMs: 1_386.700625,
    lookupMs: 320.467584,
    loopMaxSinceLastMs: 909.639679,
    loopMaxDuringWriteMs: 571.473919,
    witness: {
      readRequestedAtMs: 1_000,
      readSettledAtMs: 1_001,
      loopMaxSinceLastMs: 11,
      cpuBusyPct: 20,
      writeStartedAtMs: 3_301,
      writeSettledAtMs: 3_302,
      writeMs: 1
    }
  })
  for (let index = 1; index <= 294; index += 1) {
    const requestAtMs = 6_000 + index * 1_000
    const worstTimely = index === 1
    timeline.push({
      tMs: requestAtMs,
      requestAtMs,
      settledAtMs: requestAtMs + 20,
      diagnosticStatus: 'answered',
      histogramLowerBoundMs: requestAtMs - 1_000,
      histogramUpperBoundMs: requestAtMs + 20,
      histogramBoundsKnown: true,
      writeMs: worstTimely ? 385.9653330000001 : 10,
      lookupMs: worstTimely ? 14.035041999999521 : 2,
      loopMaxSinceLastMs: 18,
      loopMaxDuringWriteMs: 8,
      witness: {
        readRequestedAtMs: requestAtMs,
        readSettledAtMs: requestAtMs + 1,
        loopMaxSinceLastMs: 3,
        cpuBusyPct: 10,
        writeStartedAtMs: requestAtMs + 1,
        writeSettledAtMs: requestAtMs + 2,
        writeMs: 1
      }
    })
  }
  const profilerDiagnostics = {
    version: 1,
    setup: { requestedAtMs: 1_105, settledAtMs: 2_752, status: 'answered' },
    summary: { requestedAtMs: 303_207, settledAtMs: 303_209, status: 'answered' },
    profilerCommands: [
      { command: 'enable', requestedAtMs: 2_753, settledAtMs: 3_134, status: 'answered' },
      { command: 'set-sampling-interval', requestedAtMs: 3_134, settledAtMs: 3_156, status: 'answered' },
      { command: 'start', requestedAtMs: 3_156, settledAtMs: 3_296, status: 'answered' },
      { command: 'stop', requestedAtMs: 300_144, settledAtMs: 300_186, status: 'answered' }
    ]
  }
  return {
    harness: 'ST-1',
    build_run_id: SOURCE.runId,
    artifact_sha256: 'd'.repeat(64),
    row: 'none',
    platform: 'darwin',
    arch: 'arm64',
    minutes: 5,
    complete: true,
    verdict: 'FAIL',
    teardown: { state: 'acknowledged' },
    samples: 294,
    lateSamples: 1,
    loop: { p99Ms: 18.694143, maxMs: 909.639679 },
    write: { maxMs: 385.9653330000001 },
    lookup: { maxMs: 14.035041999999521 },
    criteria: [
      { name: 'inspector', pass: true },
      { name: 'has-samples', pass: true },
      { name: 'no-late-samples', pass: false },
      { name: 'loop-p99 < 50', pass: true },
      { name: 'loop-max < 250', pass: false },
      { name: 'async-write < 250', pass: false },
      { name: 'dns-lookup < 250', pass: true }
    ],
    timeline,
    profilerDiagnostics,
    cpuProfile: {
      file: ARTIFACT.profileName,
      running: false,
      requestedAtMs: 3_156,
      answeredAtMs: 3_296,
      startedAtMs: 3_296,
      stoppedAtMs: 300_144
    },
    bootStages: {
      stages: [
        { stage: 'createWindow.construct', ms: 180, sinceSpawnMs: 2_900 },
        { stage: 'untrusted function name', ms: 300, sinceSpawnMs: 3_500 }
      ]
    }
  }
}

export function denseReadbackFixture() {
  const report = validReportFixture()
  report.timeline[1].loopMaxSinceLastMs = 260
  report.timeline[2].loopMaxDuringWriteMs = 261
  report.timeline[4].writeMs = 401
  report.timeline[5].lookupMs = 300
  report.timeline[6].settledAtMs = report.timeline[6].requestAtMs + 25_000
  report.timeline[6].histogramUpperBoundMs = report.timeline[6].settledAtMs
  report.timeline[7].loopMaxSinceLastMs = 250
  report.timeline[8].loopMaxSinceLastMs = 250
  const stageNames = [
    'createTray.loadIcon',
    'createTray.loadIcon.fallback',
    'createTray.newTray',
    'createTray.decorate',
    'createTray.buildMenu',
    'createTray.attachMenu',
    'createWindow.prewarm',
    'createWindow.construct',
    'createWindow.navigate',
    'createWindow.firstShow'
  ]
  report.bootStages.stages = Array.from({ length: 20 }, (_, index) => ({
    stage: stageNames[index % stageNames.length],
    ms: 1_000 + index,
    sinceSpawnMs: 2_000 + index
  }))
  const profile = profileFixture()
  profile.samples = Array.from({ length: 20_000 }, (_, index) => (index % 2 === 0 ? 2 : 3))
  profile.timeDeltas = Array.from({ length: 20_000 }, () => 1_000)
  profile.endTime = profile.startTime + 20_000_000
  return { report, profile }
}
