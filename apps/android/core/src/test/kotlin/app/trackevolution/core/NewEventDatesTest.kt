package app.trackevolution.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class NewEventDatesTest {

    @Test
    fun `a single-day recording is a one-day event on that day`() {
        assertEquals(NewEventDates.Span("2026-06-20", 1), NewEventDates.span(listOf("2026-06-20")))
    }

    @Test
    fun `several clips span from the earliest date to the latest`() {
        assertEquals(
            NewEventDates.Span("2026-06-20", 2),
            NewEventDates.span(listOf("2026-06-21", "2026-06-20", "2026-06-21")),
        )
    }

    @Test
    fun `the span crosses a month end`() {
        assertEquals(NewEventDates.Span("2026-05-31", 3), NewEventDates.span(listOf("2026-06-02", "2026-05-31")))
    }

    @Test
    fun `a session with no date is left out of the span`() {
        assertEquals(NewEventDates.Span("2026-06-20", 1), NewEventDates.span(listOf(null, "2026-06-20", "")))
    }

    @Test
    fun `no date at all keeps the form's defaults`() {
        assertNull(NewEventDates.span(emptyList()))
        assertNull(NewEventDates.span(listOf(null, "not a date")))
    }
}
