package app.trackevolution.core.api

/**
 * Source of the bearer token [ApiClient] sends. Defined here, **implemented in
 * NS-09** — `:core` is Android-free by construction and must never reach into
 * the keystore or EncryptedSharedPreferences itself.
 */
public fun interface TokenProvider {
    /** The current token, or null when signed out. */
    public suspend fun currentToken(): String?
}

/**
 * Signed out: no `Authorization` header. The client's default, and what the
 * public share endpoint needs.
 */
public object NoToken : TokenProvider {
    override suspend fun currentToken(): String? = null
}

/** A fixed token — for tests, previews, and the dev bypass. */
public class StaticToken(private val token: String) : TokenProvider {
    override suspend fun currentToken(): String = token
}
