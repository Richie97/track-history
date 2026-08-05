package app.trackevolution.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.LocalDate

/**
 * The event-attachment rule, and its agreement with the web app and iOS.
 *
 * `contracts/logic/remote-attach.json` is `pickRecordingEvent` in
 * `public/js/record/remote.js` run over a set of hand-built cases, and it is the
 * same file `RemoteRecordingTests.swift` asserts against — so both ports are
 * checked against the reference rather than against each other.
 *
 * This is worth pinning rather than eyeballing because every failure mode is
 * quiet. A rule that is a day out at a month boundary, or that truncates
 * fractional days differently from the JS, still attaches a recording to *an*
 * event; you find out when a session shows up in the wrong weekend.
 */
class RemoteRecordingTest {

    private data class Candidate(
        val id: String,
        override val startDate: String,
        override val days: Double,
    ) : RemoteRecording.EventCandidate

    private val fixture = Json.parseToJsonElement(
        RepoRoot.path("contracts/logic/remote-attach.json").readText(),
    ).jsonObject

    private val sets: Map<String, List<Candidate>> = fixture["events"]!!.jsonObject
        .mapValues { (_, value) ->
            value.jsonArray.map { element ->
                val event = element.jsonObject
                Candidate(
                    id = event["id"]!!.jsonPrimitive.content,
                    startDate = event["start_date"]!!.jsonPrimitive.content,
                    // Absent in the `missingDays` set on purpose: `Number(undefined)
                    // || 1` is 1 in the JS, and the fixture exists to pin that.
                    days = event["days"]?.jsonPrimitive?.double ?: 1.0,
                )
            }
        }

    @Test
    fun `matches the JavaScript implementation case for case`() {
        val cases = fixture["cases"]!!.jsonArray
        for (element in cases) {
            val case = element.jsonObject
            val name = case["events"]!!.jsonPrimitive.content
            val todayIso = case["todayIso"]!!.jsonPrimitive.content
            val expected = case["expectedId"]!!.let {
                if (it is kotlinx.serialization.json.JsonNull) null else it.jsonPrimitive.content
            }

            val picked = RemoteRecording.pickRecordingEvent(sets[name], todayIso)
            assertEquals(expected, picked?.id, "$name on $todayIso")
        }
        // A guard against the fixture silently emptying out and the loop above
        // passing vacuously.
        assertTrue(cases.size >= 20, "fixture shrank to ${cases.size} cases")
    }

    // ---- The rule's own claims ---------------------------------------------

    @Test
    fun `attaches to the event covering today`() {
        val events = listOf(Candidate("weekend", "2026-07-19", 3.0))
        assertEquals("weekend", RemoteRecording.pickRecordingEvent(events, "2026-07-21")?.id)
        assertNull(RemoteRecording.pickRecordingEvent(events, "2026-07-22"))
    }

    @Test
    fun `overlapping events tie-break to the most recently started`() {
        // The specific day inside a longer entry is almost always the one meant.
        val events = listOf(
            Candidate("long", "2026-07-18", 7.0),
            Candidate("today", "2026-07-21", 1.0),
        )
        assertEquals("today", RemoteRecording.pickRecordingEvent(events, "2026-07-21")?.id)
    }

    @Test
    fun `never guesses beyond today`() {
        // A gap either side: recording unattached is the correct answer, and the
        // whole point of the rule. Adding a "nearest event" heuristic here would
        // file a session into the wrong weekend.
        val events = listOf(
            Candidate("before", "2026-07-20", 1.0),
            Candidate("after", "2026-07-22", 1.0),
        )
        assertNull(RemoteRecording.pickRecordingEvent(events, "2026-07-21"))
    }

    @Test
    fun `survives a DST transition in both directions`() {
        // The arithmetic is date-only, so the hour lost in March and the one
        // repeated in November change nothing: a two-day event still covers two
        // calendar days.
        val spring = listOf(Candidate("s", "2026-03-07", 2.0))
        assertEquals("s", RemoteRecording.pickRecordingEvent(spring, "2026-03-08")?.id)
        assertNull(RemoteRecording.pickRecordingEvent(spring, "2026-03-09"))

        val fall = listOf(Candidate("f", "2026-10-31", 2.0))
        assertEquals("f", RemoteRecording.pickRecordingEvent(fall, "2026-11-01")?.id)
        assertNull(RemoteRecording.pickRecordingEvent(fall, "2026-11-02"))
    }

    @Test
    fun `crosses month and year boundaries`() {
        assertEquals(
            "m",
            RemoteRecording.pickRecordingEvent(listOf(Candidate("m", "2026-07-31", 2.0)), "2026-08-01")?.id,
        )
        assertEquals(
            "y",
            RemoteRecording.pickRecordingEvent(listOf(Candidate("y", "2026-12-31", 2.0)), "2027-01-01")?.id,
        )
    }

    @Test
    fun `fractional days truncate, matching the reference`() {
        // Not an improvement to make unilaterally: the JS floors, and the three
        // clients have to agree on which event a car-started recording lands in.
        val half = listOf(Candidate("h", "2026-07-19", 1.5))
        assertEquals("h", RemoteRecording.pickRecordingEvent(half, "2026-07-19")?.id)
        assertNull(RemoteRecording.pickRecordingEvent(half, "2026-07-20"))
    }

    @Test
    fun `a nonsensical day count still covers its start date`() {
        for (days in listOf(0.0, -3.0, Double.NaN)) {
            val events = listOf(Candidate("x", "2026-07-21", days))
            assertEquals("x", RemoteRecording.pickRecordingEvent(events, "2026-07-21")?.id, "days=$days")
            assertNull(RemoteRecording.pickRecordingEvent(events, "2026-07-22"), "days=$days")
        }
    }

    @Test
    fun `a malformed date drops one event rather than the pick`() {
        val events = listOf(
            Candidate("bad", "not-a-date", 1.0),
            Candidate("good", "2026-07-21", 1.0),
        )
        assertEquals("good", RemoteRecording.pickRecordingEvent(events, "2026-07-21")?.id)
    }

    @Test
    fun `no events at all is unattached rather than an exception`() {
        assertNull(RemoteRecording.pickRecordingEvent<Candidate>(null, "2026-07-21"))
        assertNull(RemoteRecording.pickRecordingEvent(emptyList<Candidate>(), "2026-07-21"))
    }

    // ---- Today --------------------------------------------------------------

    @Test
    fun `today is the phone's local calendar date`() {
        // Track time is phone time: an evening session in New York is still
        // today's event after UTC has rolled over.
        assertEquals("2026-07-21", RemoteRecording.localTodayIso(LocalDate.of(2026, 7, 21)))
    }
}
