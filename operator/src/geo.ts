/** Geo from Cloudflare `request.cf` only. The Electron client never sends coordinates. */

export interface CfGeo {
  country: string | null
  city: string | null
  region?: string | null
  lat: number | null
  lon: number | null
}

const ISO = /^[A-Z]{2}$/
const CF_SPECIAL = new Set(['XX', 'T1'])

function asCountry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const code = raw.trim().toUpperCase()
  if (ISO.test(code) || CF_SPECIAL.has(code)) return code
  return null
}

function asCity(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const city = raw.trim().slice(0, 80)
  return city || null
}

function asRegion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const region = raw.trim().slice(0, 80)
  return region || null
}

function asCoord(raw: unknown, min: number, max: number): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < min || n > max) return null
  return Math.round(n * 1000) / 1000
}

/** Read country / city / lat / lon from the Worker request. Never read IP. */
export function geoFromRequest(request: Request): CfGeo {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf
  if (!cf || typeof cf !== 'object') {
    return { country: null, city: null, region: null, lat: null, lon: null }
  }
  return {
    country: asCountry(cf.country),
    city: asCity(cf.city),
    region: asRegion(cf.region),
    lat: asCoord(cf.latitude, -90, 90),
    lon: asCoord(cf.longitude, -180, 180)
  }
}

/** Client body fields that must never become stored geo. */
export const CLIENT_GEO_KEYS = ['lat', 'lon', 'latitude', 'longitude', 'country', 'city', 'ip', 'clientIp'] as const

export function emptyGeo(): CfGeo {
  return { country: null, city: null, region: null, lat: null, lon: null }
}
