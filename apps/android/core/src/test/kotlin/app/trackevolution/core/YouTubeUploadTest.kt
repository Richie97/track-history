package app.trackevolution.core

import app.trackevolution.core.YouTubeUpload.Offer
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.LapClip
import app.trackevolution.core.model.LapClipYouTube
import app.trackevolution.core.model.YouTubeAccount
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import app.trackevolution.core.model.YouTubeUpload as Upload

/**
 * Publish a best-lap video to YouTube (NS-46): the client's pure half
 * (`YouTubeUpload`) and its agreement with the web app.
 *
 * Carries the JS cases from `test/unit/youtube-client.test.js` and asserts
 * every row of `contracts/logic/youtube.json`, which `npm run contracts:logic`
 * generates from `public/js/youtube.js` — the fixture the iOS Kit asserts
 * against too.
 */
class YouTubeUploadTest {

    private val json = Json { ignoreUnknownKeys = false }
    private val fixture: JsonObject =
        Json.parseToJsonElement(RepoRoot.path("contracts/logic/youtube.json").readText()).jsonObject

    private fun JsonElement?.orNull(): JsonElement? = if (this == null || this is JsonNull) null else this
    private fun JsonObject.text(key: String): String? = this[key].orNull()?.jsonPrimitive?.contentOrNull

    // ---- The JS cases --------------------------------------------------------

    private val pro = Entitlement(Entitlement.Tier.PRO, Entitlement.Source.APPLE, 1_800_000_000_000, true)
    private val free = Entitlement(Entitlement.Tier.FREE)

    private fun me(available: Boolean = true, connected: Boolean = true) =
        YouTubeAccount(available = available, connected = connected, account = "a@b.c")

    private fun clip(status: String?) = LapClip(
        id = 1, durationMs = 108_000, lapOffsetMs = 3_317,
        youtube = status?.let { LapClipYouTube(status = it, privacy = "unlisted") },
    )

    @Test
    fun `offers the upload to a connected Pro driver, and the connect step before that`() {
        assertEquals(Offer.UPLOAD, YouTubeUpload.youtubeOffer(clip(null), pro, me(), false))
        assertEquals(Offer.CONNECT, YouTubeUpload.youtubeOffer(clip(null), pro, me(connected = false), false))
    }

    @Test
    fun `follows the upload's state`() {
        assertEquals(Offer.PENDING, YouTubeUpload.youtubeOffer(clip("queued"), pro, me(), false))
        assertEquals(Offer.PENDING, YouTubeUpload.youtubeOffer(clip("uploading"), pro, me(), false))
        assertEquals(Offer.DONE, YouTubeUpload.youtubeOffer(clip("done"), pro, me(), false))
        assertEquals(Offer.FAILED, YouTubeUpload.youtubeOffer(clip("failed"), pro, me(), false))
    }

    @Test
    fun `locks starting one for a free account, but never hides a link already made`() {
        assertEquals(Offer.LOCKED, YouTubeUpload.youtubeOffer(clip(null), free, me(), false))
        assertEquals(Offer.LOCKED, YouTubeUpload.youtubeOffer(clip("failed"), free, me(), false))
        assertEquals(Offer.DONE, YouTubeUpload.youtubeOffer(clip("done"), free, me(), false))
        assertEquals(Offer.PENDING, YouTubeUpload.youtubeOffer(clip("uploading"), free, me(), false))
    }

    @Test
    fun `draws nothing while the feature is off, with no clip, or for a coach`() {
        assertEquals(Offer.NONE, YouTubeUpload.youtubeOffer(clip("done"), pro, me(available = false), false))
        assertEquals(Offer.NONE, YouTubeUpload.youtubeOffer(clip(null), pro, null, false))
        assertEquals(Offer.NONE, YouTubeUpload.youtubeOffer(null, pro, me(), false))
        for (s in listOf(null, "queued", "done", "failed")) {
            assertEquals(Offer.NONE, YouTubeUpload.youtubeOffer(clip(s), pro, me(), true))
        }
    }

    @Test
    fun `says where the upload is, flooring the percentage under 100`() {
        fun line(status: String, progress: Double? = 0.0, privacy: String? = null, error: String? = null) =
            YouTubeUpload.youtubeStatusLine(status, privacy, progress, error)
        assertEquals("Waiting to upload to YouTube", line("queued"))
        assertEquals("Uploading to YouTube · 40%", line("uploading", 0.4))
        assertEquals("Uploading to YouTube · 99%", line("uploading", 0.996))
        assertEquals("Uploading to YouTube · 99%", line("uploading", 1.0))
        assertEquals("On YouTube · Public", line("done", privacy = "public"))
        assertEquals("YouTube was disconnected.", line("failed", error = "YouTube was disconnected."))
        assertEquals("YouTube didn't accept the upload. Try again.", line("failed"))
        assertEquals("", YouTubeUpload.youtubeStatusLine(null as Upload?))
        assertEquals("", YouTubeUpload.youtubeStatusLine(null as LapClipYouTube?))
        // A status the server adds later says nothing rather than something wrong.
        assertEquals("", line("processing"))
        // A value JavaScript's Number() would read as 0.
        assertEquals("Uploading to YouTube · 0%", line("uploading", Double.NaN))
        assertEquals("Uploading to YouTube · 0%", line("uploading", -0.5))
    }

    @Test
    fun `lets a waiting note win over the percentage`() {
        val note = "Waiting for YouTube — uploads continue tomorrow."
        assertEquals(note, YouTubeUpload.youtubeStatusLine("queued", "unlisted", 0.0, note))
        assertEquals(note, YouTubeUpload.youtubeStatusLine("uploading", "unlisted", 0.5, note))
    }

    @Test
    fun `polls only while on its way`() {
        assertEquals(
            listOf(true, true, false, false),
            listOf("queued", "uploading", "done", "failed").map { YouTubeUpload.youtubeIsPending(it) },
        )
        assertEquals(false, YouTubeUpload.youtubeIsPending(null as Upload?))
    }

    @Test
    fun `names both of Google's documents in the consent text, and links them`() {
        for (l in YouTubeUpload.YOUTUBE_LINKS) assertTrue(YouTubeUpload.YOUTUBE_CONNECT_TEXT.contains(l.label))
        assertTrue(YouTubeUpload.YOUTUBE_CONNECT_TEXT.contains("YouTube API Services"))
        assertEquals(listOf("private", "unlisted", "public"), YouTubeUpload.YOUTUBE_PRIVACY.map { it.value })
    }

    @Test
    fun `an unknown privacy reads as the most cautious one`() {
        assertEquals("Private", YouTubeUpload.youtubePrivacyLabel("members"))
        assertEquals("Private", YouTubeUpload.youtubePrivacyLabel(null))
    }

    // ---- The fixture ---------------------------------------------------------

    @Test
    fun `the fixed sentences and constants match the web`() {
        assertEquals(
            fixture["privacy"]!!.jsonArray.map { it.jsonObject.text("value") to it.jsonObject.text("label") },
            YouTubeUpload.YOUTUBE_PRIVACY.map { it.value to it.label },
        )
        assertEquals(fixture.text("defaultPrivacy"), YouTubeUpload.YOUTUBE_DEFAULT_PRIVACY)
        assertEquals(fixture.text("connectText"), YouTubeUpload.YOUTUBE_CONNECT_TEXT)
        assertEquals(
            fixture["links"]!!.jsonArray.map { it.jsonObject.text("label") to it.jsonObject.text("url") },
            YouTubeUpload.YOUTUBE_LINKS.map { it.label to it.url },
        )
        assertEquals(fixture.text("permissionsUrl"), YouTubeUpload.GOOGLE_PERMISSIONS_URL)
        assertEquals(fixture.text("kidsText"), YouTubeUpload.YOUTUBE_KIDS_TEXT)
        assertEquals(fixture.text("deleteNote"), YouTubeUpload.YOUTUBE_DELETE_NOTE)
        assertEquals(fixture.text("disconnectNote"), YouTubeUpload.YOUTUBE_DISCONNECT_NOTE)
        assertEquals(fixture.text("offline"), YouTubeUpload.YOUTUBE_OFFLINE)
        assertEquals(
            fixture["resultText"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content },
            YouTubeUpload.YOUTUBE_RESULT_TEXT,
        )
    }

    @Test
    fun `every offer row matches the web`() {
        val rows = fixture["offers"]!!.jsonArray
        assertTrue(rows.isNotEmpty())
        for (row in rows.map { it.jsonObject }) {
            val clip = row["clip"].orNull()?.let { json.decodeFromJsonElement(LapClip.serializer(), it) }
            val entitlement = row["entitlement"].orNull()?.let { json.decodeFromJsonElement(Entitlement.serializer(), it) }
            val youtube = row["me"].orNull()?.jsonObject?.get("youtube").orNull()
                ?.let { json.decodeFromJsonElement(YouTubeAccount.serializer(), it) }
            val offer = YouTubeUpload.youtubeOffer(clip, entitlement, youtube, row["readOnly"]!!.jsonPrimitive.boolean)
            assertEquals(row.text("offer"), offer.value, row.text("name"))
        }
    }

    @Test
    fun `every status line matches the web`() {
        val rows = fixture["statusLines"]!!.jsonArray
        assertTrue(rows.isNotEmpty())
        for (row in rows.map { it.jsonObject }) {
            val upload = row["upload"]!!.jsonObject
            val status = upload.text("status")
            val line = YouTubeUpload.youtubeStatusLine(
                status,
                upload.text("privacy"),
                upload["progress"].orNull()?.jsonPrimitive?.doubleOrNull,
                upload.text("error"),
            )
            assertEquals(row.text("line"), line, upload.toString())
            assertEquals(row["pending"]!!.jsonPrimitive.boolean, YouTubeUpload.youtubeIsPending(status), upload.toString())
            // The two model overloads say the same, where the row has the model's shape.
            if ("progress" in upload) {
                val model = json.decodeFromJsonElement(Upload.serializer(), upload)
                assertEquals(row.text("line"), YouTubeUpload.youtubeStatusLine(model))
                assertEquals(row["pending"]!!.jsonPrimitive.boolean, YouTubeUpload.youtubeIsPending(model))
            } else {
                val model = json.decodeFromJsonElement(LapClipYouTube.serializer(), upload)
                assertEquals(row.text("line"), YouTubeUpload.youtubeStatusLine(model))
            }
        }
    }

    @Test
    fun `every request refusal is worded as the web words it`() {
        val rows = fixture["requestErrors"]!!.jsonArray
        assertTrue(rows.isNotEmpty())
        for (row in rows.map { it.jsonObject }) {
            assertEquals(row.text("text"), YouTubeUpload.youtubeRequestError(row.text("message")))
        }
        assertEquals("YouTube didn't accept the upload. Try again.", YouTubeUpload.youtubeRequestError(null))
    }

    @Test
    fun `every account line matches the web`() {
        val rows = fixture["accountLines"]!!.jsonArray
        assertTrue(rows.isNotEmpty())
        for (row in rows.map { it.jsonObject }) {
            val yt = json.decodeFromJsonElement(YouTubeAccount.serializer(), row["youtube"]!!)
            assertEquals(row.text("line"), YouTubeUpload.youtubeAccountLine(yt), row["youtube"].toString())
        }
        assertEquals("", YouTubeUpload.youtubeAccountLine(null))
    }
}
