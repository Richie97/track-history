import Foundation
import OSLog
import Security
import TrackEvolutionKit

/// The bearer token, in the Keychain. `APIClient` asks this for a token and stays
/// ignorant of where it lives.
///
/// Two deliberate choices:
///
/// - **`kSecAttrAccessibleAfterFirstUnlock`**, not `WhenUnlocked`: the lap
///   recorder runs with the phone locked in a pocket, and a saved session has to
///   be able to reach the server from there.
/// - **Not `...ThisDeviceOnly`**, so the entry rides along in an encrypted iCloud
///   Keychain backup and a restored phone stays signed in. The token is a
///   revocable session, not a password — `POST /auth/logout` invalidates it
///   server-side — so the convenience is worth more than pinning it to one device.
///
/// The token is cached in memory after the first read: it's fetched on every
/// request, and the recorder makes a lot of them.
/// `@unchecked Sendable` because the lock is what makes it safe and the compiler
/// can't see that. `Mutex` would say it in the type system, but that's iOS 18 and
/// the deployment target is 17.
final class KeychainTokenStore: TokenProviding, @unchecked Sendable {
    private static let log = Logger(subsystem: "app.trackevolution", category: "auth")

    private let service: String
    private let account = "session"
    private let lock = NSLock()
    private var cached: String??

    init(service: String = "app.trackevolution.session") {
        self.service = service
    }

    // MARK: - TokenProviding

    func currentToken() async -> String? {
        lock.withLock {
            if let cached { return cached }
            let value = readFromKeychain()
            cached = value
            return value
        }
    }

    /// Synchronous read, for deciding at launch whether to show the sign-in screen.
    var token: String? {
        lock.withLock {
            if let cached { return cached }
            let value = readFromKeychain()
            cached = value
            return value
        }
    }

    var isSignedIn: Bool { token != nil }

    // MARK: - Mutation

    func save(_ token: String) {
        lock.withLock {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account
            ]
            SecItemDelete(query as CFDictionary)

            var attributes = query
            attributes[kSecValueData as String] = Data(token.utf8)
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let status = SecItemAdd(attributes as CFDictionary, nil)
            if status != errSecSuccess {
                Self.log.error("keychain write failed: \(status, privacy: .public)")
            }
            cached = .some(token)
        }
    }

    func clear() {
        lock.withLock {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account
            ]
            SecItemDelete(query as CFDictionary)
            cached = .some(nil)
        }
    }

    // MARK: - Private

    private func readFromKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            if status != errSecItemNotFound {
                Self.log.error("keychain read failed: \(status, privacy: .public)")
            }
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
}
