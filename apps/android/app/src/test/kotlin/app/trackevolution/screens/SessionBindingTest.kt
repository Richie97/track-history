package app.trackevolution.screens

import app.trackevolution.core.ChannelGraphs
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.SessionChannels
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The session stage's sides against the panel's lit laps (NS-51). With nothing
 * opened, A is the newest lit lap — `stageSides`' rule — so it is not always
 * the first chip, and the emulator showed the stage colouring A green while its
 * chip and trace were blue. A side now carries its lap's slot.
 */
class SessionBindingTest {

    private fun lap(num: Int, ms: Int) = Lap(id = num, sessionId = 10, lapNum = num, timeMs = ms)
    private fun entry(n: Int, ms: Int) = LapChannels(n, ms, speed = List(40) { 100.0 + it % 7 })

    private val laps = listOf(lap(1, 101_400), lap(2, 98_900), lap(3, 99_600))
    private val session = Session(
        id = 10,
        sort = 1,
        laps = laps,
        channels = SessionChannels(v = 1, dStepM = 20.0, laps = listOf(entry(1, 101_400), entry(2, 98_900), entry(3, 99_600))),
    )
    private val matched = ChannelGraphs.matchLapsToChannels(laps, session.channels!!.laps)

    @Test
    fun `each side takes its lap's slot among the lit laps, not its side's colour`() {
        // Lap 2 lit first (green), lap 3 second (blue); nothing opened, so A is lap 3.
        val b = sessionBinding(session, matched, listOf(1, 2), opened = null, canPlay = false, canViewChannels = true)!!
        assertEquals(2, b.a.chIdx)
        assertEquals("A is lap 3, lit second", 1, b.a.slot)
        assertEquals(1, b.b!!.chIdx)
        assertEquals("B is lap 2, lit first", 0, b.b!!.slot)
    }

    @Test
    fun `opened from a lap, that lap is A in whichever slot it was lit`() {
        val b = sessionBinding(session, matched, listOf(1, 2), opened = 1, canPlay = false, canViewChannels = true)!!
        assertEquals(1, b.a.chIdx)
        assertEquals(0, b.a.slot)
        assertEquals(1, b.b!!.slot)
    }
}
