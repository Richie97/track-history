package app.trackevolution.core

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Access to `contracts/golden/` — the pinned API contract, captured from a real
 * D1-backed Worker by `npm run contracts:generate`.
 */
object Goldens {
    private val directory = RepoRoot.path("contracts/golden")

    /** One captured response, as listed in the manifest. */
    @Serializable
    data class Entry(
        val name: String,
        val file: String,
        val method: String,
        val path: String,
        val status: Int,
        /** The manifest's human note about what the fixture covers. */
        val description: String,
        val source: String,
    ) {
        // Shown by JUnit as the parameterized case name.
        override fun toString(): String = "$name ($method $path → $status)"
    }

    @Serializable
    private data class Manifest(val entries: List<Entry>)

    /** The capture envelope: method, path, status, then the body a client sees. */
    @Serializable
    private data class Capture(
        val status: Int,
        val body: JsonElement,
        @SerialName("method") val method: String? = null,
    )

    private val lenient = Json { ignoreUnknownKeys = true }

    val entries: List<Entry> = lenient.decodeFromString(
        Manifest.serializer(),
        directory.resolve("manifest.json").readText(),
    ).entries

    fun entry(name: String): Entry =
        entries.firstOrNull { it.name == name }
            ?: error("no golden named $name — check contracts/golden/manifest.json")

    /** The raw JSON of a capture's `body`, which is what a client would receive. */
    fun body(name: String): JsonElement =
        lenient.decodeFromString(Capture.serializer(), directory.resolve(entry(name).file).readText()).body

    fun bodyText(name: String): String = body(name).toString()

    fun <T> decode(name: String, deserializer: DeserializationStrategy<T>): T =
        strict.decodeFromString(deserializer, bodyText(name))

    /**
     * The same configuration [app.trackevolution.core.api.ApiClient] decodes
     * responses with: unknown keys are an error, so a field the server adds and
     * we don't model fails here first.
     */
    val strict: Json = Json { ignoreUnknownKeys = false; isLenient = false }
}

/**
 * Comparing two decoded-JSON trees, for the round-trip half of the contract
 * test: decode a golden into a model, re-encode it, and require the result to
 * match. That is what proves the model is *complete* — a field the server sends
 * and we don't model shows up as a missing key rather than a dropped value.
 */
object JsonShape {
    /**
     * Drops nulls recursively. The request/response encoders omit absent
     * optionals where the server sends explicit nulls; both mean "absent".
     */
    fun normalize(value: JsonElement): JsonElement = when (value) {
        is JsonObject -> JsonObject(
            value.filterValues { it !is JsonNull }.mapValues { (_, v) -> normalize(v) },
        )
        is JsonArray -> JsonArray(value.map { normalize(it) })
        else -> value
    }

    /**
     * Where the two trees first diverge, phrased as something actionable, or
     * null when they agree.
     */
    fun difference(want: JsonElement, got: JsonElement, path: String = ""): String? {
        if (want is JsonObject && got is JsonObject) {
            want.keys.minus(got.keys).minOrNull()?.let {
                return "$path.$it is in the response but not in the model"
            }
            got.keys.minus(want.keys).minOrNull()?.let {
                return "$path.$it is in the model but not in the response"
            }
            for (key in want.keys.sorted()) {
                difference(want.getValue(key), got.getValue(key), "$path.$key")?.let { return it }
            }
            return null
        }
        if (want is JsonArray && got is JsonArray) {
            if (want.size != got.size) {
                return "$path has ${want.size} items, model produced ${got.size}"
            }
            for (i in want.indices) {
                difference(want[i], got[i], "$path[$i]")?.let { return it }
            }
            return null
        }
        if (want is JsonPrimitive && got is JsonPrimitive && !want.isString && !got.isString) {
            val a = want.doubleOrNull
            val b = got.doubleOrNull
            if (a != null && b != null) {
                // Two number formatters can land a last digit apart on a value
                // like a 17-significant-digit coefficient of variation. That is
                // not drift.
                val tolerance = 1e-12 * maxOf(1.0, Math.abs(a))
                return if (Math.abs(a - b) <= tolerance) null else "$path: response $a vs model $b"
            }
        }
        return if (want == got) null else "$path: response $want vs model $got"
    }
}
