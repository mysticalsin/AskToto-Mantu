// Acceptance for the pre-produced non-product scenes (M2-0213). The Film toolchain workflow renders every
// scene listed in the storyboard into SCENES_DIR as <scene id>.mp4; this runs ffprobe on each one and
// holds it to the storyboard's format and the duration the edit plan counts on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCENES_DIR = process.env.SCENES_DIR
assert.ok(SCENES_DIR, 'SCENES_DIR names the directory the workflow rendered the scenes into')

const storyboard = JSON.parse(readFileSync(fileURLToPath(new URL('../storyboard/storyboard.json', import.meta.url)), 'utf8'))
const { width, height, fps } = storyboard.format

/** ffprobe's report on the file, with every frame decoded and counted rather than read from the header. */
function probe(path) {
  const report = execFileSync(
    'ffprobe',
    ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path],
    { encoding: 'utf8' }
  )
  return JSON.parse(report)
}

for (const scene of storyboard.non_product_scenes) {
  test(`${scene.id} is ${width}x${height} H.264 at ${fps} fps and ${scene.duration_seconds} seconds`, () => {
    const report = probe(join(SCENES_DIR, `${scene.id}.mp4`))
    const videos = report.streams.filter((stream) => stream.codec_type === 'video')
    assert.equal(videos.length, 1, 'one video stream')
    const [video] = videos
    assert.equal(video.width, width)
    assert.equal(video.height, height)
    assert.equal(video.codec_name, 'h264')
    assert.equal(video.pix_fmt, 'yuv420p')
    assert.equal(video.avg_frame_rate, `${fps}/1`)
    assert.equal(Number(video.nb_read_frames), fps * scene.duration_seconds)
    const duration = Number(report.format.duration)
    assert.ok(Math.abs(duration - scene.duration_seconds) < 1 / fps, `duration is ${duration}s, not ${scene.duration_seconds}s`)
  })
}
