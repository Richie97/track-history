package app.trackevolution.core

import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.CatalogTrack
import app.trackevolution.core.model.CreatedId
import app.trackevolution.core.model.CreatedTrack
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.core.model.Me
import app.trackevolution.core.model.OkResponse
import app.trackevolution.core.model.PartRefresh
import app.trackevolution.core.model.ServerErrorBody
import app.trackevolution.core.model.SetupPrefill
import app.trackevolution.core.model.ShareData
import app.trackevolution.core.model.ShareSlug
import app.trackevolution.core.model.Track
import app.trackevolution.core.model.TrackSetupRow
import app.trackevolution.core.model.Vehicle
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.MethodSource

/**
 * Decodes every entry in `contracts/golden/manifest.json` into its model.
 *
 * This is the drift alarm: if the backend changes a field's name, type or
 * nullability, or adds an endpoint no model covers, these fail. Regenerate the
 * goldens with `npm run contracts:generate` and fix the models — never the other
 * way round. The iOS kit runs the identical suite (`GoldenContractTests`), which
 * is what keeps the two clients modelling the same server.
 */
class GoldenContractTest {

    companion object {
        @JvmStatic
        fun goldens(): List<Goldens.Entry> = Goldens.entries

        /**
         * Encoding for the round-trip half: defaults are written out so a field
         * the model has but the response doesn't shows up, and nulls are then
         * stripped from both trees before comparing.
         */
        private val roundTripJson = Json { encodeDefaults = true }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("goldens")
    fun goldenDecodesIntoItsModel(entry: Goldens.Entry) {
        // Failures are captured responses too: they map to an ApiException.
        if (entry.status >= 400) {
            val body = Goldens.bodyText(entry.name)
            val error = ApiException.from(entry.status, body)
            val sent = Goldens.decode(entry.name, ServerErrorBody.serializer())
            assertEquals(entry.status, error.status)
            assertEquals(sent.error, error.message, "the server's own message must survive")
            assertFalse(
                error.message.startsWith("Request failed"),
                "fell back instead of reading { error }",
            )
            assertEquals(entry.status == 401, error.isUnauthorized)
            return
        }

        when (entry.name) {
            "me", "me-checklist-template" -> roundTrip(entry.name, Me.serializer())
            "events-list" -> roundTrip(entry.name, ListSerializer(Event.serializer()))
            "event-detail", "event-detail-no-laps" ->
                roundTrip(entry.name, EventDetail.serializer())
            "event-setups-prefill" -> roundTrip(entry.name, SetupPrefill.serializer())
            "tracks-list" -> roundTrip(entry.name, ListSerializer(Track.serializer()))
            "track-setups" -> roundTrip(entry.name, ListSerializer(TrackSetupRow.serializer()))
            "catalog" -> roundTrip(entry.name, ListSerializer(CatalogTrack.serializer()))
            "vehicles-list" -> roundTrip(entry.name, ListSerializer(Vehicle.serializer()))
            "garage" -> roundTrip(entry.name, ListSerializer(GarageVehicle.serializer()))
            "share-public" -> roundTrip(entry.name, ShareData.serializer())
            "track-create" -> roundTrip(entry.name, CreatedTrack.serializer())
            "vehicle-create" -> roundTrip(entry.name, Vehicle.serializer())
            "part-refresh" -> roundTrip(entry.name, PartRefresh.serializer())
            "share-set" -> roundTrip(entry.name, ShareSlug.serializer())
            "event-create", "session-create", "part-create", "measurement-create" ->
                roundTrip(entry.name, CreatedId.serializer())
            "event-update", "session-update", "laps-append", "track-update", "vehicle-update",
            "part-update", "setup-upsert", "setup-delete", "lap-delete", "session-delete",
            "measurement-delete", "part-delete", "vehicle-delete", "event-delete", "share-clear",
            "checklist-template-set",
            -> roundTrip(entry.name, OkResponse.serializer())

            else -> throw AssertionError(
                "golden \"${entry.name}\" (${entry.method} ${entry.path}) has no model. " +
                    "Add one and map it here — an endpoint the clients can't decode is drift.",
            )
        }
    }

    /**
     * Decode, re-encode, and require the two JSON trees to match (ignoring
     * nulls, which mean the same as absent on both sides).
     */
    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class) // descriptor.serialName
    private fun <T> roundTrip(name: String, serializer: KSerializer<T>) {
        val model = Goldens.decode(name, serializer)
        val reencoded = roundTripJson.encodeToJsonElement(serializer, model)
        val difference = JsonShape.difference(
            JsonShape.normalize(Goldens.body(name)),
            JsonShape.normalize(reencoded),
        )
        assertNull(
            difference,
            "$name does not round-trip through ${serializer.descriptor.serialName} — " +
                "the model has drifted from the server: $difference",
        )
    }

    /**
     * The optionality cases NS-05 calls out by name. These are the ones that
     * silently become `0` in a careless port, and a zero consistency reads as a
     * metronome-perfect driver rather than "not enough laps to say".
     */
    @Test
    fun `computed stats are null rather than zero when the server says so`() {
        val detail = Goldens.decode("event-detail-no-laps", EventDetail.serializer())
        assertNull(detail.event.bestMs, "best_ms must be null with no laps and no manual best")
        assertNull(detail.event.consistency, "consistency must be null below 3 laps")
        assertEquals(0, detail.event.lapCount)
        assertTrue(detail.event.hours > 0, "hours is never null and defaults to days × 2h")
    }

    /** `days` is `REAL` in SQLite — a half-day event is 0.5, not 0. */
    @Test
    fun `event days survive as a fraction`() {
        val events = Goldens.decode("events-list", ListSerializer(Event.serializer()))
        assertTrue(events.isNotEmpty())
        assertTrue(events.all { it.days > 0 })
    }

    /** `is_default` is SQLite's 0/1, and must come back as the integer it went out as. */
    @Test
    fun `vehicle is_default round-trips through Boolean`() {
        val vehicles = Goldens.decode("vehicles-list", ListSerializer(Vehicle.serializer()))
        assertTrue(vehicles.any { it.isDefault }, "the fixture has a default vehicle")
        val reencoded = roundTripJson.encodeToJsonElement(
            ListSerializer(Vehicle.serializer()),
            vehicles,
        )
        assertNull(
            JsonShape.difference(
                JsonShape.normalize(Goldens.body("vehicles-list")),
                JsonShape.normalize(reencoded),
            ),
        )
    }

    /**
     * Strictness is the whole point of the harness: a field the server starts
     * sending must fail a decode rather than vanish.
     */
    @Test
    fun `an unmodelled field fails the decode`() {
        val body = Goldens.body("me").toString().replaceFirst("{", """{"surprise":1,""")
        val failure = runCatching { Goldens.strict.decodeFromString(Me.serializer(), body) }
        assertTrue(failure.isFailure, "ignoreUnknownKeys must stay off — this is the drift alarm")
    }
}
