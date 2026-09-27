// Acceptance for the launch-film toolchain spike (M2-0212). The Film toolchain workflow renders the
// synthetic scene with the pinned toolchain, then runs this against the MP4 that render produced.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SPIKE = fileURLToPath(new URL('spike.mp4', import.meta.url))
const FRAMES_PER_SECOND = 30
const SECONDS = 5

/** ffprobe's report on the file, with every frame decoded and counted rather than read from the header. */
function probe(path) {
  const report = execFileSync(
    'ffprobe',
    ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path],
    { encoding: 'utf8' }
  )
  return JSON.parse(report)
}

function pinnedHyperframesVersion() {
  const manifest = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'))
  return manifest.dependencies.hyperframes
}

let format
let video

before(() => {
  const report = probe(SPIKE)
  const videos = report.streams.filter((stream) => stream.codec_type === 'video')
  assert.equal(videos.length, 1, 'the spike carries exactly one video stream')
  format = report.format
  video = videos[0]
})

test('the spike is 3840x2160 H.264 with 4:2:0 chroma', () => {
  assert.equal(video.width, 3840)
  assert.equal(video.height, 2160)
  assert.equal(video.codec_name, 'h264')
  assert.equal(video.pix_fmt, 'yuv420p')
})

test('the spike runs 5 seconds at 30 fps, every one of its 150 frames decodable', () => {
  assert.equal(video.avg_frame_rate, `${FRAMES_PER_SECOND}/1`)
  assert.equal(Number(video.nb_read_frames), FRAMES_PER_SECOND * SECONDS)
  const duration = Number(format.duration)
  assert.ok(Math.abs(duration - SECONDS) < 1 / FRAMES_PER_SECOND, `duration is ${duration}s, not ${SECONDS}s`)
})

test('the pinned Hyperframes release rendered the spike', () => {
  assert.equal(format.tags?.hyperframes_version, pinnedHyperframesVersion())
})
