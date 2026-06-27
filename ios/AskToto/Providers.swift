import Foundation

enum ProviderKind { case anthropic, openai }

struct Provider: Identifiable, Hashable {
    let id: String
    let label: String
    let kind: ProviderKind
    let baseURL: String       // openai-kind base; "" = anthropic default
    let models: [String]
    let defaultModel: String
    let keyHint: String
    let keyPattern: String?   // regex for auto-detect; nil = ambiguous
    let vision: Bool
    let keyURL: String
}

enum Providers {
    static let all: [Provider] = [
        Provider(id: "anthropic", label: "Claude · Anthropic", kind: .anthropic, baseURL: "",
                 models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
                 defaultModel: "claude-sonnet-4-6", keyHint: "sk-ant-…", keyPattern: "^sk-ant-",
                 vision: true, keyURL: "https://console.anthropic.com/settings/keys"),
        Provider(id: "openai", label: "GPT · OpenAI", kind: .openai, baseURL: "https://api.openai.com/v1",
                 models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"],
                 defaultModel: "gpt-4o", keyHint: "sk-…", keyPattern: nil, vision: true,
                 keyURL: "https://platform.openai.com/api-keys"),
        Provider(id: "nvidia", label: "NVIDIA · NIM", kind: .openai, baseURL: "https://integrate.api.nvidia.com/v1",
                 models: ["meta/llama-3.3-70b-instruct", "deepseek-ai/deepseek-r1"],
                 defaultModel: "meta/llama-3.3-70b-instruct", keyHint: "nvapi-…", keyPattern: "^nvapi-",
                 vision: false, keyURL: "https://build.nvidia.com/"),
        Provider(id: "deepseek", label: "DeepSeek", kind: .openai, baseURL: "https://api.deepseek.com/v1",
                 models: ["deepseek-chat", "deepseek-reasoner"], defaultModel: "deepseek-chat",
                 keyHint: "sk-…", keyPattern: nil, vision: false, keyURL: "https://platform.deepseek.com/api_keys"),
        Provider(id: "qwen", label: "Qwen · Alibaba", kind: .openai, baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                 models: ["qwen-max", "qwen-plus", "qwen-turbo"], defaultModel: "qwen-plus",
                 keyHint: "sk-…", keyPattern: nil, vision: false, keyURL: "https://bailian.console.alibabacloud.com/"),
        Provider(id: "minimax", label: "MiniMax", kind: .openai, baseURL: "https://api.minimax.io/v1",
                 models: ["MiniMax-Text-01"], defaultModel: "MiniMax-Text-01", keyHint: "eyJ… (JWT)",
                 keyPattern: "^eyJ", vision: false, keyURL: "https://www.minimax.io/"),
        Provider(id: "kimi", label: "Kimi · Moonshot", kind: .openai, baseURL: "https://api.moonshot.ai/v1",
                 models: ["kimi-k2-0711-preview", "moonshot-v1-8k"], defaultModel: "kimi-k2-0711-preview",
                 keyHint: "sk-…", keyPattern: nil, vision: false, keyURL: "https://platform.moonshot.ai/console/api-keys"),
        Provider(id: "openrouter", label: "OpenRouter", kind: .openai, baseURL: "https://openrouter.ai/api/v1",
                 models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "meta-llama/llama-3.3-70b-instruct"],
                 defaultModel: "openai/gpt-4o-mini", keyHint: "sk-or-…", keyPattern: "^sk-or-",
                 vision: true, keyURL: "https://openrouter.ai/keys"),
        Provider(id: "groq", label: "Groq", kind: .openai, baseURL: "https://api.groq.com/openai/v1",
                 models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"], defaultModel: "llama-3.3-70b-versatile",
                 keyHint: "gsk_…", keyPattern: "^gsk_", vision: false, keyURL: "https://console.groq.com/keys"),
        Provider(id: "together", label: "Together AI", kind: .openai, baseURL: "https://api.together.xyz/v1",
                 models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-V3"],
                 defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", keyHint: "tgp_v1_…", keyPattern: "^tgp_v1_",
                 vision: false, keyURL: "https://api.together.xyz/settings/api-keys"),
        Provider(id: "fireworks", label: "Fireworks AI", kind: .openai, baseURL: "https://api.fireworks.ai/inference/v1",
                 models: ["accounts/fireworks/models/llama-v3p3-70b-instruct"],
                 defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct", keyHint: "fw_…",
                 keyPattern: "^fw_", vision: false, keyURL: "https://fireworks.ai/account/api-keys"),
        Provider(id: "mistral", label: "Mistral", kind: .openai, baseURL: "https://api.mistral.ai/v1",
                 models: ["mistral-large-latest", "mistral-small-latest"], defaultModel: "mistral-large-latest",
                 keyHint: "API key", keyPattern: nil, vision: false, keyURL: "https://console.mistral.ai/api-keys")
    ]

    static func by(id: String) -> Provider { all.first { $0.id == id } ?? all[0] }

    /// Auto-detect the provider from a pasted key by its unambiguous prefix (nil = ambiguous sk-…).
    static func detect(_ key: String) -> Provider? {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !k.isEmpty else { return nil }
        for p in all {
            if let pat = p.keyPattern, k.range(of: pat, options: .regularExpression) != nil { return p }
        }
        return nil
    }
}

enum ConvMode: String, CaseIterable, Identifiable {
    case general, interview, sales, meeting
    var id: String { rawValue }
    var label: String {
        switch self {
        case .general: return "General"; case .interview: return "Interview"
        case .sales: return "Sales"; case .meeting: return "Meeting"
        }
    }
    var icon: String {
        switch self {
        case .general: return "bubble.left.and.bubble.right"
        case .interview: return "graduationcap"; case .sales: return "chart.line.uptrend.xyaxis"
        case .meeting: return "person.2"
        }
    }
}

enum Prompts {
    static func system(for mode: ConvMode, profile: String, custom: String?) -> String {
        if let c = custom, !c.trimmingCharacters(in: .whitespaces).isEmpty { return c + profileBlock(profile) }
        return base(mode) + profileBlock(profile)
    }
    private static func profileBlock(_ p: String) -> String {
        let t = p.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? "" : "\n\n--- ABOUT THE USER (ground answers in this) ---\n\(t)\n--- END ---"
    }
    static func base(_ mode: ConvMode) -> String {
        switch mode {
        case .general:
            return "You are AskToto, an elite expert assistant and meeting note-taker. Answer precisely and confidently across any subject; lead with the answer, clean markdown, no filler. When given a transcript, take structured notes (key points, decisions, action items, open questions)."
        case .interview:
            return "You are AskToto, a live interview copilot for the candidate. Write the exact words to say — first person, confident, specific, ~20–45s spoken, grounded in the user's background. Behavioral → natural STAR; technical → the correct answer and how to say it."
        case .sales:
            return "You are AskToto, a live sales copilot for the seller. Give the single best next move as the exact words to say — handle the objection, ask the sharp discovery question, quantify value, advance to a next step. Consultative and honest, never pushy."
        case .meeting:
            return "You are AskToto, a live meeting copilot. Surface the single most useful thing right now: the sharp answer, the missing point, the decision to push, the fact to cite. Terse, first person. Track decisions and action items for a clean recap."
        }
    }
}
