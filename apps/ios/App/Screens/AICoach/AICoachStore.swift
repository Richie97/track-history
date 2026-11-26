import Foundation
import OSLog
import Security
import TrackEvolutionKit

/// Where the AI Coach's provider keys live on iOS (#320): **in the Keychain,
/// on this device only**. Never on our servers — a key is sent with each AI
/// Coach request (`X-TE-AI-Key`) and the Worker neither stores nor logs it.
/// `public/js/ai-keys.js` is the web's counterpart.
///
/// One key per provider, one provider active (the one the AI Coach uses), and
/// per provider the model picked (nil is the default) and the list verify last
/// read, which the model field completes from. All of it is one Keychain item:
///
/// - **`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`**, and never
///   synchronizable — unlike the session token, which rides an encrypted backup
///   on purpose. A key the driver pays for must not follow a restored backup
///   onto another device without them knowing.
/// - **Cleared on sign-out** (and on a server switch), with the offline cache.
///
/// Also owns the one thing every entry point needs to know besides the key —
/// whether the device is offline, read from the offline layer — so a page of
/// session cards polls once rather than once per card.
@MainActor
@Observable
final class AICoachStore {
    struct Entry: Codable, Hashable {
        var key: String
        var model: String?
        var defaultModel: String?
        var models: [AICoachModel]
    }

    private struct Saved: Codable {
        var active: String?
        var keys: [String: Entry]
    }

    static let providerIds = AICoach.COACH_PROVIDERS.map(\.id)
    private static let log = Logger(subsystem: "app.trackevolution", category: "ai-coach")
    private static let service = "app.trackevolution.ai-coach"
    private static let account = "providers"

    private(set) var keys: [String: Entry] = [:]
    private var chosen: String?
    /// The offline layer's last word on the connection.
    private(set) var offline = false
    /// Set when an entry point found no key: Settings scrolls to the block.
    var focusSettings = false
    /// The server's scripted provider (`X-TE-AI-Provider: fake`), for the UI
    /// tests: DEBUG builds only, only with `-aiCoachFake` on the command line,
    /// and only against a dev host — and the server refuses `fake` anywhere but a
    /// dev host under DEV_MODE, so it unlocks nothing in production.
    private let fakeFlag: Bool
    private let serverHost: () -> String?
    private var fake: Bool { fakeFlag && Entitlement.DEV_HOSTS.contains(serverHost() ?? "") }

    init(serverHost: @escaping () -> String?) {
        self.serverHost = serverHost
        #if DEBUG
        self.fakeFlag = ProcessInfo.processInfo.arguments.contains("-aiCoachFake")
        #else
        self.fakeFlag = false
        #endif
        if let saved = Self.read() {
            keys = saved.keys.filter { Self.providerIds.contains($0.key) && !$0.value.key.isEmpty }
            chosen = saved.active
        }
    }

    /// The provider the AI Coach uses: the chosen one if it has a key, else
    /// whichever does.
    var activeId: String? {
        if let chosen, keys[chosen] != nil { return chosen }
        return Self.providerIds.first { keys[$0] != nil }
    }

    /// What a request is sent with, or nil when nothing is set up.
    var credential: AICoachCredential? {
        if fake { return AICoachCredential(provider: "fake", key: nil) }
        guard let id = activeId, let entry = keys[id] else { return nil }
        return AICoachCredential(provider: id, key: entry.key, model: entry.model)
    }

    /// "sk-ant-…x9Qf": enough to recognise a key by, never the key.
    static func maskKey(_ key: String) -> String {
        key.count > 14 ? "\(key.prefix(7))…\(key.suffix(4))" : "…"
    }

    // MARK: - Writes

    /// A verified key, with the models verify listed for it.
    func save(_ provider: String, key: String, verify: AICoachVerify) {
        guard Self.providerIds.contains(provider), !key.isEmpty else { return }
        keys[provider] = Entry(key: key, model: nil, defaultModel: verify.defaultModel, models: verify.models)
        if chosen.flatMap({ keys[$0] }) == nil { chosen = provider }
        persist()
    }

    func forget(_ provider: String) {
        keys[provider] = nil
        if chosen == provider { chosen = activeId }
        persist()
    }

    func setActive(_ provider: String) {
        guard keys[provider] != nil else { return }
        chosen = provider
        persist()
    }

    func setModel(_ provider: String, _ model: String?) {
        guard keys[provider] != nil else { return }
        let trimmed = model?.trimmingCharacters(in: .whitespacesAndNewlines)
        keys[provider]?.model = (trimmed?.isEmpty ?? true) ? nil : trimmed
        persist()
    }

    /// Re-read the models a provider's key can use. A failed refresh leaves the
    /// stored list standing — a provider that is down is no reason to empty the
    /// field's choices.
    func refreshModels(_ provider: String, api: APIClient) async {
        guard let entry = keys[provider] else { return }
        guard case .ok(let verify) = await api.verifyAICoachKey(provider: provider, key: entry.key),
              keys[provider]?.key == entry.key
        else { return }
        keys[provider]?.models = verify.models
        keys[provider]?.defaultModel = verify.defaultModel
        persist()
    }

    /// Sign-out: nothing of the previous driver's stays on the device.
    func clear() {
        keys = [:]
        chosen = nil
        Self.delete()
    }

    // MARK: - The connection

    /// Follow the offline layer's view of the connection — run once, by the
    /// signed-in shell.
    func watch(_ api: APIClient) async {
        while !Task.isCancelled {
            offline = await api.syncStatus()?.offline ?? false
            try? await Task.sleep(for: .seconds(3))
        }
    }

    // MARK: - The Keychain

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    private func persist() {
        guard !keys.isEmpty else {
            Self.delete()
            return
        }
        guard let data = try? JSONEncoder().encode(Saved(active: activeId, keys: keys)) else { return }
        Self.delete()
        var attributes = Self.baseQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status != errSecSuccess {
            Self.log.error("keychain write failed: \(status, privacy: .public)")
        }
    }

    private static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    private static func read() -> Saved? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            if status != errSecItemNotFound {
                log.error("keychain read failed: \(status, privacy: .public)")
            }
            return nil
        }
        return try? JSONDecoder().decode(Saved.self, from: data)
    }
}
