import Foundation
import Security
import SwiftUI

/// Keychain-backed API key store (per provider). Keys never touch UserDefaults.
enum Keychain {
    static func set(_ value: String, for account: String) {
        let acct = "asktoto.\(account)"
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrAccount as String: acct]
        SecItemDelete(q as CFDictionary)
        guard !value.isEmpty else { return }
        var add = q
        add[kSecValueData as String] = value.data(using: .utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
    static func get(_ account: String) -> String {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrAccount as String: "asktoto.\(account)",
                                kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let d = out as? Data, let s = String(data: d, encoding: .utf8) else { return "" }
        return s
    }
}

@MainActor
final class AppState: ObservableObject {
    @AppStorage("providerId") var providerId: String = "anthropic"
    @AppStorage("mode") private var modeRaw: String = ConvMode.general.rawValue
    @AppStorage("profile") var profile: String = ""
    @AppStorage("temperature") var temperature: Double = 0.4
    @AppStorage("onboardingDone") var onboardingDone: Bool = false
    // Per-provider model + per-mode prompt overrides, JSON-encoded in AppStorage.
    @AppStorage("providerModels") private var providerModelsJSON: String = "{}"
    @AppStorage("modePrompts") private var modePromptsJSON: String = "{}"

    @Published var hasKey: [String: Bool] = [:]

    var provider: Provider { Providers.by(id: providerId) }
    var mode: ConvMode {
        get { ConvMode(rawValue: modeRaw) ?? .general }
        set { modeRaw = newValue.rawValue; objectWillChange.send() }
    }

    init() { refreshKeys() }

    func refreshKeys() {
        var m: [String: Bool] = [:]
        for p in Providers.all { m[p.id] = !Keychain.get(p.id).isEmpty }
        hasKey = m
    }
    func key(for id: String) -> String { Keychain.get(id) }
    func setKey(_ value: String, for id: String) { Keychain.set(value, for: id); refreshKeys() }

    func model(for id: String) -> String {
        let dict = (try? JSONDecoder().decode([String: String].self, from: Data(providerModelsJSON.utf8))) ?? [:]
        return dict[id] ?? Providers.by(id: id).defaultModel
    }
    func setModel(_ value: String, for id: String) {
        var dict = (try? JSONDecoder().decode([String: String].self, from: Data(providerModelsJSON.utf8))) ?? [:]
        dict[id] = value
        providerModelsJSON = String(data: (try? JSONEncoder().encode(dict)) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
    }
    func prompt(for mode: ConvMode) -> String? {
        let dict = (try? JSONDecoder().decode([String: String].self, from: Data(modePromptsJSON.utf8))) ?? [:]
        return dict[mode.rawValue]
    }
    func setPrompt(_ value: String?, for mode: ConvMode) {
        var dict = (try? JSONDecoder().decode([String: String].self, from: Data(modePromptsJSON.utf8))) ?? [:]
        if let v = value, !v.isEmpty { dict[mode.rawValue] = v } else { dict[mode.rawValue] = nil }
        modePromptsJSON = String(data: (try? JSONEncoder().encode(dict)) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
    }

    var systemPrompt: String {
        Prompts.system(for: mode, profile: profile, custom: prompt(for: mode))
    }
}
