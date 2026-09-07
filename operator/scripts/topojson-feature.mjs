/**
 * Minimal TopoJSON feature() decoder, vendored to avoid a topojson-client dependency.
 * Adapted from topojson-client (https://github.com/topojson/topojson-client), Copyright
 * 2012-2021 Michael Bostock, ISC License. Reimplements only `feature()`: arc delta-decoding
 * via the topology transform, arc stitching into rings/lines, and GeometryCollection ->
 * FeatureCollection conversion. No other topojson-client exports are reproduced.
 */

function identity(x) {
  return x
}

function transform(tf) {
  if (tf == null) return identity
  let x0, y0
  const kx = tf.scale[0]
  const ky = tf.scale[1]
  const dx = tf.translate[0]
  const dy = tf.translate[1]
  return function (input, i) {
    if (!i) { x0 = 0; y0 = 0 }
    const n = input.length
    const output = new Array(n)
    output[0] = (x0 += input[0]) * kx + dx
    output[1] = (y0 += input[1]) * ky + dy
    for (let j = 2; j < n; j++) output[j] = input[j]
    return output
  }
}

function reverse(array, n) {
  let t
  let j = array.length
  let i = j - n
  while (i < --j) {
    t = array[i]
    array[i++] = array[j]
    array[j--] = t
  }
}

function decodeObject(topology, o) {
  const transformPoint = transform(topology.transform)
  const arcs = topology.arcs

  function arc(i, points) {
    if (points.length) points.pop()
    const a = arcs[i < 0 ? ~i : i]
    for (let k = 0, n = a.length; k < n; k++) {
      const p = a[k].slice()
      points.push(transformPoint(p, k))
    }
    if (i < 0) reverse(points, a.length)
  }

  function point(p) {
    return transformPoint(p.slice(), 0)
  }

  function line(arcIndices) {
    const points = []
    for (let i = 0; i < arcIndices.length; i++) arc(arcIndices[i], points)
    if (points.length < 2) points.push(points[0].slice())
    return points
  }

  function ring(arcIndices) {
    const points = line(arcIndices)
    while (points.length < 4) points.push(points[0].slice())
    return points
  }

  function polygon(arcIndices) {
    return arcIndices.map(ring)
  }

  function geometry(g) {
    if (g.type === 'GeometryCollection') {
      return { type: g.type, geometries: g.geometries.map(geometry) }
    }
    let coordinates
    switch (g.type) {
      case 'Point':
        coordinates = point(g.coordinates)
        break
      case 'MultiPoint':
        coordinates = g.coordinates.map(point)
        break
      case 'LineString':
        coordinates = line(g.arcs)
        break
      case 'MultiLineString':
        coordinates = g.arcs.map(line)
        break
      case 'Polygon':
        coordinates = polygon(g.arcs)
        break
      case 'MultiPolygon':
        coordinates = g.arcs.map(polygon)
        break
      default:
        return null
    }
    return { type: g.type, coordinates }
  }

  return geometry(o)
}

function featureOf(topology, o) {
  const id = o.id
  const properties = o.properties == null ? {} : o.properties
  const geometry = decodeObject(topology, o)
  return id == null
    ? { type: 'Feature', properties, geometry }
    : { type: 'Feature', id, properties, geometry }
}

/** Decode a TopoJSON object (a GeometryCollection or a single geometry) into GeoJSON. */
export function feature(topology, object) {
  return object.type === 'GeometryCollection'
    ? { type: 'FeatureCollection', features: object.geometries.map((g) => featureOf(topology, g)) }
    : featureOf(topology, object)
}
