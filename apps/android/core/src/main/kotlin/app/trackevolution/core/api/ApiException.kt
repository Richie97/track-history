package app.trackevolution.core.api

import app.trackevolution.core.model.ServerErrorBody
import kotlinx.serialization.json.Json

/**
 * Everything that can go wrong talking to the API. Mirrors `ApiError` in
 * `public/js/api.js` and `APIError` in the iOS kit: the server sends
 * `{ "error": string }` with a meaningful status, and **that string is what the
 * UI shows** — never replace it with a generic message of our own.
 *
 * Sealed rather than one class with a status code, so `401` is distinguishable
 * by type at the catch site and the app can drop straight to re-auth.
 */
public sealed class ApiException(
    /** The HTTP status, or null when the request never got an answer. */
    public val status: Int?,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause) {

    /** The message to show the user. Never null — that is the point of this type. */
    override val message: String get() = super.message!!

    /** 401. Distinct so the app can drop straight to re-auth. */
    public class Unauthorized(message: String) : ApiException(401, message)

    /** Any other non-2xx, carrying the server's status and message. */
    public class Server(status: Int, message: String) : ApiException(status, message)

    /**
     * No answer at all — offline, DNS, timeout. Not the server's fault, and
     * (unlike the cases above) worth retrying.
     */
    public class Transport(message: String, cause: Throwable? = null) :
        ApiException(null, message, cause)

    /** A 2xx body that didn't match its model: contract drift, or a bug here. */
    public class Decoding(message: String, cause: Throwable? = null) :
        ApiException(null, message, cause)

    public val isUnauthorized: Boolean get() = this is Unauthorized

    public companion object {
        /**
         * Maps a non-2xx response to an exception, preferring the server's own
         * message and falling back to `Request failed (<status>)` exactly like
         * the web client does when the body isn't the expected shape.
         */
        public fun from(status: Int, body: String): ApiException {
            val message = runCatching {
                LENIENT.decodeFromString(ServerErrorBody.serializer(), body).error
            }.getOrNull() ?: "Request failed ($status)"
            return if (status == 401) Unauthorized(message) else Server(status, message)
        }

        /** Error bodies are parsed leniently: a truncated one must still yield a status. */
        private val LENIENT = Json { ignoreUnknownKeys = true }
    }
}
