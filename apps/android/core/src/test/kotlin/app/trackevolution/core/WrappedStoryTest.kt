package app.trackevolution.core

import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.model.Wrapped
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.time.LocalDate

/**
 * Season Wrapped's presentation rules, pinned to `public/js/wrapped.js` through
 * `contracts/logic/wrapped.json` — the same fixture the iOS Kit asserts
 * against, so the two ports are checked against the web rather than against
 * each other.
 */
class WrappedStoryTest {

    private val fixture = Json.parseToJsonElement(
        RepoRoot.path("contracts/logic/wrapped.json").readText(),
    ).jsonObject

    private val decoder = Json { ignoreUnknownKeys = false }

    private fun seasons() = fixture["seasons"]!!.jsonArray.map { it.jsonObject }

    private fun data(season: JsonObject): Wrapped = decoder.decodeFromJsonElement(Wrapped.serializer(), season["data"]!!)

    private fun posterOf(o: JsonObject) = WrappedStory.Poster(
        title = o["title"]!!.jsonPrimitive.content,
        headline = o["headline"]!!.jsonArray.map { it.jsonPrimitive.content },
        rows = o["rows"]!!.jsonArray.map { r -> r.jsonArray.let { it[0].jsonPrimitive.content to it[1].jsonPrimitive.content } },
    )

    @Test
    fun `wrappedSeason matches the reveal window`() {
        for (c in fixture["season"]!!.jsonArray.map { it.jsonObject }) {
            val today = c["today"]!!.jsonPrimitive.content
            val expected = c["expected"]!!.takeIf { it !is JsonNull }?.jsonPrimitive?.int
            assertEquals(expected, WrappedStory.wrappedSeason(today), today)
        }
    }

    @Test
    fun `wrappedCards match the web implementation season for season`() {
        for (s in seasons()) {
            val name = s["name"]!!.jsonPrimitive.content
            val expected = s["cards"]!!.jsonArray.map { el ->
                val o = el.jsonObject
                o["kind"]!!.jsonPrimitive.content to (o["locked"]?.jsonPrimitive?.boolean ?: false)
            }
            val actual = WrappedStory.wrappedCards(data(s), shared = name == "shared").map { it.kind.id to it.locked }
            assertEquals(expected, actual, name)
        }
    }

    @Test
    fun `posterLines match the web implementation`() {
        for (s in seasons()) {
            val name = s["name"]!!.jsonPrimitive.content
            val p = s["poster"]!!.jsonObject
            val d = data(s)
            assertEquals(posterOf(p["imperial"]!!.jsonObject), WrappedStory.posterLines(d, UnitSystem.IMPERIAL), "$name imperial")
            assertEquals(posterOf(p["metric"]!!.jsonObject), WrappedStory.posterLines(d, UnitSystem.METRIC), "$name metric")
            assertEquals(posterOf(p["shared"]!!.jsonObject), WrappedStory.posterLines(d, UnitSystem.IMPERIAL, share = true), "$name shared")
        }
    }

    @Test
    fun `formatting matches the web implementation`() {
        val f = fixture["format"]!!.jsonObject
        for (c in f["fmtDays"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(c["expected"]!!.jsonPrimitive.content, WrappedStory.fmtDays(c["d"]!!.jsonPrimitive.double))
        }
        for (c in f["fmtGain"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(c["expected"]!!.jsonPrimitive.content, WrappedStory.fmtGain(c["ms"]!!.jsonPrimitive.int))
        }
        for (c in f["trackDistance"]!!.jsonArray.map { it.jsonObject }) {
            val units = if (c["units"]!!.jsonPrimitive.content == "metric") UnitSystem.METRIC else UnitSystem.IMPERIAL
            val e = c["expected"]!!.jsonObject
            assertEquals(
                WrappedStory.Distance(e["value"]!!.jsonPrimitive.content, e["unit"]!!.jsonPrimitive.content),
                WrappedStory.trackDistance(c["miles"]!!.jsonPrimitive.double, units),
            )
        }
    }

    // ---- the JS test cases, ported ----------------------------------------

    @Test
    fun `the reveal window reads a local day`() {
        assertEquals(2026, WrappedStory.wrappedSeason(LocalDate.of(2026, 11, 1)))
        assertEquals(2026, WrappedStory.wrappedSeason(LocalDate.of(2027, 1, 31)))
        assertEquals(null, WrappedStory.wrappedSeason(LocalDate.of(2027, 2, 1)))
    }

    @Test
    fun `half days show as halves and gains to the hundredth`() {
        assertEquals("14", WrappedStory.fmtDays(14.0))
        assertEquals("2.5", WrappedStory.fmtDays(2.5))
        assertEquals("4.83 s", WrappedStory.fmtGain(4830))
    }
}
