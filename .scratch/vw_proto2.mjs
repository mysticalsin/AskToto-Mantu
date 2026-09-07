import { readFileSync } from 'node:fs'
import { geoMercator, geoPath } from 'd3-geo'
import { feature } from '../operator/scripts/topojson-feature.mjs'

const topo = JSON.parse(readFileSync('operator/shoey-ref/data/countries-50m.json', 'utf8'))

function identity(x) { return x }
function makeTransform(tf) {
  if (tf == null) return identity
  let x0, y0
  const kx = tf.scale[0], ky = tf.scale[1], dx = tf.translate[0], dy = tf.translate[1]
  return function (input, i) {
    if (!i) { x0 = 0; y0 = 0 }
    const out = new Array(input.length)
    out[0] = (x0 += input[0]) * kx + dx
    out[1] = (y0 += input[1]) * ky + dy
    for (let j = 2; j < input.length; j++) out[j] = input[j]
    return out
  }
}
function decodeAbsoluteArcs(topology) {
  const tp = makeTransform(topology.transform)
  return topology.arcs.map((arc) => arc.map((p, k) => tp(p.slice(), k)))
}
function triangleArea(a, b, c) {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2
}
class MinHeap {
  constructor() { this.a = [] }
  size() { return this.a.length }
  push(index, area) {
    this.a.push([area, index])
    let i = this.a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.a[p][0] <= this.a[i][0]) break
      ;[this.a[p], this.a[i]] = [this.a[i], this.a[p]]
      i = p
    }
  }
  pop() {
    const top = this.a[0]
    const last = this.a.pop()
    if (this.a.length) {
      this.a[0] = last
      let i = 0
      while (true) {
        const l = 2 * i + 1, r = 2 * i + 2
        let m = i
        if (l < this.a.length && this.a[l][0] < this.a[m][0]) m = l
        if (r < this.a.length && this.a[r][0] < this.a[m][0]) m = r
        if (m === i) break
        ;[this.a[m], this.a[i]] = [this.a[i], this.a[m]]
        i = m
      }
    }
    return top ? { area: top[0], index: top[1] } : undefined
  }
}
function visvalingamWhyatt(points, areaThreshold) {
  const n = points.length
  if (n <= 2) return points.slice()
  const prev = new Array(n), next = new Array(n), removed = new Array(n).fill(false), area = new Array(n).fill(Infinity)
  for (let i = 0; i < n; i++) { prev[i] = i - 1; next[i] = i + 1 }
  next[n - 1] = -1
  function computeArea(i) {
    if (i <= 0 || i >= n - 1 || removed[i]) return Infinity
    const p = prev[i], q = next[i]
    if (p < 0 || q < 0) return Infinity
    return triangleArea(points[p], points[i], points[q])
  }
  const heap = new MinHeap()
  for (let i = 1; i < n - 1; i++) { area[i] = computeArea(i); heap.push(i, area[i]) }
  while (heap.size() > 0) {
    const top = heap.pop()
    const i = top.index
    if (removed[i] || top.area !== area[i]) continue
    if (top.area >= areaThreshold) break
    removed[i] = true
    const p = prev[i], q = next[i]
    next[p] = q
    prev[q] = p
    if (p > 0) { area[p] = computeArea(p); heap.push(p, area[p]) }
    if (q < n - 1) { area[q] = computeArea(q); heap.push(q, area[q]) }
  }
  const out = []
  let cur = 0
  while (cur !== -1) { out.push(points[cur]); cur = next[cur] }
  return out
}

for (const eps of [0.22, 0.25, 0.28, 0.32, 0.35]) {
  const absArcs = decodeAbsoluteArcs(topo)
  const simplifiedArcs = absArcs.map((a) => visvalingamWhyatt(a, eps))
  const simplifiedTopo = { ...topo, transform: undefined, arcs: simplifiedArcs }
  const fc = feature(simplifiedTopo, simplifiedTopo.objects.countries)
  const proj520 = geoMercator().translate([260, 180]).scale(70)
  const path520 = geoPath(proj520)
  const entries = []
  for (const f of fc.features) {
    const dd = path520(f) ?? ''
    if (!dd) continue
    entries.push({ id: String(f.id ?? 'x'), alpha2: 'XX', d: dd.replace(/-?\d+\.\d+/g, (m) => Number(m).toFixed(1)) })
  }
  console.log('520 eps', eps, Buffer.byteLength(JSON.stringify(entries), 'utf8'), 'features', entries.length)
}
