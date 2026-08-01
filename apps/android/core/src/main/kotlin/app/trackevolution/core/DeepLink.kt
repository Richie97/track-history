package app.trackevolution.core

import java.net.URI
import java.net.URLDecoder

/**
 * A link from outside the app, resolved to a place inside it.
 *
 * Two sources, and only two:
 *
 *  - **App Links** for `https://<host>/share/<slug>`, which is the only pattern
 *    `public/.well-known/assetlinks.json` and the manifest advertise. Those URLs
 *    may carry the web app's own hash route (`/share/eric#/track/7`).
 *  - The `trackevolution://` custom scheme. `trackevolution://auth?code=…` is
 *    **not** a route: it is the OAuth redirect, consumed by the sign-in flow.
 *    Parsing it as navigation would race that flow for a code that is burned on
 *    first use, so it is rejected here explicitly rather than by accident.
 *
 * A direct port of the iOS `DeepLink`, same cases and same rules, so the two
 * routing tables diff by eye. Pure, so the table is unit-tested rather than
 * tapped through.
 */
public sealed interface DeepLink {
    public data object Dashboard : DeepLink
    public data class Event(val id: Int) : DeepLink
    public data class EditEvent(val id: Int) : DeepLink
    public data class NewEvent(val presetTrack: String?) : DeepLink
    public data class Track(val id: Int) : DeepLink

    /**
     * A car's garage page. The garage is deferred on Android, so nothing links
     * here yet — but the web app does, and a link that resolved to nothing would
     * open a blank app. NS-26 decides what it shows.
     */
    public data class Vehicle(val id: Int) : DeepLink
    public data object Settings : DeepLink

    /** Someone's public logbook — including your own, when you tap your own link. */
    public data class Shared(val slug: String) : DeepLink

    public companion object {
        /** The app's custom scheme, registered in the manifest. */
        public const val CALLBACK_SCHEME: String = "trackevolution"

        /** The scheme's reserved host: the sign-in redirect, never a destination. */
        private const val AUTH_HOST = "auth"

        public fun parse(url: String): DeepLink? {
            val uri = runCatching { URI(url) }.getOrNull() ?: return null

            if (uri.scheme == CALLBACK_SCHEME) {
                if (uri.host == AUTH_HOST) return null
                // trackevolution://event/5 — nothing generates these today, but
                // the scheme is registered, so they resolve rather than opening
                // a blank app.
                val segments = listOfNotNull(uri.host) + pathSegments(uri.rawPath)
                return route(segments) ?: hashRoute(uri.rawFragment) ?: Dashboard
            }

            if (uri.scheme != "https" && uri.scheme != "http") return null
            val segments = pathSegments(uri.rawPath)
            // /share/<slug>, with anything deeper (the web app's hash routes live
            // in the fragment, not the path) resolving to the logbook's root.
            if (segments.firstOrNull() == "share" && segments.size >= 2 && segments[1].isNotEmpty()) {
                return Shared(segments[1])
            }
            // The app's own web URLs: https://host/#/event/5.
            return hashRoute(uri.rawFragment) ?: Dashboard
        }

        /** `#/event/5` → `Event(5)`. The web app's hash router, read from outside. */
        internal fun hashRoute(fragment: String?): DeepLink? {
            if (fragment.isNullOrEmpty()) return null
            val rest = fragment.removePrefix("#")
            val mark = rest.indexOf('?')
            val path = if (mark < 0) rest else rest.substring(0, mark)
            val query = if (mark < 0) emptyMap() else parseQuery(rest.substring(mark + 1))
            return route(pathSegments(path), query)
        }

        private fun route(segments: List<String>, query: Map<String, String> = emptyMap()): DeepLink? =
            when (segments.firstOrNull()) {
                null, "" -> if (segments.isEmpty()) null else Dashboard
                "event" -> segments.intAt(1)?.let { id ->
                    // /event/5/record is NS-18's screen, reachable only from
                    // inside the app: a link that started a GPS recording from
                    // outside would be a surprise.
                    if (segments.size >= 3 && segments[2] == "edit") EditEvent(id) else Event(id)
                }
                "track" -> segments.intAt(1)?.let { Track(it) }
                "vehicle" -> segments.intAt(1)?.let { Vehicle(it) }
                "new" -> NewEvent(query["track"])
                "settings" -> Settings
                else -> null
            }

        private fun List<String>.intAt(index: Int): Int? =
            if (size >= index + 1) this[index].toIntOrNull() else null

        private fun pathSegments(path: String?): List<String> =
            (path ?: "").split('/').filter { it.isNotEmpty() }.map { decode(it) }

        /** A hash route's own query string — `#/new?track=VIR%20(Full)`. */
        private fun parseQuery(raw: String): Map<String, String> = buildMap {
            for (pair in raw.split('&')) {
                if (pair.isEmpty()) continue
                val mark = pair.indexOf('=')
                val name = if (mark < 0) pair else pair.substring(0, mark)
                val value = if (mark < 0) "" else pair.substring(mark + 1)
                // Only a *query* value spells a space as `+`; in a path it is a
                // literal plus, which is why the two decode differently.
                put(name, decode(value.replace('+', ' ')))
            }
        }

        /**
         * A track name arrives percent-encoded in `#/new?track=…`; so can a slug.
         *
         * `URLDecoder` is form decoding, which turns `+` into a space — wrong for
         * a path segment. Escaping any `+` first makes this plain percent-decoding,
         * matching iOS's `removingPercentEncoding`.
         */
        private fun decode(value: String): String =
            runCatching { URLDecoder.decode(value.replace("+", "%2B"), "UTF-8") }
                .getOrDefault(value)
    }
}
