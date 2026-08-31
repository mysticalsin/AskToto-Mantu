import { createHash, createHmac, randomUUID } from 'node:crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '@shared/operator-hmac'

export function sha256HexUtf8(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

export function signOperatorIngest(
  secret: string,
  ts: string,
  nonce: string,
  deviceId: string,
  body: string
): string {
  return createHmac('sha256', secret).update(ingestCanonical(ts, nonce, deviceId, sha256HexUtf8(body))).digest('hex')
}

export function hashOperatorId(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32)
}

export function operatorHmacHeaders(
  secret: string,
  deviceId: string,
  body: string,
  now = Date.now()
): Record<string, string> {
  const ts = String(now)
  const nonce = randomUUID()
  return {
    [OPERATOR_HMAC_HEADERS.ts]: ts,
    [OPERATOR_HMAC_HEADERS.nonce]: nonce,
    [OPERATOR_HMAC_HEADERS.device]: deviceId,
    [OPERATOR_HMAC_HEADERS.sig]: signOperatorIngest(secret, ts, nonce, deviceId, body)
  }
}
