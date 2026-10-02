import Foundation
import CryptoKit

/// Legacy fleet-wide device HMAC (operator/src/device-auth.ts's non-licence branch): every request is
/// signed with a single Operator-wide ingest secret plus a per-installation device id. Mirrors
/// `src/shared/operator-hmac.ts` (`ingestCanonical`) and `src/main/operator-hmac-sign.ts`
/// (`operatorHmacHeaders`) byte for byte, so a signature produced here verifies on the Worker with no
/// format translation — the same scheme the Electron app already uses today (a real per-device
/// credential binding lands with M2-0145; this is today's baseline, not a weaker stand-in for it).
public enum OperatorDeviceAuth {
    public static let tsHeader = "x-metis-ts"
    public static let nonceHeader = "x-metis-nonce"
    public static let deviceHeader = "x-metis-device"
    public static let sigHeader = "x-metis-sig"

    /// `${ts}.${nonce}.${deviceId}.${bodySha256Hex}` — must match `ingestCanonical` exactly.
    public static func canonical(ts: String, nonce: String, deviceId: String, bodySha256Hex: String) -> String {
        "\(ts).\(nonce).\(deviceId).\(bodySha256Hex)"
    }

    public static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public static func hmacHex(secret: String, message: String) -> String {
        let key = SymmetricKey(data: Data(secret.utf8))
        let mac = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)
        return mac.map { String(format: "%02x", $0) }.joined()
    }

    /// `hashOperatorId` — sha256Hex truncated to 32 hex chars, so the header never carries the raw
    /// per-installation identifier it was derived from.
    public static func hashDeviceId(_ raw: String) -> String {
        String(sha256Hex(raw).prefix(32))
    }

    /// The four device-HMAC headers for a request with this exact `body` (empty string for a GET, e.g.
    /// `/v1/model-policy`). `ts`/`nonce` are injectable so tests are deterministic.
    public static func headers(
        secret: String,
        deviceId: String,
        body: String,
        ts: String = String(Int(Date().timeIntervalSince1970 * 1000)),
        nonce: String = UUID().uuidString
    ) -> [String: String] {
        let sig = hmacHex(
            secret: secret,
            message: canonical(ts: ts, nonce: nonce, deviceId: deviceId, bodySha256Hex: sha256Hex(body))
        )
        return [tsHeader: ts, nonceHeader: nonce, deviceHeader: deviceId, sigHeader: sig]
    }
}
