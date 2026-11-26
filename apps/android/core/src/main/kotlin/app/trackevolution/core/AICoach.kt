package app.trackevolution.core

import app.trackevolution.core.model.AICoachModel
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharsetDecoder
import java.nio.charset.CodingErrorAction
import java.time.LocalDate

/**
 * The AI Coach's pure half (#320) — the port of `public/js/ai-coach.js` under
 * the same names: the entry points and what each sends, the event-stream
 * parser, the safe Markdown subset a reply is drawn with, the model field and
 * the label a saved reply carries into the notes. Pinned by `AICoachTest`
 * against `contracts/logic/ai-coach.json` (the fixture the iOS Kit asserts
 * against too) and against the recorded stream `contracts/streams/ai-coach.sse`.
 *
 * Always "AI Coach": a bare "coach" is a person in this app (NS-38). The wire
 * format is `docs/specs/native/NS-58-ai-coach.md`; the request itself is
 * `ApiClient.aiCoach`, which never goes through the offline layer.
 */
public object AICoach {

    public const val COACH_NAME: String = "AI Coach"

    public data class Provider(val id: String, val name: String, val keyUrl: String, val placeholder: String)

    public val COACH_PROVIDERS: List<Provider> = listOf(
        Provider("anthropic", "Anthropic", "https://platform.claude.com/settings/keys", "sk-ant-…"),
        Provider("openai", "OpenAI", "https://platform.openai.com/api-keys", "sk-…"),
    )

    /** "provider" for the dev-only fake (and anything unknown), which has no name to show. */
    public fun providerName(id: String?): String = COACH_PROVIDERS.firstOrNull { it.id == id }?.name ?: "provider"

    public const val COACH_PRO_WHAT: String =
        "A debrief of a session, an explanation of the gap between two laps, or a plan for your next visit — " +
            "written from your own telemetry and history, on your own Anthropic or OpenAI account."
    public const val COACH_OFFLINE: String = "needs a connection"
    public const val COACH_DISCLAIMER: String = "For the paddock, not the car — and not a substitute for an instructor."

    /** One place the AI Coach opens from: the button's words, its title, its opening question, whose notes keep a reply. */
    public data class Entry(
        val key: String,
        val button: String,
        val title: String,
        val question: String,
        /** `session` or `event`. */
        val saveTo: String,
    )

    public val COACH_ENTRIES: Map<String, Entry> = linkedMapOf(
        "session" to Entry(
            "session",
            button = "Debrief this session",
            title = "Session debrief",
            question = "Debrief this session: what went well, where the time is, and one or two specific things to try next session.",
            saveTo = "session",
        ),
        "compare" to Entry(
            "compare",
            button = "Explain the difference",
            title = "Two laps compared",
            question = "Explain the difference between these two laps: where the time went, corner by corner, and what I would change.",
            saveTo = "event",
        ),
        "event" to Entry(
            "event",
            button = "What should I work on next time?",
            title = "Next time",
            question = "What should I work on next time I'm at this track?",
            saveTo = "event",
        ),
    )

    public fun coachSaveLabel(entry: String): String =
        if (COACH_ENTRIES[entry]?.saveTo == "session") "Save to session notes" else "Save to event notes"

    /** The request's `context`: where the AI Coach was opened from. */
    @Serializable
    public data class CoachContext(
        @SerialName("event_id") val eventId: Int? = null,
        @SerialName("session_id") val sessionId: Int? = null,
        @SerialName("lap_id") val lapId: Int? = null,
        @SerialName("compare_lap_id") val compareLapId: Int? = null,
        @SerialName("track_id") val trackId: Int? = null,
    )

    /**
     * A server id as the API wants it: a positive integer. A row created
     * offline has a temp id the server has never heard of — `tmp-…` on the
     * web, a negative Int here — and a string of digits counts, as in the JS.
     */
    private fun serverId(v: Any?): Int? {
        val n: Any? = if (v is String && Regex("^\\d+$").matches(v)) v.toLongOrNull() else v
        return when (n) {
            is Int -> n.takeIf { it > 0 }
            is Long -> n.takeIf { it in 1..Int.MAX_VALUE }?.toInt()
            is Double -> n.takeIf { it > 0 && it % 1.0 == 0.0 && it <= Int.MAX_VALUE }?.toInt()
            else -> null
        }
    }

    /**
     * The request's `context` for an entry point, or null when a row it needs
     * has no server id yet (the button is then not offered).
     *   session: eventId, sessionId
     *   compare: lapId (A, the reference), compareLapId (B), trackId?
     *   event:   eventId, trackId?
     */
    public fun coachContext(
        entry: String,
        eventId: Any? = null,
        sessionId: Any? = null,
        lapId: Any? = null,
        compareLapId: Any? = null,
        trackId: Any? = null,
    ): CoachContext? {
        val track = serverId(trackId)
        return when (entry) {
            "session" -> {
                val event = serverId(eventId)
                val session = serverId(sessionId)
                if (event != null && session != null) CoachContext(eventId = event, sessionId = session) else null
            }
            "compare" -> {
                val a = serverId(lapId)
                val b = serverId(compareLapId)
                if (a != null && b != null && a != b) CoachContext(lapId = a, compareLapId = b, trackId = track) else null
            }
            "event" -> serverId(eventId)?.let { CoachContext(eventId = it, trackId = track) }
            else -> null
        }
    }

    // ---- the event stream -----------------------------------------------------

    /**
     * An incremental server-sent-events parser: [push] text as it arrives (or
     * [pushBytes], which holds a multi-byte character split across chunks), and
     * each complete `event:` / `data:` block is handed to the callback with its
     * data parsed as JSON. Comment lines (the server's keepalive) and blocks
     * whose data is not JSON are skipped; a block split across chunks waits for
     * its end. Unknown event names are handed on — the caller ignores them.
     */
    public class SseParser internal constructor(private val onEvent: (String, JsonElement) -> Unit) {
        private val buf = StringBuilder()
        private val decoder: CharsetDecoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPLACE)
            .onUnmappableCharacter(CodingErrorAction.REPLACE)
        private var pending = ByteArray(0)

        public fun push(text: String) {
            buf.append(text)
            drain(false)
        }

        /** Bytes off the wire; an incomplete UTF-8 sequence at the end waits for the next chunk. */
        public fun pushBytes(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size) {
            val input = ByteBuffer.wrap(pending + bytes.copyOfRange(offset, offset + length))
            val out = CharBuffer.allocate(input.remaining() + 1)
            decoder.decode(input, out, false)
            pending = ByteArray(input.remaining()).also { input.get(it) }
            out.flip()
            push(out.toString())
        }

        public fun end() {
            if (pending.isNotEmpty()) {
                val out = CharBuffer.allocate(pending.size + 1)
                decoder.decode(ByteBuffer.wrap(pending), out, true)
                decoder.flush(out)
                out.flip()
                buf.append(out)
                pending = ByteArray(0)
            }
            drain(true)
        }

        private fun drain(final: Boolean) {
            // A trailing CR may be half of a CRLF whose LF is in the next chunk.
            val held = if (!final && buf.endsWith("\r")) "\r" else ""
            var s = buf.substring(0, buf.length - held.length).replace(CRLF, "\n") + held
            while (true) {
                val cut = s.indexOf("\n\n")
                if (cut < 0) break
                val block = s.substring(0, cut)
                s = s.substring(cut + 2)
                flush(block)
            }
            if (final && s.isNotBlank()) flush(s)
            buf.setLength(0)
            if (!final) buf.append(s)
        }

        private fun flush(block: String) {
            var event = "message"
            val data = mutableListOf<String>()
            for (line in block.split("\n")) {
                if (line.isEmpty() || line.startsWith(":")) continue
                val colon = line.indexOf(':')
                val field = if (colon < 0) line else line.substring(0, colon)
                val value = if (colon < 0) "" else line.substring(colon + 1).removePrefix(" ")
                if (field == "event") event = value else if (field == "data") data.add(value)
            }
            if (data.isEmpty()) return
            val parsed = try {
                STRICT.parseToJsonElement(data.joinToString("\n"))
            } catch (_: Exception) {
                return
            }
            onEvent(event, parsed)
        }
    }

    public fun createSseParser(onEvent: (event: String, data: JsonElement) -> Unit): SseParser = SseParser(onEvent)

    // ---- errors ---------------------------------------------------------------

    private fun sentence(s: String): String =
        s.replaceFirstChar { it.uppercaseChar() } + if (Regex("[.!?…]$").containsMatchIn(s)) "" else "."

    /**
     * What the sheet says for a refusal. The server's own `{ error }` is the
     * message; these only make its terser ones into a sentence a driver can act on.
     */
    public fun coachErrorText(status: Int, error: String?, provider: String?): String {
        if (status == 424 && error == "provider rejected the key") {
            return sentence("${providerName(provider)} rejected the key. Check it in Settings → AI assistants")
        }
        if (status == 400 && error == "no AI provider set up") return "No AI provider is set up yet. Add a key in Settings → AI assistants."
        if (error.isNullOrEmpty()) return "The $COACH_NAME couldn't answer. Try again."
        return sentence(error)
    }

    // ---- the model field --------------------------------------------------------

    /**
     * What the driver typed, as the id to send: a listed model's *name* picks
     * its id, anything else is taken as an id, and nothing is the default (null).
     */
    public fun resolveModelInput(text: String?, models: List<AICoachModel>?): String? {
        val typed = (text ?: "").trim()
        if (typed.isEmpty()) return null
        val list = models.orEmpty()
        val lower = typed.lowercase()
        val hit = list.firstOrNull { it.id.lowercase() == lower } ?: list.firstOrNull { it.label.lowercase() == lower }
        return hit?.id ?: typed
    }

    /** The field's placeholder: which model an empty field means. */
    public fun modelPlaceholder(defaultModel: String?): String =
        if (!defaultModel.isNullOrEmpty()) "Default ($defaultModel)" else "Default"

    // ---- drawing a reply --------------------------------------------------------

    /** One block of a reply: a paragraph's lines, a list's items, or a heading drawn as a bold line. */
    public sealed interface CoachBlock {
        public data class Paragraph(val lines: List<String>) : CoachBlock
        public data class ListBlock(val ordered: Boolean, val items: List<String>) : CoachBlock
        public data class Heading(val text: String) : CoachBlock
    }

    private val BULLET = Regex("^[-*•]\\s+(.*)$")
    private val NUMBERED = Regex("^\\d{1,3}[.)]\\s+(.*)$")
    private val HEADING = Regex("^#{1,6}\\s+(.*)$")
    private val CONTINUES = Regex("^\\s+\\S")
    private val CRLF = Regex("\\r\\n?")

    /**
     * A model's reply as blocks: paragraphs, bulleted and numbered lists, and
     * headings (drawn as a bold line). Everything else Markdown can say stays
     * the plain text it is — no HTML, no link, no image, no code block.
     */
    public fun coachMarkdownBlocks(text: String?): List<CoachBlock> {
        val out = mutableListOf<CoachBlock>()
        var para = mutableListOf<String>()
        var listOrdered: Boolean? = null
        var items = mutableListOf<String>()
        fun endPara() {
            if (para.isNotEmpty()) out.add(CoachBlock.Paragraph(para))
            para = mutableListOf()
        }
        fun endList() {
            listOrdered?.let { out.add(CoachBlock.ListBlock(it, items)) }
            listOrdered = null
            items = mutableListOf()
        }
        for (raw in (text ?: "").replace(CRLF, "\n").split("\n")) {
            val line = raw.trim()
            if (line.isEmpty()) {
                endPara()
                endList()
                continue
            }
            val bullet = BULLET.find(line)
            val numbered = NUMBERED.find(line)
            val heading = HEADING.find(line)
            if (bullet != null || numbered != null) {
                endPara()
                val ordered = bullet == null
                if (listOrdered != null && listOrdered != ordered) endList()
                if (listOrdered == null) listOrdered = ordered
                items.add((bullet ?: numbered)!!.groupValues[1])
            } else if (heading != null) {
                endPara()
                endList()
                out.add(CoachBlock.Heading(heading.groupValues[1].replace("**", "")))
            } else if (listOrdered != null && CONTINUES.containsMatchIn(raw)) {
                // An indented line under a list item continues it.
                items[items.size - 1] = items.last() + " " + line
            } else {
                endList()
                para.add(line)
            }
        }
        endPara()
        endList()
        return out
    }

    public data class BoldRun(val text: String, val bold: Boolean)

    private val BOLD = Regex("\\*\\*(.+?)\\*\\*")

    /** A line split at its bold marks — the one inline mark. An unclosed `**` stays as the text it is. */
    public fun coachBoldRuns(s: String?): List<BoldRun> {
        val str = s ?: ""
        val runs = mutableListOf<BoldRun>()
        var at = 0
        for (m in BOLD.findAll(str)) {
            if (m.range.first > at) runs.add(BoldRun(str.substring(at, m.range.first), false))
            runs.add(BoldRun(m.groupValues[1], true))
            at = m.range.last + 1
        }
        if (at < str.length) runs.add(BoldRun(str.substring(at), false))
        return runs
    }

    // ---- keeping a reply --------------------------------------------------------

    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    /** "AI Coach, 26 Nov" — notes travel to a human coach, who should tell this from the driver's own words. */
    public fun coachNotesLabel(date: LocalDate): String = "$COACH_NAME, ${date.dayOfMonth} ${MONTHS[date.monthValue - 1]}"

    private val PLAIN_HEADING = Regex("^(\\s*)#{1,6}\\s+")
    private val PLAIN_BULLET = Regex("^(\\s*)[*•]\\s+")

    /** Notes are plain text: bold and heading markers go, list items keep a dash. */
    public fun coachPlainText(text: String?): String =
        (text ?: "").replace(CRLF, "\n")
            .split("\n")
            .joinToString("\n") { l ->
                l.replace(PLAIN_HEADING, "$1").replace(PLAIN_BULLET, "$1- ").replace(BOLD, "$1").trimEnd()
            }
            .replace(Regex("\n{3,}"), "\n\n")
            .trim()

    /** The notes after keeping a reply: what was there, a blank line, the label on its own line, then the reply. */
    public fun appendCoachNote(existing: String?, reply: String, date: LocalDate): String {
        val kept = "${coachNotesLabel(date)}:\n${coachPlainText(reply)}"
        val before = (existing ?: "").trim()
        return if (before.isNotEmpty()) "$before\n\n$kept" else kept
    }

    private val STRICT = Json { isLenient = false }
}
