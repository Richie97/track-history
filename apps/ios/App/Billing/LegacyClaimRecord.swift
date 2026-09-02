import Foundation

/// The once-only flag for the paid-app grandfather claim (NS-32 requirement 6),
/// per account per server, in `UserDefaults`.
///
/// Not the Keychain: this is a memo, not a credential. Losing it — a reinstall, a
/// new phone — costs exactly one idempotent request, because the server upserts
/// the legacy row by app transaction id and answers 409 when it already belongs
/// to another account, which `StoreController` also records as done. Keyed by
/// server as well as user id so a dev build pointed at `wrangler dev` and back
/// doesn't carry one deployment's answer to the other, the same reason
/// `AuthProvidersStore` is keyed that way.
struct LegacyClaimRecord {
    struct Key: Hashable {
        let server: URL
        let userId: Int

        var storageKey: String {
            "billing.legacyClaimed.\(server.host() ?? server.absoluteString).\(userId)"
        }
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func isClaimed(_ key: Key) -> Bool {
        defaults.bool(forKey: key.storageKey)
    }

    func markClaimed(_ key: Key) {
        defaults.set(true, forKey: key.storageKey)
    }
}
