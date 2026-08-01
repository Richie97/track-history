package app.trackevolution.core.offline

import app.trackevolution.core.api.ApiClient
import kotlinx.serialization.json.Json

/**
 * The two JSON configurations the offline layer reads and writes cached bodies
 * with.
 *
 * Unlike the web mirror, which surgically edits plain JSON, the patches here
 * decode into the typed models and re-encode. That is only safe because
 * `GoldenContractTest` proves those models round-trip losslessly against the real
 * API responses — a field this layer didn't model would otherwise be silently
 * dropped on every patch. [encode] is deliberately configured the same way that
 * test's round-trip encoder is, so the thing it proves is the thing that runs.
 */
internal object OfflineJson {
    /** A cached body is a server response; decode it exactly as a live one is. */
    val decode: Json = ApiClient.responseJson

    /**
     * `encodeDefaults = true`: a cached body carries every field, so a value that
     * happens to equal a model default still survives a round trip through the
     * cache. Nulls are written for the same reason (`explicitNulls` defaults on).
     */
    val encode: Json = Json { encodeDefaults = true }
}
