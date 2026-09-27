// Acceptance for the launch-film toolchain spike (M2-0212). The Film toolchain workflow renders the
// synthetic scene with the pinned toolchain, then runs BRAG step 4's delivery tail on it: it picks
// poster.jpg at a settled beat and bakes it into frame 0 of spike.mp4. This runs against that delivered
// MP4 and its poster.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SPIKE = fileURLToPath(new URL('spike.mp4', import.meta.url))
const POSTER = fileURLToPath(new URL('poster.jpg', import.meta.url))
const FRAMES_PER_SECOND = 30
const SECONDS = 5
/** Luma SSIM to poster.jpg at or above which a frame is the poster, after the bake's libx264 CRF 18 encode. */
const POSTER_SSIM = 0.99

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

/** Luma SSIM between the spike's frame `index` (0-based, in presentation order) and the poster. */
function lumaSsimToPoster(index) {
  const stats = execFileSync(
    'ffmpeg',
    [
      '-v', 'error',
      '-i', SPIKE,
      '-i', POSTER,
      '-lavfi', `[0:v]select=eq(n\\,${index})[frame];[frame][1:v]ssim=stats_file=-`,
      '-f', 'null', '-'
    ],
    { encoding: 'utf8' }
  )
  return Number(/\bY:([\d.]+)/.exec(stats)[1])
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

test('frame 0 is the poster, not the opening frame it replaced', (t) => {
  const frameZero = lumaSsimToPoster(0)
  // The bake leaves frame 1 as rendered: the scene's opening, which a bake that changed nothing would
  // also leave at frame 0. It must fall below the bar, or the bar cannot tell such a bake apart.
  const frameOne = lumaSsimToPoster(1)
  t.diagnostic(`luma SSIM to the poster: frame 0 ${frameZero}, frame 1 ${frameOne}`)
  assert.ok(frameZero >= POSTER_SSIM, `frame 0 is at ${frameZero}, below ${POSTER_SSIM}`)
  assert.ok(frameOne < POSTER_SSIM, `frame 1 is at ${frameOne}, so ${POSTER_SSIM} does not separate the poster from the opening`)
})
