package app.trackevolution.core

import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.Entitlement.Gate
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The tier predicates, and their agreement with the web app (NS-32).
 *
 * `contracts/logic/entitlement.json` is `public/js/entitlement.js` run over
 * every shape `entitlement` on `/api/me` can take, and it is the same file the
 * iOS Kit asserts against — so both ports are checked against the reference
 * rather than against each other. The one deliberate subtlety it pins is the
 * last case: a cached Pro whose `expires_at` is already past on the phone's
 * clock is **still Pro**, because expiry is the server's call and offline the
 * cached answer has to stand or a driver who was Pro at the last sync couldn't
 * record (rule 5).
 */
class EntitlementTest {

    private val json = Json { ignoreUnknownKeys = false }

    private val fixture = Json.parseToJsonElement(
        RepoRoot.path("contracts/logic/entitlement.json").readText(),
    ).jsonObject

    // ---- Cross-language agreement ------------------------------------------

    @Test
    fun `matches the JavaScript implementation on every fixture case`() {
        val cases = fixture["cases"]!!.jsonArray
        assertEquals(9, cases.size, "the fixture grew — port the new case's expectation too")
        for (element in cases) {
            val case = element.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val raw = case["entitlement"]!!
            val entitlement = if (raw is JsonNull) null else json.decodeFromJsonElement(Entitlement.serializer(), raw)
            val expected = case["expected"]!!.jsonObject

            fun flag(key: String) = expected[key]!!.jsonPrimitive.content.toBooleanStrict()
            assertEquals(flag("isPro"), Entitlement.isPro(entitlement), "$name: isPro")
            assertEquals(flag("canRecord"), Entitlement.canRecord(entitlement), "$name: canRecord")
            assertEquals(flag("canViewChannels"), Entitlement.canViewChannels(entitlement), "$name: canViewChannels")
            // Per gridded channel (#264): the free three are true for everyone.
            val perChannel = expected["canViewChannel"]!!.jsonObject
            assertTrue(perChannel.size >= 12, "$name: the fixture names every gridded channel")
            for ((key, allowed) in perChannel) {
                assertEquals(
                    allowed.jsonPrimitive.content.toBooleanStrict(),
                    Entitlement.canViewChannel(entitlement, key),
                    "$name: canViewChannel($key)",
                )
            }
            assertEquals(flag("canUseGarage"), Entitlement.canUseGarage(entitlement), "$name: canUseGarage")
            assertEquals(flag("canUseSetups"), Entitlement.canUseSetups(entitlement), "$name: canUseSetups")
            assertEquals(
                flag("canViewYearInReview"),
                Entitlement.canViewYearInReview(entitlement),
                "$name: canViewYearInReview",
            )
            assertEquals(flag("canViewSpend"), Entitlement.canViewSpend(entitlement), "$name: canViewSpend")
            assertEquals(
                flag("canCompareEvents"),
                Entitlement.canCompareEvents(entitlement),
                "$name: canCompareEvents",
            )

            val manage = expected["manageUrl"]!!
            assertEquals(
                if (manage is JsonNull) null else manage.jsonPrimitive.content,
                Entitlement.manageUrl(entitlement),
                "$name: manageUrl",
            )

            // The fixture renders the date as <ms>, so the wording is pinned
            // without a locale.
            assertEquals(
                expected["summary"]!!.jsonPrimitive.content,
                Entitlement.entitlementSummary(entitlement) { ms -> "<$ms>" },
                "$name: summary",
            )
        }
    }

    @Test
    fun `the free allow-list is the web's`() {
        assertEquals(
            fixture["freeChannels"]!!.jsonArray.map { it.jsonPrimitive.content },
            Entitlement.FREE_CHANNELS,
        )
        assertEquals(listOf("speed", "throttle", "brake"), Entitlement.FREE_CHANNELS)
        for (key in Entitlement.FREE_CHANNELS) {
            assertTrue(Entitlement.canViewChannel(Entitlement.FREE, key), key)
            assertTrue(Entitlement.canViewChannel(null, key), key)
        }
        val pro = Entitlement(tier = Entitlement.Tier.PRO, source = Entitlement.Source.APPLE, expiresAt = 1L, autoRenew = true)
        for (key in listOf("rpm", "latG", "steering", "yaw", "gear", "flags", "wheelSlip", "boost", "longG")) {
            assertFalse(Entitlement.canViewChannel(Entitlement.FREE, key), key)
            assertTrue(Entitlement.canViewChannel(pro, key), key)
        }
    }

    @Test
    fun `the default date formatter is the JS default - an ISO date in UTC`() {
        val pro = Entitlement(
            tier = Entitlement.Tier.PRO,
            source = Entitlement.Source.APPLE,
            expiresAt = 1_800_000_000_000L,
            autoRenew = true,
        )
        assertEquals("Pro · renews 2027-01-15", Entitlement.entitlementSummary(pro))
    }

    // ---- The gates (on since phase D) -------------------------------------

    private val free = Entitlement.FREE
    private val pro = Entitlement(tier = Entitlement.Tier.PRO, source = Entitlement.Source.GOOGLE, expiresAt = 1L, autoRenew = true)

    @Test
    fun `the gates are on in this phase`() {
        assertTrue(Entitlement.GATES_ENABLED, "phase D turned the gates on")
        // The default-argument path, which is what every screen actually calls.
        assertEquals(Gate.PAYWALL, Entitlement.recordGate(free))
        assertEquals(Gate.PAYWALL, Entitlement.recordGate(null))
        assertEquals(Gate.PROCEED, Entitlement.recordGate(pro))
    }

    @Test
    fun `with the gates on, a free account meets the paywall instead of starting`() {
        assertEquals(Gate.PAYWALL, Entitlement.recordGate(free, gatesEnabled = true))
        // Nothing cached at all — signed out, or never fetched — is free too.
        assertEquals(Gate.PAYWALL, Entitlement.recordGate(null, gatesEnabled = true))
    }

    @Test
    fun `with the gates on, a cached Pro proceeds - even one whose expiry is past on this clock`() {
        // expires_at = 1 ms after the epoch: long past, and still Pro, because
        // the server said so at the last sync and the phone may be offline now.
        assertEquals(Gate.PROCEED, Entitlement.recordGate(pro, gatesEnabled = true))
        assertTrue(Entitlement.isPro(pro))
    }
}
