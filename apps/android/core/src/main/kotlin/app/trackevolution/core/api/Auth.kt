package app.trackevolution.core.api

import kotlinx.serialization.Serializable

/**
 * Which sign-in providers a server offers (`GET /auth/providers`).
 *
 * Apple is only advertised when that deployment carries the `APPLE_*` secrets,
 * so the button is driven by this and never hardcoded visible.
 */
@Serializable
public data class AuthProviders(
    val google: Boolean,
    val apple: Boolean,
) {
    public companion object {
        /** Google is always on (`src/routes/auth.ts`); Apple has to be earned. */
        public val FALLBACK: AuthProviders = AuthProviders(google = true, apple = false)
    }
}

/** The identity providers the app can start a flow with. */
public enum class AuthProvider(
    /** The login path to open in the system browser. */
    public val loginPath: String,
) {
    GOOGLE("/auth/login"),
    APPLE("/auth/apple/login"),
    ;

    /** Stable across renames — this is written to disk mid-flow. */
    public val stored: String get() = name.lowercase()

    public companion object {
        public fun fromStored(value: String?): AuthProvider? =
            entries.firstOrNull { it.stored == value }
    }
}

/** `POST /auth/exchange` — the bearer token. */
@Serializable
internal data class AuthTokenResponse(val token: String)

/** `POST /auth/exchange` request body. Snake case is the server's field name. */
@Serializable
internal data class ExchangeBody(
    val code: String,
    val code_verifier: String,
)
