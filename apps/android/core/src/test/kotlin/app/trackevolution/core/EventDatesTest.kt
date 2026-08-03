package app.trackevolution.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.LocalDate

class EventDatesTest {

    private val today = LocalDate.of(2026, 5, 1)

    // ---- upcoming ----------------------------------------------------------

    @Test
    fun `an event later this month is upcoming`() {
        assertTrue(EventDates.isUpcoming("2026-05-10", today))
    }

    @Test
    fun `an event starting today is not upcoming`() {
        // It is happening, not approaching — the dashboard says "Today".
        assertFalse(EventDates.isUpcoming("2026-05-01", today))
    }

    @Test
    fun `a past event is not upcoming`() {
        assertFalse(EventDates.isUpcoming("2026-04-30", today))
    }

    @Test
    fun `a malformed date is not upcoming rather than an exception`() {
        assertFalse(EventDates.isUpcoming("not-a-date", today))
        assertNull(EventDates.daysUntil("not-a-date", today))
    }

    // ---- countdown ---------------------------------------------------------

    @Test
    fun `counts down in the web app's words`() {
        assertEquals("Today", EventDates.fmtCountdown("2026-05-01", today))
        assertEquals("Tomorrow", EventDates.fmtCountdown("2026-05-02", today))
        assertEquals("In 5 days", EventDates.fmtCountdown("2026-05-06", today))
    }

    @Test
    fun `an event already under way still reads as Today`() {
        assertEquals("Today", EventDates.fmtCountdown("2026-04-28", today))
    }

    @Test
    fun `a day is a day across a DST transition`() {
        // US DST springs forward on 2026-03-08. Calendar arithmetic must not
        // turn that into 23 hours and round to zero.
        val beforeDst = LocalDate.of(2026, 3, 7)
        assertEquals(1, EventDates.daysUntil("2026-03-08", beforeDst))
        assertEquals("Tomorrow", EventDates.fmtCountdown("2026-03-08", beforeDst))
    }

    @Test
    fun `counts across a year boundary`() {
        assertEquals(2, EventDates.daysUntil("2027-01-01", LocalDate.of(2026, 12, 30)))
    }

    // ---- formatting --------------------------------------------------------

    @Test
    fun `formats a date and an em dash for nothing`() {
        assertTrue(EventDates.fmtDate("2026-05-01").contains("2026"))
        assertEquals("—", EventDates.fmtDate(null))
        assertEquals("—", EventDates.fmtDate("nonsense"))
    }

    @Test
    fun `formats day counts including half days`() {
        assertEquals("2 days", EventDates.fmtDays(2.0))
        assertEquals("1 day", EventDates.fmtDays(1.0))
        assertEquals("1.5 days", EventDates.fmtDays(1.5))
    }

    // ---- the checklist contract -------------------------------------------

    @Test
    fun `the default checklist matches the web implementation item for item`() {
        val fixture = Json.parseToJsonElement(
            RepoRoot.path("contracts/logic/checklist.json").readText(),
        ).jsonObject
        val expected = fixture["DEFAULT_CHECKLIST"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(expected, EventDates.DEFAULT_CHECKLIST)
    }
}
