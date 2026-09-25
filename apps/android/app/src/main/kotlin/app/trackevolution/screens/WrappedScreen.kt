package app.trackevolution.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.trackevolution.core.LapTime
import app.trackevolution.core.SessionConditions
import app.trackevolution.core.Units
import app.trackevolution.core.WrappedStory
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.model.Wrapped
import app.trackevolution.navigation.shareLink
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Season Wrapped (NS-36): the season handed back as a story of full-screen
 * cards — the port of `viewWrapped` in `public/app.js` and
 * `public/js/wrapped-story.js`, and of iOS's `WrappedScreen`.
 *
 * The numbers are the server's and the card rules are `:core`'s [WrappedStory],
 * pinned to the web by `contracts/logic/wrapped.json`; what lives here is only
 * the layout, the navigation and the share image. A plain `composable`
 * destination that **owns the window**: the scaffold drops to one pane for it,
 * as it does for the recorder, because a story is a thing you do instead of
 * reading the logbook.
 */
@Composable
fun WrappedScreen(
    model: WrappedModel,
    /** The season's public page, when the account has a share slug. */
    shareUrlFor: (Int) -> String?,
    onClose: () -> Unit,
    onSubscribe: () -> Unit,
) {
    val colors = TrackTheme.colors
    LaunchedEffect(Unit) { if (model.phase == WrappedModel.Phase.Loading) model.load() }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.bgPage)
            .background(
                Brush.radialGradient(
                    colors = listOf(colors.accentTint, Color.Transparent),
                    center = androidx.compose.ui.geometry.Offset(Float.POSITIVE_INFINITY, 0f),
                    radius = 1400f,
                ),
            )
            .safeDrawingPadding(),
    ) {
        when (val phase = model.phase) {
            WrappedModel.Phase.Loading -> CircularProgressIndicator(
                color = colors.accent,
                modifier = Modifier.align(Alignment.Center),
            )
            is WrappedModel.Phase.Failed -> Column(Modifier.padding(24.dp).align(Alignment.Center)) {
                Text(phase.message, style = TrackTheme.typography.body, color = colors.textStrong)
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = { model.load() }) { Text("Try again") }
            }
            WrappedModel.Phase.Empty -> Column(Modifier.padding(24.dp).align(Alignment.Center)) {
                Text(
                    "No track days in ${model.year} — yet",
                    style = TrackTheme.typography.h1,
                    color = colors.textStrong,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "Wrapped tells the story of a season once there's a track day in it.",
                    style = TrackTheme.typography.body,
                    color = colors.textMuted,
                )
            }
            // Centred and capped at the web's 520–560: a story is a phone-shaped
            // thing, and on a tablet it stays one down the middle.
            is WrappedModel.Phase.Ready -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                WrappedStoryView(
                    data = phase.data,
                    index = model.index,
                    onIndex = { model.index = it },
                    shareUrl = shareUrlFor(phase.data.year),
                    onYear = { model.load(it) },
                    onSubscribe = onSubscribe,
                )
            }
        }
        IconButton(
            onClick = onClose,
            modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).semantics { testTag = "wrappedClose" },
        ) {
            Text("✕", style = TrackTheme.typography.h3, color = colors.textMuted, modifier = Modifier.semantics { contentDescription = "Close Wrapped" })
        }
    }
}

/**
 * One card at a time, in [WrappedStory.wrappedCards]' order. Navigation is a
 * tap on the left or right third, a horizontal swipe, the arrow buttons or the
 * progress segments, which are buttons; TalkBack gets the same as named custom
 * actions, and the card in view is a polite live region. The slide follows the
 * system animator scale, so "Remove animations" makes it a cut.
 */
@Composable
fun WrappedStoryView(
    data: Wrapped,
    index: Int,
    onIndex: (Int) -> Unit,
    shareUrl: String?,
    onYear: (Int) -> Unit = {},
    onSubscribe: () -> Unit = {},
) {
    val colors = TrackTheme.colors
    val cards = WrappedStory.wrappedCards(data)
    val current = index.coerceIn(0, cards.lastIndex)
    val go: (Int) -> Unit = { i -> onIndex(i.coerceIn(0, cards.lastIndex)) }
    // The gesture detectors outlive a recomposition (they are keyed on the card
    // count), so they read the card in view through this rather than capturing it.
    val latest by rememberUpdatedState(current)
    val title = { i: Int -> WrappedStory.CARD_TITLES[cards[i].kind].orEmpty() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .widthIn(max = 560.dp)
            .padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 12.dp),
    ) {
        // The progress bar, a segment per card. Leaves room on the right for the close button.
        Row(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.fillMaxWidth().padding(end = 44.dp, top = 14.dp),
        ) {
            cards.forEachIndexed { i, _ ->
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clickable { go(i) }
                        .padding(vertical = 10.dp)
                        .semantics {
                            contentDescription = "Card ${i + 1}: ${title(i)}"
                            selected = i == current
                        },
                ) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(4.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(if (i <= current) colors.accent else colors.borderStrong),
                    )
                }
            }
        }

        BoxWithConstraints(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .pointerInput(cards.size) {
                    detectTapGestures { offset ->
                        val w = size.width
                        if (offset.x < w / 3f) go(latest - 1) else if (offset.x > w * 2 / 3f) go(latest + 1)
                    }
                }
                .pointerInput(cards.size) {
                    var dx = 0f
                    detectHorizontalDragGestures(
                        onDragStart = { dx = 0f },
                        onDragEnd = { if (kotlin.math.abs(dx) > 120f) go(latest + if (dx < 0) 1 else -1) },
                        onHorizontalDrag = { _, amount -> dx += amount },
                    )
                }
                .semantics {
                    contentDescription = "${current + 1} of ${cards.size}: ${title(current)}"
                    liveRegion = LiveRegionMode.Polite
                    customActions = listOf(
                        CustomAccessibilityAction("Next card") { go(current + 1); true },
                        CustomAccessibilityAction("Previous card") { go(current - 1); true },
                    )
                },
        ) {
            AnimatedContent(
                targetState = current,
                transitionSpec = {
                    val forward = targetState > initialState
                    (slideInHorizontally(tween(280)) { w -> if (forward) w / 4 else -w / 4 } + fadeIn(tween(280)))
                        .togetherWith(fadeOut(tween(160)))
                },
                label = "wrappedCard",
            ) { i ->
                WrappedCard(
                    card = cards[i],
                    data = data,
                    shareUrl = shareUrl,
                    onYear = onYear,
                    onSubscribe = onSubscribe,
                )
            }
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            StepButton("←", "Previous card", enabled = current > 0) { go(current - 1) }
            StepButton("→", "Next card", enabled = current < cards.lastIndex) {
                go(current + 1)
            }
        }
    }
}

@Composable
private fun StepButton(glyph: String, label: String, enabled: Boolean, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    IconButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier
            .size(48.dp)
            .border(1.dp, colors.borderHairline, CircleShape)
            .background(colors.surfaceCard, CircleShape)
            .semantics { contentDescription = label },
    ) {
        Text(glyph, style = TrackTheme.typography.h3, color = if (enabled) colors.textStrong else colors.textFaint)
    }
}

// ---- the cards ---------------------------------------------------------------

/** "Jul 19" — the story names days without the weekday. */
internal fun wrappedDay(iso: String): String = runCatching {
    LocalDate.parse(iso).format(DateTimeFormatter.ofPattern("MMM d", Locale.US))
}.getOrDefault(iso)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WrappedCard(
    card: WrappedStory.Card,
    data: Wrapped,
    shareUrl: String?,
    onYear: (Int) -> Unit,
    onSubscribe: () -> Unit,
) {
    val units = LocalUnitSystem.current
    val colors = TrackTheme.colors
    val t = data.totals
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        when (card.kind) {
            WrappedStory.Kind.COVER -> {
                Kicker("Track Evolution · Wrapped")
                Huge("Your ${data.year}", accent = false)
                Lede("Your season on track, handed back to you.")
                data.through?.let { Foot("So far — through ${wrappedDay(it)}.") }
                if (data.years.size > 1) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.padding(top = 26.dp),
                    ) {
                        data.years.forEach { y ->
                            val selected = y == data.year
                            Button(
                                onClick = { if (!selected) onYear(y) },
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = if (selected) colors.accent else colors.surfaceCard,
                                    contentColor = if (selected) colors.accentContrast else colors.textBody,
                                ),
                                border = if (selected) null else BorderStroke(1.dp, colors.borderHairline),
                                modifier = Modifier.semantics { this.selected = selected },
                            ) { Text(y.toString(), style = TrackTheme.typography.sm) }
                        }
                    }
                }
            }
            WrappedStory.Kind.NUMBERS -> {
                Kicker("The numbers")
                val dist = WrappedStory.trackDistance(t.miles, units)
                val cells = buildList {
                    add(WrappedStory.fmtDays(t.trackDays) to WrappedStory.plural(t.trackDays, "track day"))
                    add(WrappedStory.int(t.tracks.toDouble()) to WrappedStory.plural(t.tracks.toDouble(), "track"))
                    add(WrappedStory.int(t.laps.toDouble()) to WrappedStory.plural(t.laps.toDouble(), "lap"))
                    if (t.milesTracksCounted != 0) add(dist.value to dist.unit)
                }
                Spacer(Modifier.height(22.dp))
                cells.chunked(2).forEach { row ->
                    Row(Modifier.fillMaxWidth().padding(bottom = 22.dp)) {
                        row.forEach { (value, label) ->
                            Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}) {
                                Text(
                                    value,
                                    fontSize = 48.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    color = colors.accentInk,
                                    maxLines = 1,
                                    style = TrackTheme.typography.hero,
                                )
                                Text(label, style = TrackTheme.typography.sm, color = colors.textMuted)
                            }
                        }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
                if (t.milesTracksCounted != 0 && t.milesTracksCounted < t.tracks) {
                    Foot("Distance across ${t.milesTracksCounted} of ${t.tracks} tracks — the ones whose lap length we know.")
                } else {
                    Foot("${WrappedStory.int(t.events.toDouble())} ${WrappedStory.plural(t.events.toDouble(), "event")} in the logbook.")
                }
            }
            WrappedStory.Kind.MOST_DRIVEN -> data.mostDriven?.let { m ->
                Kicker("Most driven")
                Lede("You kept coming back to")
                Big(m.trackName)
                Line(
                    "${WrappedStory.fmtDays(m.trackDays)} ${WrappedStory.plural(m.trackDays, "day")}",
                    "${WrappedStory.int(m.laps.toDouble())} ${WrappedStory.plural(m.laps.toDouble(), "lap")}",
                    m.bestMs?.let { "best ${LapTime.fmtMs(it)}" },
                )
            }
            WrappedStory.Kind.IMPROVEMENT -> data.improvement?.let { g ->
                val first = g.baseline == "first_event"
                Kicker("Biggest improvement")
                Lede(if (first) "A first year at ${g.trackName} — and you found" else "At ${g.trackName}, you found")
                Huge(WrappedStory.fmtGain(g.gainMs), accent = true)
                Line("${LapTime.fmtMs(g.bestBefore)} → ${LapTime.fmtMs(g.bestThisYear)}")
                Foot(
                    if (first) "From the first timed day there this year to the best."
                    else "Against the best from every year before ${data.year}.",
                )
            }
            WrappedStory.Kind.FASTEST -> data.fastest?.let { f ->
                Kicker("Fastest lap")
                Huge(LapTime.fmtMs(f.bestMs), accent = true)
                Line(f.trackName, wrappedDay(f.date))
            }
            WrappedStory.Kind.NEW_TRACKS -> {
                Kicker("New tracks")
                Lede("First time at")
                Spacer(Modifier.height(14.dp))
                data.newTracks.forEach { track ->
                    Text(
                        track.trackName,
                        fontSize = 26.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textStrong,
                        style = TrackTheme.typography.h1,
                        modifier = Modifier.padding(vertical = 6.dp),
                    )
                }
            }
            WrappedStory.Kind.HOURS -> {
                Kicker("Hours behind the wheel")
                Huge(WrappedStory.fmtHoursWord(t.hours), accent = true)
                Line("${WrappedStory.plural(t.hours, "hour")} on track")
                Foot("Two hours a track day, or the logged lap time when that's more.")
            }
            WrappedStory.Kind.HOTTEST -> data.hottest?.let { h ->
                Kicker("Hottest day")
                Huge(SessionConditions.tempText(h.tempC, Units.usUnits(units)), accent = true)
                Line(h.trackName, wrappedDay(h.date))
            }
            WrappedStory.Kind.TIRE -> when {
                card.locked -> Locked(
                    "Favorite tire",
                    "The tire with the most track days on it this year, from your garage.",
                    onSubscribe,
                )
                else -> data.pro?.tire?.let { tire ->
                    Kicker("Favorite tire")
                    Lede("The rubber you lived on")
                    Big(tire.name)
                    Line(
                        "${WrappedStory.fmtDays(tire.trackDays)} ${WrappedStory.plural(tire.trackDays, "track day")}",
                        tire.vehicleName,
                    )
                }
            }
            WrappedStory.Kind.TOP_SPEED -> when {
                card.locked -> Locked(
                    "Top speed",
                    "The fastest your telemetry ever saw you go this year, and where.",
                    onSubscribe,
                )
                else -> data.pro?.topSpeed?.let { top ->
                    Kicker("Top speed")
                    Huge(Units.fmtSpeedKph(top.kph, units), accent = true)
                    Line(top.trackName, wrappedDay(top.date))
                }
            }
            WrappedStory.Kind.POSTER -> {
                PosterCard(data, units)
                Spacer(Modifier.height(16.dp))
                ShareButtons(data, units, shareUrl)
            }
        }
    }
}

@Composable
private fun Kicker(text: String) {
    Text(
        text.uppercase(Locale.US),
        style = TrackTheme.typography.eyebrow,
        color = TrackTheme.colors.accentInk,
        modifier = Modifier.semantics { heading() },
    )
}

@Composable
private fun Huge(text: String, accent: Boolean) {
    Text(
        text,
        style = TrackTheme.typography.hero,
        fontSize = 68.sp,
        lineHeight = 72.sp,
        fontWeight = FontWeight.SemiBold,
        color = if (accent) TrackTheme.colors.accentInk else TrackTheme.colors.textStrong,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(top = 14.dp, bottom = 6.dp),
    )
}

@Composable
private fun Big(text: String) {
    Text(
        text,
        style = TrackTheme.typography.h1,
        fontSize = 34.sp,
        lineHeight = 38.sp,
        color = TrackTheme.colors.textStrong,
        modifier = Modifier.padding(vertical = 8.dp),
    )
}

@Composable
private fun Lede(text: String) {
    Text(
        text,
        style = TrackTheme.typography.body,
        fontSize = 19.sp,
        color = TrackTheme.colors.textBody,
        modifier = Modifier.padding(top = 14.dp),
    )
}

@Composable
private fun Line(vararg parts: String?) {
    Text(
        parts.filterNotNull().joinToString(" · "),
        style = TrackTheme.typography.body,
        fontSize = 17.sp,
        color = TrackTheme.colors.textBody,
        modifier = Modifier.padding(top = 10.dp),
    )
}

@Composable
private fun Foot(text: String) {
    Text(
        text,
        style = TrackTheme.typography.sm,
        color = TrackTheme.colors.textMuted,
        modifier = Modifier.padding(top = 22.dp),
    )
}

/** A Pro card on a free account: its shape, what it would show, and the paywall behind a button. */
@Composable
private fun ColumnScope.Locked(title: String, what: String, onSubscribe: () -> Unit) {
    val colors = TrackTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Kicker(title)
        Text(
            "PRO",
            style = TrackTheme.typography.xxs,
            color = colors.accentContrast,
            modifier = Modifier.background(colors.accent, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
    Text(
        "•••",
        fontSize = 60.sp,
        color = colors.borderStrong,
        modifier = Modifier.padding(vertical = 12.dp).semantics { contentDescription = "" },
    )
    Text(what, style = TrackTheme.typography.body, fontSize = 17.sp, color = colors.textBody)
    Spacer(Modifier.height(16.dp))
    Button(
        onClick = onSubscribe,
        colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentContrast),
        modifier = Modifier.semantics { testTag = "wrappedProUpsell" },
    ) { Text("See Track Evolution Pro", style = TrackTheme.typography.bodyStrong) }
    Text(
        "Wrapped itself is free.",
        style = TrackTheme.typography.xs,
        color = colors.textMuted,
        modifier = Modifier.padding(top = 8.dp),
    )
}

/** The summary card — [WrappedStory.posterLines], drawn as the web's `.wr-poster`. */
@Composable
private fun PosterCard(data: Wrapped, units: UnitSystem) {
    val colors = TrackTheme.colors
    val p = WrappedStory.posterLines(data, units)
    val shape = RoundedCornerShape(20.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(colors.surfaceCard)
            .border(1.dp, colors.borderHairline, shape),
    ) {
        Box(Modifier.fillMaxWidth().height(3.dp).background(colors.accent))
        Column(Modifier.padding(horizontal = 20.dp, vertical = 20.dp)) {
            Text(p.title, style = TrackTheme.typography.h1, fontSize = 22.sp, color = colors.textStrong)
            Text(
                p.headline.joinToString(" · "),
                style = TrackTheme.typography.bodyStrong,
                color = colors.accentInk,
                modifier = Modifier.padding(top = 8.dp, bottom = 16.dp),
            )
            p.rows.forEach { (label, value) ->
                Column(Modifier.padding(bottom = 10.dp).semantics(mergeDescendants = true) {}) {
                    Text(label, style = TrackTheme.typography.sm, color = colors.textMuted)
                    Text(value, style = TrackTheme.typography.sm, color = colors.textStrong)
                }
            }
            Text(
                "trackevolution.app",
                style = TrackTheme.typography.xs,
                color = colors.textFaint,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
    }
}

@Composable
private fun ShareButtons(data: Wrapped, units: UnitSystem, shareUrl: String?) {
    val colors = TrackTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val dark = TrackTheme.isDark
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Button(
            onClick = { scope.launch { WrappedPoster.share(context, data, units, dark, wide = false) } },
            colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentContrast),
            modifier = Modifier.fillMaxWidth().semantics { testTag = "wrappedShareImage" },
        ) { Text("Share image", style = TrackTheme.typography.bodyStrong) }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(
                onClick = { scope.launch { WrappedPoster.share(context, data, units, dark, wide = true) } },
                border = BorderStroke(1.dp, colors.borderHairline),
                modifier = Modifier.weight(1f),
            ) { Text("Share wide", color = colors.textBody) }
            if (shareUrl != null) {
                OutlinedButton(
                    onClick = { shareLink(context, shareUrl) },
                    border = BorderStroke(1.dp, colors.borderHairline),
                    modifier = Modifier.weight(1f),
                ) { Text("Share link", color = colors.textBody) }
            }
        }
        if (shareUrl == null) {
            Text(
                "Want a link to post instead? Create a share link in Settings and this season gets a page of its own.",
                style = TrackTheme.typography.xs,
                color = colors.textMuted,
            )
        }
    }
}
