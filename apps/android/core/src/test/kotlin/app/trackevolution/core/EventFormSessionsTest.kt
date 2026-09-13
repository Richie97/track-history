package app.trackevolution.core

import app.trackevolution.core.model.SessionDraft
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/**
 * The New Event form's posting rule, pinned to `public/js/event-form.js`
 * through `contracts/logic/event-form.json` — the same fixture the iOS Kit
 * asserts against, so the two ports are checked against the web rather than
 * against each other.
 */
class EventFormSessionsTest {

    private val fixture = Json.parseToJsonElement(
        RepoRoot.path("contracts/logic/event-form.json").readText(),
    ).jsonObject

    private fun draftsOf(array: kotlinx.serialization.json.JsonArray): List<SessionDraft> = array.map { el ->
        val o = el.jsonObject
        SessionDraft(
            label = o["label"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content,
            notes = o["notes"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content,
            laps = o["laps"]!!.jsonArray.map { it.jsonPrimitive.content.toInt() },
        )
    }

    @Test
    fun `sessionsToCreate matches the web implementation case for case`() {
        for (case in fixture["cases"]!!.jsonArray) {
            val c = case.jsonObject
            val hand = c["hand"]?.takeIf { it !is JsonNull }?.jsonObject
            val actual = EventFormSessions.sessionsToCreate(
                staged = draftsOf(c["staged"]!!.jsonArray),
                label = hand?.get("label")?.jsonPrimitive?.content,
                laps = hand?.get("laps")?.jsonPrimitive?.content,
                notes = hand?.get("notes")?.jsonPrimitive?.content,
            )
            assertEquals(draftsOf(c["expected"]!!.jsonArray), actual, c["name"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun `stagedSummary matches the web implementation`() {
        for (case in fixture["summaries"]!!.jsonArray) {
            val c = case.jsonObject
            val laps = c["laps"]!!.jsonArray.map { it.jsonPrimitive.content.toInt() }
            assertEquals(c["expected"]!!.jsonPrimitive.content, EventFormSessions.stagedSummary(laps))
        }
    }

    // ---- the JS test cases, ported --------------------------------------

    @Test
    fun `posts staged imports first, in order, then the hand-typed session`() {
        val a = SessionDraft(label = "PDR 09:15:00", laps = listOf(121240, 120100))
        val b = SessionDraft(label = "GoPro 10:30:00", laps = listOf(119900))
        val out = EventFormSessions.sessionsToCreate(listOf(a, b), " Day 1 — Session 2 ", "2:03.55\n2:01.24", "traffic")
        assertEquals(listOf("PDR 09:15:00", "GoPro 10:30:00", "Day 1 — Session 2"), out.map { it.label })
        assertEquals(SessionDraft(label = "Day 1 — Session 2", notes = "traffic", laps = listOf(123550, 121240)), out[2])
    }

    @Test
    fun `drops a hand entry with no parseable laps rather than posting an empty session`() {
        assertEquals(emptyList<SessionDraft>(), EventFormSessions.sessionsToCreate(emptyList(), "Morning", "", ""))
        assertEquals(emptyList<SessionDraft>(), EventFormSessions.sessionsToCreate(emptyList(), "", "nonsense", ""))
    }

    @Test
    fun `sends blank label and notes as null`() {
        val out = EventFormSessions.sessionsToCreate(emptyList(), "  ", "121.24", "  ")
        assertEquals(listOf(SessionDraft(label = null, notes = null, laps = listOf(121240))), out)
    }
}
