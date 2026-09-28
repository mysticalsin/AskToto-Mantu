import Foundation
import CryptoKit

/// Fleet model policy (M2-0412): the owner picks a provider + model per capability in the Operator
/// portal, and every Métis app — including this native macOS app — fetches, verifies and caches that
/// document. Mirrors `src/shared/model-policy.ts` exactly (capability order, canonical signing
/// payload) so a signature produced by the Operator Worker verifies here with no format translation.
///
/// The native app has no cloud-model call site today (`Intelligence.swift` only wraps Apple's
/// on-device Foundation Models framework — see its own doc comment) — there is nothing yet to route
/// through a resolved policy. `ModelPolicyRuntime` below still fetches, verifies, caches, and is wired
/// into `MetisApp.swift`'s launch (start + <=60s poll), so the app is ready the day a cloud-routed
/// capability is added, and so the fleet owner's policy audit trail includes every platform, not just
/// the Electron app. What is genuinely missing is a device pairing/license flow for this app (this
/// package has no Keychain or network credential storage anywhere yet) — until one exists,
/// `ModelPolicyRuntime`'s `secretProvider` has no credential to return and every poll tick no-ops.
public enum ModelPolicyCapability: String, CaseIterable, Codable, Sendable {
    case askChat
    case commandAgent
    case recap
    case stt
    case tts
    case embeddings
    case localModel
}

/// Fixed order — every canonical-payload byte in this file depends on this exact sequence matching
/// `MODEL_POLICY_CAPABILITIES` in src/shared/model-policy.ts.
public let modelPolicyCapabilityOrder: [ModelPolicyCapability] = [
    .askChat, .commandAgent, .recap, .stt, .tts, .embeddings, .localModel
]

public struct ModelPolicyFallback: Codable, Equatable, Sendable {
    public let provider: String
    public let model: String

    public init(provider: String, model: String) {
        self.provider = provider
        self.model = model
    }
}

public struct ModelPolicyEntry: Codable, Equatable, Sendable {
    public let provider: String
    public let model: String
    public let fallbacks: [ModelPolicyFallback]

    public init(provider: String, model: String, fallbacks: [ModelPolicyFallback] = []) {
        self.provider = provider
        self.model = model
        self.fallbacks = fallbacks
    }
}

public struct ModelPolicyDocument: Codable, Equatable, Sendable {
    public let version: Int
    public let updatedAt: Int
    public let updatedBy: String
    public let capabilities: [String: ModelPolicyEntry]

    public init(version: Int, updatedAt: Int, updatedBy: String, capabilities: [String: ModelPolicyEntry]) {
        self.version = version
        self.updatedAt = updatedAt
        self.updatedBy = updatedBy
        self.capabilities = capabilities
    }

    /// `nil` when the document is missing an entry for one of the seven fixed capabilities — a
    /// malformed or partial document (e.g. a future incompatible shape) must never be treated as
    /// having silently granted "not managed" for the missing ones.
    func entry(for capability: ModelPolicyCapability) -> ModelPolicyEntry? {
        capabilities[capability.rawValue]
    }

    /// True only when every one of the seven fixed capabilities has an entry — the same completeness
    /// the Worker's Zod schema enforces before it will ever sign a document.
    public var isComplete: Bool {
        modelPolicyCapabilityOrder.allSatisfy { capabilities[$0.rawValue] != nil }
    }
}

public struct SignedModelPolicy: Codable, Equatable, Sendable {
    public let policy: ModelPolicyDocument
    public let signature: String

    public init(policy: ModelPolicyDocument, signature: String) {
        self.policy = policy
        self.signature = signature
    }
}

public enum ModelPolicy {
    /// Byte-for-byte identical to `canonicalModelPolicyPayload` in src/shared/model-policy.ts — the
    /// single source of truth both sides must never drift from independently.
    public static func canonicalPayload(_ policy: ModelPolicyDocument) -> String {
        let capString = modelPolicyCapabilityOrder.map { capability -> String in
            let entry = policy.capabilities[capability.rawValue] ?? ModelPolicyEntry(provider: "", model: "")
            let fallbacks = entry.fallbacks.map { "\($0.provider):\($0.model)" }.joined(separator: ",")
            return "\(capability.rawValue)=\(entry.provider):\(entry.model)[\(fallbacks)]"
        }.joined(separator: "|")
        return "metis-model-policy.v1.\(policy.version).\(policy.updatedAt).\(policy.updatedBy).\(capString)"
    }

    /// HMAC-SHA256 over `canonicalPayload`, hex-encoded lowercase — matches `hmacHex`
    /// (operator/src/hmac.ts) and `createHmac('sha256', ...)` (src/main/model-policy-client.ts) bit
    /// for bit given the same secret and document.
    public static func sign(_ policy: ModelPolicyDocument, secret: String) -> String {
        let key = SymmetricKey(data: Data(secret.utf8))
        let mac = HMAC<SHA256>.authenticationCode(for: Data(canonicalPayload(policy).utf8), using: key)
        return mac.map { String(format: "%02x", $0) }.joined()
    }

    /// Constant-time compare (via CryptoKit's own MAC verification, not a plain `==` on hex strings).
    public static func verify(_ signed: SignedModelPolicy, secret: String) -> Bool {
        guard signed.policy.isComplete, !secret.isEmpty, !signed.signature.isEmpty else { return false }
        let key = SymmetricKey(data: Data(secret.utf8))
        guard let signatureBytes = hexDecode(signed.signature.lowercased()) else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(
            signatureBytes, authenticating: Data(canonicalPayload(signed.policy).utf8), using: key
        )
    }

    private static func hexDecode(_ hex: String) -> Data? {
        guard hex.count % 2 == 0 else { return nil }
        var data = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            data.append(byte)
            index = next
        }
        return data
    }
}

/// Fetches `GET /v1/model-policy` (device-HMAC-authenticated, same contract as the Electron app's
/// `src/main/model-policy-client.ts`), verifies it locally, and caches the last verified document to
/// disk for offline use. `URLSession`/the device HMAC header builder are both injectable so tests
/// never touch the network or a real device secret.
public actor ModelPolicyClient {
    public typealias FetchFn = @Sendable (URL) async throws -> (Data, URLResponse)

    private let fetchFn: FetchFn
    private let cacheURL: URL
    private var current: ModelPolicyDocument?

    public init(cacheURL: URL, fetchFn: @escaping FetchFn) {
        self.cacheURL = cacheURL
        self.fetchFn = fetchFn
    }

    public func activePolicy() -> ModelPolicyDocument? { current }

    /// Loads the last verified policy from disk (offline use after a relaunch), re-verifying against
    /// the current secret so a rotated credential invalidates a stale cache instead of trusting it.
    public func loadCached(secret: String) {
        guard current == nil, let data = try? Data(contentsOf: cacheURL) else { return }
        guard let signed = try? JSONDecoder().decode(SignedModelPolicy.self, from: data) else { return }
        guard ModelPolicy.verify(signed, secret: secret) else { return }
        current = signed.policy
    }

    /// Fetches, verifies, and — on success — applies and caches. Returns `.rejected` (never applies,
    /// never crashes the caller) for a tampered, unsigned, or incomplete document; `.notManaged` when
    /// the Operator has no fleet policy configured; `.networkError` on a transport failure, leaving
    /// the last verified policy (if any) untouched for offline use.
    public enum RefreshOutcome: Equatable { case applied, notManaged, rejected(String), networkError }

    public func refresh(url: URL, secret: String) async -> RefreshOutcome {
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await fetchFn(url)
        } catch {
            return .networkError
        }
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            return .networkError
        }
        guard let body = try? JSONDecoder().decode(ModelPolicyFetchBody.self, from: data), body.ok else {
            return .networkError
        }
        guard let policy = body.policy else {
            // The Operator has no fleet policy configured: "not managed", not a rejection. Clears any
            // previously cached policy — the owner deliberately unset it.
            current = nil
            try? FileManager.default.removeItem(at: cacheURL)
            return .notManaged
        }
        guard let signature = body.signature else { return .rejected("missing signature") }
        let signed = SignedModelPolicy(policy: policy, signature: signature)
        guard policy.isComplete else { return .rejected("schema") }
        guard ModelPolicy.verify(signed, secret: secret) else { return .rejected("signature") }
        current = policy
        if let encoded = try? JSONEncoder().encode(signed) {
            try? encoded.write(to: cacheURL, options: .atomic)
        }
        return .applied
    }
}

private struct ModelPolicyFetchBody: Codable {
    let ok: Bool
    let policy: ModelPolicyDocument?
    let signature: String?
}

/// Drives `ModelPolicyClient.refresh(url:secret:)` at app start and on a repeating poll, so this native
/// app participates in the fleet policy the same way the Electron app does (`operator-ingest.ts`'s 60s
/// heartbeat tick, `src/main/model-policy-client.ts`) instead of only ever holding a client nobody calls.
///
/// `secretProvider` returning `nil` is a silent skip, not an error: this app has no device pairing/
/// license flow yet (see this file's top doc comment — no other Foundation networking exists in
/// `native-app/App/` today either), so there is no device-authenticated credential to sign with. The app
/// target wires this against `UserDefaults` keys nothing populates yet; the day a real pairing flow lands
/// it only has to start returning a value, this loop already polls and applies correctly.
public actor ModelPolicyRuntime {
    public typealias SecretProvider = @Sendable () -> String?
    public typealias SleepFn = @Sendable (Duration) async throws -> Void

    private let client: ModelPolicyClient
    private let sleepFn: SleepFn
    private var pollTask: Task<Void, Never>?

    public init(client: ModelPolicyClient, sleepFn: @escaping SleepFn = { try await Task.sleep(for: $0) }) {
        self.client = client
        self.sleepFn = sleepFn
    }

    public func activePolicy() async -> ModelPolicyDocument? {
        await client.activePolicy()
    }

    /// Idempotent: replaces any already-running loop. Refreshes immediately, then every `pollInterval`
    /// (default 60s — the acceptance bar is "poll <= 60s") until `stop()` or the loop's sleep is
    /// cancelled. A refresh failure (network, tamper, missing policy) never stops the loop — the next
    /// tick tries again, same as the Electron heartbeat.
    public func start(url: URL, pollInterval: Duration = .seconds(60), secretProvider: @escaping SecretProvider) {
        pollTask?.cancel()
        let client = self.client
        let sleepFn = self.sleepFn
        pollTask = Task {
            while !Task.isCancelled {
                if let secret = secretProvider() {
                    _ = await client.refresh(url: url, secret: secret)
                }
                do {
                    try await sleepFn(pollInterval)
                } catch {
                    break
                }
            }
        }
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
    }
}
