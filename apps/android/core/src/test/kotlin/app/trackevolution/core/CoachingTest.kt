package app.trackevolution.core

import app.trackevolution.core.model.DriverProfile
import app.trackevolution.core.model.Student
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Share with a coach (NS-38): the grant's wording (`Coaching`) and the driver
 * profile (`Profile`), and their agreement with the web app.
 *
 * Carries the JS cases from `test/unit/coaching-client.test.js` and asserts
 * equality with `contracts/logic/coaching.json`, which `npm run contracts:logic`
 * generates from `public/js/profile.js` and `public/js/coaching.js` — the same
 * fixture the iOS Kit asserts against.
 */
class CoachingTest {

    private val hour = 3_600_000L
    private val day = 24 * hour
    private val now = 1_790_683_200_000L

    private fun student(count: Int, last: String?) =
        Student(id = 1, since = 0, eventCount = count, lastEventDate = last)

    // ---- The JS cases --------------------------------------------------------

    @Test
    fun `profileBody turns blanks into null, the year into a number and yes-no into booleans`() {
        val body = Profile.profileBody(
            mapOf(
                "occupation" to "  Pilot ", "first_track_year" to "2019", "helmet_rating" to "",
                "gloves" to "yes", "shoes" to "no", "goals" to "",
            ),
        )
        assertEquals("Pilot", body.occupation)
        assertEquals(2019, body.firstTrackYear)
        assertNull(body.helmetRating)
        assertEquals(true, body.gloves)
        assertEquals(false, body.shoes)
        assertNull(body.goals)
        assertNull(body.experience)
    }

    @Test
    fun `profileBody leaves an unanswered yes-no unanswered`() {
        assertNull(Profile.profileBody(mapOf("gloves" to "")).gloves)
        assertNull(Profile.profileBody(emptyMap()).shoes)
    }

    @Test
    fun `profileSections says nothing for no profile`() {
        assertEquals(emptyList<Profile.Section>(), Profile.profileSections(null))
        assertEquals(emptyList<Profile.Section>(), Profile.profileSections(DriverProfile()))
    }

    @Test
    fun `profileSections keeps only the groups and rows with something to say, in form order`() {
        val out = Profile.profileSections(
            DriverProfile(goals = "Trail braking", helmetRating = "SA2020", gloves = false, occupation = " "),
        )
        assertEquals(
            listOf(
                Profile.Section(
                    "Safety gear",
                    listOf(
                        Profile.Row("helmet_rating", "Helmet rating", "Snell SA2020"),
                        Profile.Row("gloves", "Driving gloves", "No"),
                    ),
                ),
                Profile.Section("Coaching", listOf(Profile.Row("goals", "What I want to work on", "Trail braking"))),
            ),
            out,
        )
    }

    @Test
    fun `formValues round-trips through profileBody`() {
        val stored = DriverProfile(occupation = "Engineer", firstTrackYear = 2019, gloves = false, headNeck = "hans")
        assertEquals(stored, Profile.profileBody(Profile.formValues(stored)))
        assertEquals("", Profile.formValues(null)["shoes"])
    }

    @Test
    fun `studentLine counts events and says when they were last out`() {
        val iso = { d: String -> d }
        assertEquals("No track days yet", Coaching.studentLine(student(0, null), iso))
        assertEquals("1 event · last out 2026-04-10", Coaching.studentLine(student(1, "2026-04-10"), iso))
        assertEquals("12 events · last out 2026-04-10", Coaching.studentLine(student(12, "2026-04-10"), iso))
    }

    @Test
    fun `lastViewedText steps from hours to days to weeks`() {
        assertEquals("hasn't looked yet", Coaching.lastViewedText(null, now))
        assertEquals("viewed in the last hour", Coaching.lastViewedText(now - 10 * 60_000, now))
        assertEquals("viewed 1 hour ago", Coaching.lastViewedText(now - hour, now))
        assertEquals("viewed 23 hours ago", Coaching.lastViewedText(now - (23.9 * hour).toLong(), now))
        assertEquals("viewed 1 day ago", Coaching.lastViewedText(now - day, now))
        assertEquals("viewed 13 days ago", Coaching.lastViewedText(now - (13.9 * day).toLong(), now))
        assertEquals("viewed 2 weeks ago", Coaching.lastViewedText(now - 14 * day, now))
        assertEquals("not viewed for over two months", Coaching.lastViewedText(now - 60 * day, now))
        // A clock a little behind the server's never reads as the future.
        assertEquals("viewed in the last hour", Coaching.lastViewedText(now + 5_000, now))
    }

    @Test
    fun `inviteExpiryText rounds days so a fresh link reads seven`() {
        assertEquals("expires in 7 days", Coaching.inviteExpiryText(now + 7 * day - 1_000, now))
        assertEquals("expires in 2 days", Coaching.inviteExpiryText(now + 36 * hour, now))
        assertEquals("expires in 1 day", Coaching.inviteExpiryText(now + 25 * hour, now))
        assertEquals("expires in 23 hours", Coaching.inviteExpiryText(now + (23.5 * hour).toLong(), now))
        assertEquals("expires in 1 hour", Coaching.inviteExpiryText(now + hour, now))
        assertEquals("expires within the hour", Coaching.inviteExpiryText(now + 59 * 60_000, now))
        assertEquals("expired", Coaching.inviteExpiryText(now, now))
    }

    // ---- The cross-language pin -----------------------------------------------

    private val fixture: JsonObject =
        Json.parseToJsonElement(RepoRoot.path("contracts/logic/coaching.json").readText()).jsonObject

    private val lenient = Json { ignoreUnknownKeys = true }

    @Test
    fun `the field spec matches the web's`() {
        val groups = fixture.getValue("groups").jsonArray
        assertEquals(groups.size, Profile.PROFILE_GROUPS.size)
        groups.zip(Profile.PROFILE_GROUPS).forEach { (json, group) ->
            val g = json.jsonObject
            assertEquals(g.getValue("title").jsonPrimitive.content, group.title)
            val fields = g.getValue("fields").jsonArray
            assertEquals(fields.size, group.fields.size, group.title)
            fields.zip(group.fields).forEach { (fj, field) ->
                val f = fj.jsonObject
                assertEquals(f.getValue("key").jsonPrimitive.content, field.key)
                assertEquals(f.getValue("label").jsonPrimitive.content, field.label, field.key)
                assertEquals(f.getValue("kind").jsonPrimitive.content, field.kind.wire, field.key)
                assertEquals(f["max"]?.jsonPrimitive?.intOrNull, field.max, field.key)
                assertEquals(f["placeholder"]?.jsonPrimitive?.contentOrNull, field.placeholder, field.key)
                val options = f["options"]?.jsonArray?.map {
                    it.jsonArray[0].jsonPrimitive.content to it.jsonArray[1].jsonPrimitive.content
                }
                assertEquals(options, field.options, field.key)
            }
        }
    }

    @Test
    fun `profileSections matches the web's, row for row`() {
        val cases = fixture.getValue("sections").jsonArray
        assertTrue(cases.size >= 5)
        for (case in cases) {
            val c = case.jsonObject
            val raw = c.getValue("profile")
            val profile = if (raw is JsonNull) null else lenient.decodeFromJsonElement(DriverProfile.serializer(), raw)
            val expected = c.getValue("sections").jsonArray.map { s ->
                val so = s.jsonObject
                Profile.Section(
                    so.getValue("title").jsonPrimitive.content,
                    so.getValue("rows").jsonArray.map { r ->
                        val ro = r.jsonObject
                        Profile.Row(
                            ro.getValue("key").jsonPrimitive.content,
                            ro.getValue("label").jsonPrimitive.content,
                            ro.getValue("value").jsonPrimitive.content,
                        )
                    },
                )
            }
            assertEquals(expected, Profile.profileSections(profile), raw.toString())
        }
    }

    @Test
    fun `profileBody matches the web's, key for key`() {
        for (case in fixture.getValue("bodies").jsonArray) {
            val c = case.jsonObject
            val values = c.getValue("values").jsonObject.mapValues { (_, v) ->
                val p = v.jsonPrimitive
                if (p.isString) p.content else p.booleanOrNull
            }
            val body = c.getValue("body").jsonObject
            // Every key the web sends is one the port models, and nothing else.
            assertEquals(body.keys, Profile.PROFILE_FIELDS.map { it.key }.toSet())
            val expected = lenient.decodeFromJsonElement(DriverProfile.serializer(), body)
            assertEquals(expected, Profile.profileBody(values), values.toString())
        }
    }

    @Test
    fun `the grant's wording matches the web's`() {
        val fixtureNow = fixture.getValue("now").jsonPrimitive.long
        for (case in fixture.getValue("studentLines").jsonArray) {
            val c = case.jsonObject
            val s = c.getValue("student").jsonObject
            val row = student(s.getValue("event_count").jsonPrimitive.int, s.getValue("last_event_date").jsonPrimitive.contentOrNull)
            assertEquals(c.getValue("line").jsonPrimitive.content, Coaching.studentLine(row) { it })
        }
        for (case in fixture.getValue("lastViewed").jsonArray) {
            val c = case.jsonObject
            val at = c.getValue("last_viewed_at").jsonPrimitive.longOrNull
            assertEquals(c.getValue("text").jsonPrimitive.content, Coaching.lastViewedText(at, fixtureNow), "$at")
        }
        for (case in fixture.getValue("inviteExpiry").jsonArray) {
            val c = case.jsonObject
            val at = c.getValue("expires_at").jsonPrimitive.long
            assertEquals(c.getValue("text").jsonPrimitive.content, Coaching.inviteExpiryText(at, fixtureNow), "$at")
        }
    }
}
