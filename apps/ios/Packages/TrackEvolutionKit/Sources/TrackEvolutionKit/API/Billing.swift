import Foundation

/// The request bodies behind `APIClient`'s `/billing` methods (NS-32). Plain
/// strings on purpose: StoreKit's `jwsRepresentation` is already the compact
/// JWS the Worker verifies, so the Kit never needs the framework — the app hands
/// the strings across and `swift test` keeps running on macOS.

/// `POST /api/billing/apple` — one verified transaction, plus the subscription's
/// renewal info when StoreKit had it (`Transaction.subscriptionStatus`). The
/// renewal JWS is what lets the server record `auto_renew` and the grace state
/// without waiting for a notification; absent is fine, and the key is omitted
/// rather than nulled.
struct AppleTransactionBody: Encodable {
    var jws: String
    var renewalJws: String?

    enum CodingKeys: String, CodingKey {
        case jws
        case renewalJws = "renewal_jws"
    }
}

/// `POST /api/billing/apple/legacy` — the `AppTransaction` JWS, which carries
/// `originalApplicationVersion` and so proves the app was bought before it went
/// free (requirement 6).
struct AppleLegacyBody: Encodable {
    var jws: String
}
