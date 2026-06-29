import Foundation

struct ChatTurn { let role: String; let content: String }

enum LLMError: LocalizedError {
    case noKey, http(Int, String), badResponse, streamTimeout
    var errorDescription: String? {
        switch self {
        case .noKey: return "No API key. Add one in Settings."
        case .http(let c, let m): return "Provider error \(c): \(m)"
        case .badResponse: return "Unexpected response from the provider."
        case .streamTimeout: return "No response from the provider for 120 seconds. Please try again."
        }
    }
}

/// Streams an answer as an AsyncThrowingStream<String> of text deltas. Handles both wire protocols.
enum LLMClient {
    /// Idle timeout: cancel the stream if no token arrives within this interval.
    private static let idleTimeout: Duration = .seconds(120)

    static func stream(provider: Provider, apiKey: String, model: String, system: String,
                       history: [ChatTurn], user: String, imageBase64: String?,
                       temperature: Double) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard !apiKey.isEmpty else { throw LLMError.noKey }
                    let request = try buildRequest(provider: provider, apiKey: apiKey, model: model,
                                                   system: system, history: history, user: user,
                                                   imageBase64: imageBase64, temperature: temperature)
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                        var body = ""
                        for try await line in bytes.lines { body += line; if body.count > 600 { break } }
                        throw LLMError.http(http.statusCode, String(body.prefix(300)))
                    }

                    // #19 — per-stream idle watchdog: races the line iterator against a timeout
                    // that resets on every received chunk.  A hanging connection will lose the race
                    // after `idleTimeout` of silence and surface LLMError.streamTimeout.
                    try await withThrowingTaskGroup(of: Void.self) { group in
                        // Watchdog: a child Task sleeps for `idleTimeout`; the iterator cancels &
                        // replaces it on each received chunk.  If the sleep completes without being
                        // cancelled it means no token arrived in time → throw streamTimeout.
                        // WatchdogHolder is @unchecked Sendable: mutation is always on one Task.
                        final class WatchdogHolder: @unchecked Sendable {
                            var task: Task<Void, Never>?

                            func reset(timeout: Duration, onFire: @escaping @Sendable () -> Void) {
                                task?.cancel()
                                task = Task {
                                    do {
                                        try await Task.sleep(for: timeout)
                                        onFire()
                                    } catch { /* cancelled — new watchdog will be started */ }
                                }
                            }

                            func cancel() { task?.cancel(); task = nil }
                        }

                        let watchdog = WatchdogHolder()
                        // Stream iterator task
                        group.addTask {
                            watchdog.reset(timeout: idleTimeout) {
                                // surface timeout through continuation
                                group.cancelAll()
                            }
                            var timedOut = false
                            for try await line in bytes.lines {
                                // Got activity — reset the watchdog
                                watchdog.reset(timeout: idleTimeout) {
                                    timedOut = true
                                    group.cancelAll()
                                }
                                guard line.hasPrefix("data:") else { continue }
                                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                                if payload == "[DONE]" { break }
                                guard let data = payload.data(using: .utf8),
                                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                                else { continue }
                                if let text = delta(from: obj, kind: provider.kind), !text.isEmpty {
                                    continuation.yield(text)
                                }
                            }
                            watchdog.cancel()
                            if timedOut { throw LLMError.streamTimeout }
                        }
                        try await group.waitForAll()
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func delta(from obj: [String: Any], kind: ProviderKind) -> String? {
        switch kind {
        case .openai:
            // #20 — also surface reasoning_content deltas emitted by reasoning models (e.g. o1, o3).
            let deltaObj = (obj["choices"] as? [[String: Any]])?.first?["delta"] as? [String: Any]
            let content = deltaObj?["content"] as? String ?? ""
            let reasoning = deltaObj?["reasoning_content"] as? String ?? ""
            let combined = reasoning + content
            return combined.isEmpty ? nil : combined
        case .anthropic:
            // event: content_block_delta -> { delta: { type: text_delta, text } }
            if (obj["type"] as? String) == "content_block_delta",
               let d = obj["delta"] as? [String: Any] { return d["text"] as? String }
            return nil
        }
    }

    private static func buildRequest(provider: Provider, apiKey: String, model: String, system: String,
                                     history: [ChatTurn], user: String, imageBase64: String?,
                                     temperature: Double) throws -> URLRequest {
        var body: [String: Any] = ["model": model, "stream": true]
        let url: URL
        var headers: [String: String] = ["Content-Type": "application/json"]

        switch provider.kind {
        case .anthropic:
            url = URL(string: "https://api.anthropic.com/v1/messages")!
            headers["x-api-key"] = apiKey
            headers["anthropic-version"] = "2023-06-01"
            body["max_tokens"] = 4096
            body["temperature"] = temperature
            body["system"] = system
            var msgs: [[String: Any]] = history.map { ["role": $0.role, "content": $0.content] }
            if let img = imageBase64 {
                msgs.append(["role": "user", "content": [
                    ["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": img]],
                    ["type": "text", "text": user]
                ]])
            } else {
                msgs.append(["role": "user", "content": user])
            }
            body["messages"] = msgs
        case .openai:
            url = URL(string: "\(provider.baseURL)/chat/completions")!
            headers["Authorization"] = "Bearer \(apiKey)"
            body["max_tokens"] = 4096
            body["temperature"] = temperature
            var msgs: [[String: Any]] = [["role": "system", "content": system]]
            msgs += history.map { ["role": $0.role, "content": $0.content] }
            if let img = imageBase64 {
                msgs.append(["role": "user", "content": [
                    ["type": "text", "text": user],
                    ["type": "image_url", "image_url": ["url": "data:image/jpeg;base64,\(img)"]]
                ]])
            } else {
                msgs.append(["role": "user", "content": user])
            }
            body["messages"] = msgs
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        req.timeoutInterval = 120
        return req
    }
}
