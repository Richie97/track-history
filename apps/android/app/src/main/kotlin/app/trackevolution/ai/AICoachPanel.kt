package app.trackevolution.ai

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.trackevolution.core.AICoach
import app.trackevolution.core.AICoach.CoachBlock
import app.trackevolution.ui.PaneWidth
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEProLocked
import app.trackevolution.ui.theme.TrackTheme

/**
 * The AI Coach on Android (#320): an entry point's button, the conversation
 * as a bottom sheet below expanded width and as a side pane at it, and a
 * reply drawn with paragraphs, lists and bold only. Never offered in a
 * read-only view (a student's logbook, a shared item) — the callers decide
 * that — and nothing here is reachable from the recorder or Android Auto: the
 * advice is for the paddock.
 *
 * The sheet is not a route, so it reports no screen view and adds no event.
 */

/**
 * Settings scrolls to its AI Coach block when this is set — a button found no
 * key, the web's `focusAiCoachSettings`. Read once, then cleared.
 */
object AICoachSettingsFocus {
    var pending by mutableStateOf(false)
}

/**
 * What an entry point's tap does: with no key (and no fake provider) it opens
 * Settings' AI Coach block rather than a dead sheet; otherwise the
 * conversation. A free account gets the sheet too — the Pro offer is drawn in it.
 */
fun startAICoach(
    chat: AICoachChat,
    keys: AICoachKeys,
    pro: Boolean,
    opening: AICoachChat.Opening,
    onOpenSettings: () -> Unit,
) {
    if (pro && keys.credential() == null) {
        AICoachSettingsFocus.pending = true
        onOpenSettings()
        return
    }
    chat.open(opening, pro)
}

/** An entry point: the web's words; disabled offline and says why. */
@Composable
fun AICoachButton(
    entry: String,
    offline: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tag: String = "aiCoach-$entry",
) {
    val colors = TrackTheme.colors
    val words = AICoach.COACH_ENTRIES.getValue(entry).button
    TextButton(
        onClick = onClick,
        enabled = !offline,
        modifier = modifier.testTag(tag),
    ) {
        Text(
            if (offline) "$words · ${AICoach.COACH_OFFLINE}" else words,
            style = TrackTheme.typography.sm,
            color = if (offline) colors.textFaint else colors.accentInk,
        )
    }
}

/**
 * Hosts [content] with the conversation beside or over it: at a pane width
 * that gives [sideWidth] the conversation is a column to the right — the
 * charts it talks about stay on screen — and below it a bottom sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AICoachHost(
    chat: AICoachChat,
    sideWidth: Dp?,
    onOpenSettings: () -> Unit,
    onSubscribe: () -> Unit,
    onSignedOut: () -> Unit = {},
    content: @Composable () -> Unit,
) {
    LaunchedEffect(chat.signedOut) { if (chat.signedOut) { chat.close(); onSignedOut() } }
    val open = chat.opening != null
    if (open && sideWidth != null) {
        Row(Modifier.fillMaxSize()) {
            PaneWidth(Modifier.weight(1f)) { content() }
            VerticalDivider(color = TrackTheme.colors.borderHairline)
            PaneWidth(Modifier.width(sideWidth)) {
                AICoachPanel(chat, onOpenSettings, onSubscribe, Modifier.fillMaxHeight())
            }
        }
    } else {
        content()
        if (open) {
            ModalBottomSheet(
                onDismissRequest = chat::close,
                sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
                containerColor = TrackTheme.colors.surfaceRaised,
                modifier = Modifier.testTag("aiCoachSheet"),
            ) {
                AICoachPanel(chat, onOpenSettings, onSubscribe, Modifier.fillMaxHeight(0.92f))
            }
        }
    }
}

/** The conversation: header, turns, the follow-up box and the footer. */
@Composable
fun AICoachPanel(
    chat: AICoachChat,
    onOpenSettings: () -> Unit,
    onSubscribe: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    val opening = chat.opening ?: return
    val listState = rememberLazyListState()
    val last = chat.turns.lastOrNull()
    // Follow the reply as it streams.
    LaunchedEffect(chat.turns.size, last?.reply?.length, last?.state) {
        if (chat.turns.isNotEmpty()) listState.animateScrollToItem(chat.turns.size - 1, Int.MAX_VALUE / 2)
    }
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("aiCoachPanel")) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
            Column(Modifier.weight(1f)) {
                Text(AICoach.COACH_NAME, style = type.h3, color = colors.textStrong)
                Text(opening.subtitle, style = type.xs, color = colors.textMuted)
            }
            TextButton(
                onClick = chat::close,
                modifier = Modifier.testTag("aiCoachClose").semantics { contentDescription = "Close the ${AICoach.COACH_NAME}" },
            ) {
                Text("✕", style = type.body, color = colors.textMuted)
            }
        }
        if (chat.paywall) {
            // A 402 is an offer, not an error: the paywall, in place.
            TEProLocked(title = AICoach.COACH_NAME, blurb = AICoach.COACH_PRO_WHAT, onSubscribe = onSubscribe)
            return@Column
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f, fill = true).fillMaxWidth().testTag("aiCoachLog"),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            itemsIndexed(chat.turns, key = { i, t -> "${i}-${t.question.hashCode()}" }) { _, turn ->
                TurnView(chat, turn, onOpenSettings)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
            OutlinedTextField(
                value = chat.draft,
                onValueChange = { chat.draft = it.take(4000) },
                placeholder = { Text("Ask a follow-up…", style = type.sm) },
                modifier = Modifier.weight(1f).testTag("aiCoachAsk"),
                maxLines = 4,
                textStyle = type.sm,
            )
            Button(
                onClick = chat::send,
                enabled = !chat.busy && chat.draft.isNotBlank(),
                modifier = Modifier.padding(start = 8.dp).testTag("aiCoachSend"),
                colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentContrast),
            ) {
                Text("Send", style = type.bodyStrong)
            }
        }
        Text(
            "Runs on your ${chat.providerName} account. ${AICoach.COACH_DISCLAIMER}",
            style = type.xxs,
            color = colors.textFaint,
            modifier = Modifier.padding(top = 6.dp, bottom = 12.dp),
        )
    }
}

@Composable
private fun TurnView(chat: AICoachChat, turn: AICoachChat.Turn, onOpenSettings: () -> Unit) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(turn.question, style = type.bodyStrong, color = colors.textStrong)
        turn.progress?.let {
            Text(
                it,
                style = type.xs,
                color = colors.textMuted,
                modifier = Modifier.testTag("aiCoachProgress").semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        if (turn.reply.isNotEmpty()) AICoachReply(turn.reply, Modifier.testTag("aiCoachReply"))
        when (val state = turn.state) {
            AICoachChat.TurnState.Streaming -> Unit
            AICoachChat.TurnState.Empty ->
                Text("The ${AICoach.COACH_NAME} had nothing to add.", style = type.sm, color = colors.textMuted)
            is AICoachChat.TurnState.Answered -> {
                state.message?.let { Text(it, style = type.xs, color = colors.textMuted, modifier = Modifier.testTag("aiCoachStop")) }
                if (turn.reply.isNotBlank()) SaveRow(chat, turn)
            }
            is AICoachChat.TurnState.Failed -> {
                TEErrorBanner(state.message, Modifier.testTag("aiCoachError"))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { chat.retry(turn) }, modifier = Modifier.testTag("aiCoachRetry")) {
                        Text("Try again", style = type.sm, color = colors.accentInk)
                    }
                    if (state.toSettings) {
                        TextButton(
                            onClick = {
                                AICoachSettingsFocus.pending = true
                                chat.close()
                                onOpenSettings()
                            },
                            modifier = Modifier.testTag("aiCoachSettings"),
                        ) {
                            Text("Open Settings", style = type.sm, color = colors.textMuted)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SaveRow(chat: AICoachChat, turn: AICoachChat.Turn) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    val entry = chat.opening?.entry ?: return
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(
            onClick = { chat.save(turn) },
            enabled = !turn.saving && turn.saved == null,
            modifier = Modifier.testTag("aiCoachSave"),
        ) {
            Text(AICoach.coachSaveLabel(entry), style = type.sm, color = colors.accentInk)
        }
        (turn.saved ?: turn.saveError)?.let {
            Text(it, style = type.xs, color = if (turn.saved != null) colors.textMuted else colors.danger)
        }
    }
}

/**
 * A reply: paragraphs, bulleted and numbered lists, bold — from `:core`'s
 * `coachMarkdownBlocks` / `coachBoldRuns`, the web's subset. Everything else is
 * the plain text it is: no link is ever made clickable, nothing is markup.
 */
@Composable
fun AICoachReply(text: String, modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (block in AICoach.coachMarkdownBlocks(text)) {
            when (block) {
                is CoachBlock.Paragraph ->
                    Text(bold(block.lines.joinToString("\n")), style = type.sm, color = colors.textBody)
                is CoachBlock.Heading ->
                    Text(block.text, style = type.bodyStrong, color = colors.textStrong)
                is CoachBlock.ListBlock -> ListItems(block)
            }
        }
    }
}

@Composable
private fun ColumnScope.ListItems(block: CoachBlock.ListBlock) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        block.items.forEachIndexed { i, item ->
            Row {
                Text(
                    if (block.ordered) "${i + 1}." else "•",
                    style = type.sm,
                    color = colors.textMuted,
                    modifier = Modifier.width(22.dp),
                )
                Text(bold(item), style = type.sm, color = colors.textBody, modifier = Modifier.weight(1f))
            }
        }
    }
}

/** A line with its bold runs — the one inline mark. */
private fun bold(line: String): AnnotatedString = buildAnnotatedString {
    for (run in AICoach.coachBoldRuns(line)) {
        if (run.bold) withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(run.text) } else append(run.text)
    }
}

/**
 * What a page needs to offer the AI Coach: its conversation, the keys, the
 * tier, and where Settings, the paywall and a lost session go. A page is handed
 * one only when the AI Coach may be offered there — never for a read-only view
 * and never while a recording is live — so "null draws nothing" is the rule
 * every entry point follows.
 */
class AICoachAccess(
    val chat: AICoachChat,
    val keys: AICoachKeys,
    val pro: Boolean,
    val onOpenSettings: () -> Unit,
    val onSubscribe: () -> Unit,
    val onSignedOut: () -> Unit,
) {
    fun start(opening: AICoachChat.Opening) = startAICoach(chat, keys, pro, opening, onOpenSettings)
}

/** [AICoachHost] for a page that may have no AI Coach. */
@Composable
fun AICoachHost(access: AICoachAccess?, sideWidth: Dp?, content: @Composable () -> Unit) {
    if (access == null) {
        content()
        return
    }
    AICoachHost(access.chat, sideWidth, access.onOpenSettings, access.onSubscribe, access.onSignedOut, content)
}
