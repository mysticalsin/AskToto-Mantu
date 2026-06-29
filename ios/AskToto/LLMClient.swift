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

/// Records the time of the last stream activity so an idle watchdog can detect silence without ever
/// touching the task group. An actor gives safe cross-task access (the producer bumps it, the watchdog
/// reads it) with no locks and no `inout`/non-Sendable captures.
private actor StreamIdleClock {
    private var last = ContinuousClock.now
    func bump() { last = ContinuousClock.now }
    func idle() -> Duration { ContinuousClock.now - last }
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

                    // #19 — per-stream idle watchdog. Two structured children race: the producer
                    // streams tokens and bumps an activity clock; the watchdog wakes periodically and
                    // fires once the clock has been idle for `idleTimeout`. Whichever finishes first
                    // decides the outcome, so BOTH a first-token stall and a mid-stream hang surface as
                    // LLMError.streamTimeout. Cancellation is driven from the OUTER scope via
                    // group.cancelAll(); neither child captures `group` — that would not compile, since
                    // `group` is a non-escapable `inout` and the child closures are @escaping @Sendable.
                    let clock = StreamIdleClock()
                    try await withThrowingTaskGroup(of: Bool.self) { group in
                        // Producer — streams deltas, bumps the clock. Returns false (it never "times out").
                        group.addTask {
                            for try await line in bytes.lines {
                                await clock.bump()
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
                            return false
                        }
                        // Watchdog — wakes every 2s and fires (returns true) once the stream has been
                        // idle for `idleTimeout`. Exits quietly (false) when cancelled by the producer.
                        group.addTask {
                            while true {
                                try? await Task.sleep(for: .seconds(2))
                                if Task.isCancelled { return false }
                                if await clock.idle() >= idleTimeout { return true }
                            }
                        }
                        // First child to finish decides it; cancel the loser. Producer-done → false → no
                        // throw; watchdog-fired → true → streamTimeout.
                        let timedOut = try await group.next() ?? false
                        group.cancelAll()
                        if timedOut { throw LLMError.streamTimeout }
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
            // #20 — yield only the final answer `content`. reasoning_content (o1/o3, deepseek-reasoner,
            // NIM r1) is the model's chain-of-thought; appending it would leak CoT into the displayed/
            // saved answer, so it is intentionally dropped — the user-facing answer arrives in `content`.
            let deltaObj = (obj["choices"] as? [[String: Any]])?.first?["delta"] as? [String: Any]
            let content = deltaObj?["content"] as? String ?? ""
            return content.isEmpty ? nil : content
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
