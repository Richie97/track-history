import CryptoKit
import Foundation

/// A PKCE verifier/challenge pair for the native sign-in flow.
///
/// The server's contract (`src/routes/auth.ts`, and the failure modes in
/// `test/api/native-auth.test.ts`) is unforgiving in three ways worth stating
/// here, because each one produces a confusing error rather than an obvious one:
///
/// - The challenge is `base64url(SHA-256(verifier))` **without padding**. Get the
///   encoding wrong and the exchange fails with `401 PKCE verification failed`.
/// - The one-time code the browser redirects back with lives for **60 seconds**.
///   Exchange it immediately; don't stash it.
/// - That code is **burned on first use, before verification**, so a failed
///   exchange can't be retried with the same code — recover by restarting the
///   whole flow with a fresh verifier.
public struct PKCE: Hashable, Sendable {
    /// 43 characters from the unreserved set — the RFC 7636 minimum, from 32
    /// bytes of `SystemRandomNumberGenerator` entropy.
    public let verifier: String

    public init() {
        var bytes = [UInt8](repeating: 0, count: 32)
        var generator = SystemRandomNumberGenerator()
        for i in bytes.indices { bytes[i] = generator.next() }
        verifier = Data(bytes).base64URLEncodedString()
    }

    /// For tests and for the RFC's worked example.
    public init(verifier: String) {
        self.verifier = verifier
    }

    /// `base64url(SHA-256(verifier))`, unpadded.
    public var challenge: String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
    }
}

extension Data {
    /// base64url without padding — what OAuth wants everywhere.
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
