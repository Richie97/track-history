package app.trackevolution.recording

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.trackevolution.core.LapTime
import app.trackevolution.core.LineReview
import app.trackevolution.core.model.ClipStorage
import app.trackevolution.core.telemetry.LapClips
import app.trackevolution.core.telemetry.ParsedTelemetry
import app.trackevolution.core.telemetry.Telemetry
import app.trackevolution.ui.FormColumn
import app.trackevolution.ui.LocalLayoutMetrics
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEProLocked
import app.trackevolution.ui.TERetryButton
import app.trackevolution.ui.fmtCount
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * Turn a stopped recording — or a selection of imported videos — into sessions:
 * pick the start/finish line where one is needed, check the laps, save.
 *
 * A recording is **not** discarded by arriving here, and is not discarded by
 * leaving: it stays journalled until explicitly saved or discarded, so a crash
 * mid-review costs nothing. That is the same contract the web app has, for the
 * same reason — this is the only copy of a session that has not been uploaded.
 * An import has nothing to protect (the clips are still on the phone), so its
 * "discard" is a plain cancel.
 */
@Composable
fun ReviewScreen(
    state: ReviewUiState,
    onPick: (Int) -> Unit,
    onLabelChange: (Int, String) -> Unit,
    onIncludeChange: (Int, Boolean) -> Unit,
    onNotesChange: (String) -> Unit,
    onSelectEvent: (Int) -> Unit,
    onSave: () -> Unit,
    onDiscard: () -> Unit,
    /**
     * *Save to a new event* (#344), offered in the save button's place when
     * there is no event to save onto. Null hides it.
     */
    onSaveToNewEvent: (() -> Unit)? = null,
    /** Try again, after the events to save onto failed to load. */
    onRetryEvents: () -> Unit = {},
    /**
     * The *Save best-lap video* row's state (NS-45) — `clipOffer` over the
     * items, the tier and the storage, worked out by the caller from the
     * cached `/me`. `NONE` draws no row.
     */
    clipOffer: LapClips.ClipOffer = LapClips.ClipOffer.NONE,
    /** `user.clips`, for the full-storage sentence and the coach note. */
    clipStorage: ClipStorage? = null,
    onSaveClipsChange: (Boolean) -> Unit = {},
    /**
     * The row's Every lap choice (NS-50): `ReviewUiState.everyLapOffer` — `NONE`
     * draws no choice (the row is NS-45's), `ON` an enabled one, `FULL` one
     * drawn disabled with `everyLapFullText`.
     */
    everyLapOffer: LapClips.ClipOffer = LapClips.ClipOffer.NONE,
    /** The scope the choice shows picked: `ReviewUiState.effectiveClipScope`. */
    clipScope: LapClips.ClipScope = LapClips.ClipScope.BEST,
    onClipScopeChange: (LapClips.ClipScope) -> Unit = {},
    /** The locked row's offer: the paywall. */
    onRequirePro: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    var confirmingDiscard by remember { mutableStateOf(false) }
    val anyLaps = state.items.any { it.hasLaps }

    // A best-lap video uploads as a data-sync foreground service (NS-45), and
    // its notification is the only sign the upload is running once the app is
    // left — invisible on API 33+ without POST_NOTIFICATIONS. The recorder asks
    // when recording starts, but someone who only imports would never be asked,
    // so the save that hands a clip to the uploader asks first, in context.
    // The answer gates nothing: the save goes ahead either way. Which button
    // was tapped is saveable, so a recreate while the system dialog is up
    // still saves.
    val context = LocalContext.current
    val currentSave by rememberUpdatedState(onSave)
    val currentSaveToNewEvent by rememberUpdatedState(onSaveToNewEvent)
    var savingAfterAsk by rememberSaveable { mutableStateOf<String?>(null) }
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        when (savingAfterAsk) {
            SAVE -> currentSave()
            SAVE_TO_NEW_EVENT -> currentSaveToNewEvent?.invoke()
        }
        savingAfterAsk = null
    }
    val saveWith: (String, () -> Unit) -> Unit = { which, save ->
        if (ClipNotificationAsk.shouldAsk(
                offer = clipOffer,
                saveClips = state.saveClips,
                sdkInt = Build.VERSION.SDK_INT,
                granted = RecorderPermissions.hasNotifications(context),
            )
        ) {
            savingAfterAsk = which
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            save()
        }
    }

    // How tall to draw the start/finish picker (NS-34).
    //
    // A phone keeps its 280dp exactly. Above compact width the map grows with
    // the column it is in, because a line is picked on a *shape*: `TraceMap.fit`
    // scales uniformly, so a short wide box draws the circuit small against the
    // short side and leaves the rest of the row empty — and the file already
    // notes that the target for a pick is tiny.
    //
    // Bounded by the window's **height** as well as its width, which is not
    // belt-and-braces here: a phone in landscape is an expanded window on this
    // platform — there is no `.compact` size class to say otherwise, which
    // `LayoutClass` records — and two-thirds of 915dp of map in a 412dp-high
    // window would push the session cards and Save off the screen entirely.
    val metrics = LocalLayoutMetrics.current
    val windowHeight = LocalConfiguration.current.screenHeightDp.dp
    val pickerHeight = if (metrics.layoutClass.isCompact) {
        280.dp
    } else {
        minOf(metrics.contentWidth * 0.62f, windowHeight * 0.45f, 420.dp)
            .coerceAtLeast(280.dp)
    }

    // The overlay covers the window — NS-18's rule, and what "the review is
    // modal" actually means — while its *content* keeps a column (NS-34). The
    // background is painted out here, on the covering Box, so the graph
    // underneath never shows through beside a centred form.
    Box(
        modifier
            .fillMaxSize()
            .background(colors.bgPage),
    ) {
        FormColumn {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text(
                    if (state.isImport) "Import preview" else "Review recording",
                    style = type.h1,
                    color = colors.textStrong,
                )

                if (state.needsLinePick) {
                    Text(
                        pickerHint(state),
                        style = type.sm,
                        color = colors.textMuted,
                    )

                    LinePicker(
                        trace = state.pickTrace,
                        gate = state.gate,
                        pickedIndex = state.pickedIndex,
                        onPick = onPick,
                        modifier = Modifier.fillMaxWidth().height(pickerHeight),
                    )

                    // The guidance the spec asks for: never a dead end, and the two dead
                    // ends are different problems with different answers.
                    when (state.problem) {
                        LineReview.Problem.STATIONARY_PICK -> Advice(
                            "The car wasn't moving there, so there's no direction to place a line across. " +
                                "Try a point out on track.",
                        )
                        LineReview.Problem.NO_CROSSINGS -> Advice(
                            "No laps cross the picked line — try a different spot.",
                        )
                        null -> if (state.pickedIndex == null) {
                            Advice("Nothing picked yet.", warning = false)
                        }
                    }
                }

                if (state.items.isEmpty()) {
                    // Nothing came out of it at all — said, rather than a page
                    // with only a disabled Save on it. iOS's card, word for word.
                    TrackCard(Modifier.fillMaxWidth()) {
                        TEEmpty(
                            if (state.isImport) {
                                "None of the files you picked carried telemetry."
                            } else {
                                "This recording is too short to derive laps from — it needs " +
                                    "at least 30 fixes over a minute of driving."
                            },
                            title = if (state.isImport) "Nothing to import" else "Not enough to time",
                        )
                    }
                }

                state.items.forEachIndexed { index, item ->
                    ItemCard(
                        item = item,
                        index = index,
                        state = state,
                        onLabelChange = { onLabelChange(index, it) },
                        onIncludeChange = { onIncludeChange(index, it) },
                    )
                }

                ClipRow(
                    offer = clipOffer,
                    on = state.saveClips,
                    estimateBytes = state.clipEstimateBytes,
                    storage = clipStorage,
                    onChange = onSaveClipsChange,
                    onRequirePro = onRequirePro,
                    everyLapOffer = everyLapOffer,
                    scope = clipScope,
                    everyCount = state.clipCount(LapClips.ClipScope.EVERY),
                    everyBytes = state.clipBytes(LapClips.ClipScope.EVERY),
                    onScopeChange = onClipScopeChange,
                )

                if (anyLaps && state.forNewEvent) {
                    // Started from the New Event form: the event is the one being
                    // typed, so there is nothing to pick.
                    TrackCard {
                        Text("Save to".uppercase(), style = type.eyebrow, color = colors.textFaint)
                        Text(
                            "The event you're creating. These sessions are added to it when you tap Create event.",
                            style = type.sm,
                            color = colors.textMuted,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                } else if (anyLaps) {
                    // Which event this belongs to. A recording can outlive not having
                    // one — Android Auto starts them before the event exists — so the
                    // choice lives here, at save time, rather than at start.
                    TrackCard {
                        Text("Save to".uppercase(), style = type.eyebrow, color = colors.textFaint)
                        val eventsError = state.eventsError
                        if (eventsError != null && state.events.isEmpty()) {
                            Text(
                                eventsError,
                                style = type.sm,
                                color = colors.textMuted,
                                modifier = Modifier.padding(top = 6.dp),
                            )
                            TERetryButton(onClick = onRetryEvents, modifier = Modifier.padding(top = 8.dp))
                        } else if (state.offersNewEvent) {
                            Text(
                                "No events yet. Make one for this and the " +
                                    (if (state.isImport) "sessions are" else "recording is") + " saved with it.",
                                style = type.sm,
                                color = colors.textMuted,
                                modifier = Modifier.padding(top = 6.dp),
                            )
                        }
                        state.events.take(8).forEach { event ->
                            TextButton(
                                onClick = { onSelectEvent(event.id) },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    "${if (event.id == state.selectedEventId) "● " else "○ "}" +
                                        "${event.startDate} · ${event.trackName}",
                                    style = type.sm,
                                    color = if (event.id == state.selectedEventId) {
                                        colors.accentInk
                                    } else {
                                        colors.textMuted
                                    },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                        }
                    }

                    if (!state.isImport) {
                        OutlinedTextField(
                            value = state.notes,
                            onValueChange = onNotesChange,
                            label = { Text("Notes", style = type.sm) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }

                state.error?.let {
                    TrackCard(color = colors.dangerTint, border = colors.danger) {
                        Text(it, style = type.sm, color = colors.dangerInk)
                        Text(
                            if (state.isImport) {
                                "Nothing was lost — the videos are still on this device."
                            } else {
                                "The recording is still here — nothing was lost."
                            },
                            style = type.xs,
                            color = colors.textMuted,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }

                if (state.offersNewEvent && onSaveToNewEvent != null) {
                    // In place of a Save with nowhere to save to (#344).
                    Button(
                        onClick = { saveWith(SAVE_TO_NEW_EVENT, onSaveToNewEvent) },
                        enabled = state.selectedCount > 0,
                        modifier = Modifier.fillMaxWidth().testTag("reviewSaveToNewEvent"),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.accent,
                            contentColor = colors.accentContrast,
                        ),
                    ) {
                        Text("Save to a new event", style = type.bodyStrong)
                    }
                } else {
                    Button(
                        onClick = { saveWith(SAVE, onSave) },
                        enabled = state.canSave,
                        modifier = Modifier.fillMaxWidth().testTag("reviewSave"),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.accent,
                            contentColor = colors.accentContrast,
                        ),
                    ) {
                        if (state.saving) {
                            CircularProgressIndicator(
                                modifier = Modifier.height(18.dp),
                                color = colors.accentContrast,
                            )
                        } else {
                            Text(
                                when {
                                    state.forNewEvent -> "Add to new event"
                                    state.selectedCount > 1 -> "Save ${state.selectedCount} sessions"
                                    else -> "Save session"
                                },
                                style = type.bodyStrong,
                            )
                        }
                    }
                }

                if (state.isImport) {
                    // Nothing to protect: the clips are still where they were.
                    TextButton(onClick = onDiscard, modifier = Modifier.fillMaxWidth()) {
                        Text("Cancel import", style = type.sm, color = colors.textMuted)
                    }
                } else {
                    TextButton(onClick = { confirmingDiscard = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("Discard recording", style = type.sm, color = colors.dangerInk)
                    }
                }
            }
        }
    }

    if (confirmingDiscard) {
        AlertDialog(
            onDismissRequest = { confirmingDiscard = false },
            containerColor = colors.surfaceRaised,
            title = { Text("Discard this recording?", style = type.h3, color = colors.textStrong) },
            text = {
                Text(
                    "It hasn't been saved anywhere else, so this can't be undone.",
                    style = type.sm,
                    color = colors.textBody,
                )
            },
            confirmButton = {
                TextButton(onClick = { confirmingDiscard = false; onDiscard() }) {
                    Text("Discard", color = colors.dangerInk)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingDiscard = false }) {
                    Text("Keep", color = colors.textMuted)
                }
            },
        )
    }
}

/**
 * *Save best-lap video* (NS-45), under the session list. Not drawn without a
 * video to cut (a recording, a `.vbo`, a `.csv`); for a free account it is the
 * Pro offer, **locked in place, never hidden**; with storage full it is off and
 * disabled, saying so; otherwise a switch that starts on every review. The
 * words are `clip.js`'s, pinned by `lap-clips.json`.
 *
 * Since NS-50, when a PDR session has more than one windowed lap
 * ([everyLapOffer] not `NONE`), the row is *Save lap videos* with a Best lap /
 * Every lap choice under the switch — Best lap in every review, Every lap
 * disabled with `everyLapFullText` when it alone would go over the quota. The
 * choice is never drawn locked or full: those rows are NS-45's.
 */
@Composable
private fun ClipRow(
    offer: LapClips.ClipOffer,
    on: Boolean,
    estimateBytes: Long?,
    storage: ClipStorage?,
    onChange: (Boolean) -> Unit,
    onRequirePro: () -> Unit,
    everyLapOffer: LapClips.ClipOffer = LapClips.ClipOffer.NONE,
    scope: LapClips.ClipScope = LapClips.ClipScope.BEST,
    everyCount: Int = 0,
    everyBytes: Long = 0,
    onScopeChange: (LapClips.ClipScope) -> Unit = {},
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    when (offer) {
        LapClips.ClipOffer.NONE -> return
        LapClips.ClipOffer.LOCKED -> TEProLocked(
            title = "Save best-lap video",
            blurb = LapClips.clipOfferText(estimateBytes) +
                " The clip plays on the lap's page, for you and the coaches you invite.",
            onSubscribe = onRequirePro,
            modifier = Modifier.testTag("reviewClipRow"),
        )
        LapClips.ClipOffer.FULL, LapClips.ClipOffer.ON -> {
            val full = offer == LapClips.ClipOffer.FULL
            val checked = on && !full
            val choice = !full && everyLapOffer != LapClips.ClipOffer.NONE
            val every = choice && scope == LapClips.ClipScope.EVERY
            val words = if (full) {
                LapClips.clipFullText(storage)
            } else {
                val lead = if (every) LapClips.everyLapOfferText(everyCount, everyBytes) else LapClips.clipOfferText(estimateBytes)
                listOf(lead, LapClips.clipOfferNote(storage)).filter { it.isNotEmpty() }.joinToString(" ")
            }
            TrackCard(
                Modifier
                    .fillMaxWidth()
                    .testTag("reviewClipRow"),
            ) {
                // The title row is the toggle, so the switch and its words are
                // one target and one TalkBack element; the choice is its own.
                Row(
                    Modifier
                        .testTag("reviewClipToggle")
                        .toggleable(value = checked, enabled = !full, role = Role.Switch, onValueChange = onChange),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(LapClips.clipRowTitle(choice), style = type.bodyStrong, color = colors.textStrong)
                        Text(words, style = type.sm, color = colors.textMuted, modifier = Modifier.padding(top = 4.dp))
                    }
                    Switch(
                        checked = checked,
                        // The card is the toggle, so the whole row is one target
                        // and one TalkBack element.
                        onCheckedChange = null,
                        enabled = !full,
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = colors.accentInk,
                            checkedTrackColor = colors.accentTint,
                        ),
                        modifier = Modifier.padding(start = 12.dp),
                    )
                }
                if (choice) {
                    val everyEnabled = checked && everyLapOffer == LapClips.ClipOffer.ON
                    Row(
                        Modifier
                            .padding(top = 12.dp)
                            .selectableGroup(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        ScopeChip(
                            label = "Best lap",
                            selected = !every,
                            enabled = checked,
                            tag = "reviewClipScopeBest",
                            onClick = { onScopeChange(LapClips.ClipScope.BEST) },
                        )
                        ScopeChip(
                            label = "Every lap",
                            selected = every,
                            enabled = everyEnabled,
                            tag = "reviewClipScopeEvery",
                            onClick = { onScopeChange(LapClips.ClipScope.EVERY) },
                        )
                    }
                    if (everyLapOffer == LapClips.ClipOffer.FULL) {
                        Text(
                            LapClips.everyLapFullText(storage),
                            style = type.sm,
                            color = colors.textMuted,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                }
            }
        }
    }
}

/** One side of the Best lap / Every lap choice — marked by border *and* the selected state, never colour alone. */
@Composable
private fun ScopeChip(label: String, selected: Boolean, enabled: Boolean, tag: String, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    TrackCard(
        modifier = Modifier
            .testTag(tag)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick),
        // Filled with the accent when picked, as the web's pill and iOS's
        // segment are: an outline alone read as two equal chips.
        color = if (selected) colors.accent else null,
        border = if (selected) colors.accent else colors.borderHairline,
        contentPadding = 8.dp,
    ) {
        Text(
            label,
            style = TrackTheme.typography.sm,
            color = when {
                !enabled -> colors.textFaint
                selected -> colors.accentContrast
                else -> colors.textMuted
            },
        )
    }
}

/** What the picker asks for, phrased for what's being reviewed. */
private fun pickerHint(state: ReviewUiState): String {
    val live = state.items.all { it.parsed?.kind == ParsedTelemetry.Kind.LIVE }
    val prefix = if (live) "Your recording has a GPS trace" else "This footage has GPS data but no lap markers"
    return "$prefix. Tap the trace where the start/finish line is — laps are timed each pass across it."
}

/**
 * One reviewed thing: a clip's laps, or the recording's. A clip that yielded no
 * telemetry says so by name rather than vanishing from the list.
 */
@Composable
private fun ItemCard(
    item: ReviewItem,
    index: Int,
    state: ReviewUiState,
    onLabelChange: (String) -> Unit,
    onIncludeChange: (Boolean) -> Unit,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    val parsed = item.parsed

    TrackCard(Modifier.fillMaxWidth().testTag("reviewItem$index")) {
        if (state.isImport) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = item.include && item.hasLaps,
                    enabled = item.hasLaps,
                    onCheckedChange = onIncludeChange,
                    colors = CheckboxDefaults.colors(
                        checkedColor = colors.accent,
                        checkmarkColor = colors.accentInk,
                    ),
                )
                Column(Modifier.weight(1f)) {
                    Text(item.file, style = type.bodyStrong, color = colors.textStrong)
                    parsed?.let {
                        Text(meta(it), style = type.xs, color = colors.textMuted)
                    }
                }
            }
        }

        item.error?.let {
            TEErrorBanner(it, modifier = Modifier.padding(top = 6.dp))
        }
        if (parsed == null) return@TrackCard

        if (item.hasLaps) {
            val bestIndex = item.laps.indices.minByOrNull { item.laps[it].timeMs }
            Text(
                fmtCount(item.laps.size, "lap").uppercase(),
                style = type.eyebrow,
                color = colors.textFaint,
                modifier = Modifier.padding(top = if (state.isImport) 8.dp else 0.dp),
            )
            item.laps.forEachIndexed { i, lap ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Lap ${lap.lapNumber ?: (i + 1)}", style = type.sm, color = colors.textMuted)
                    Text(
                        // `~` marks a lap whose ends were interpolated between
                        // fixes or placed by distance rather than timed by a
                        // beacon — the same signal the web app shows, and it
                        // must survive.
                        (if (lap.estimated) "~" else "") + LapTime.fmtMs(lap.timeMs),
                        style = type.lapTime,
                        color = if (i == bestIndex) colors.accentInk else colors.textStrong,
                    )
                }
            }
        } else if (item.error == null) {
            Text(
                noLapsHint(parsed, state),
                style = type.sm,
                color = colors.textMuted,
                modifier = Modifier.padding(top = 6.dp),
            )
        }

        val metrics = Telemetry.metricsSummary(parsed, LocalUnitSystem.current)
        if (metrics.isNotEmpty()) {
            Text(metrics, style = type.xs, color = colors.textMuted, modifier = Modifier.padding(top = 6.dp))
        }
        val note = Telemetry.estimatedNote(parsed, parsed.laps.count { it.estimated })
        if (note.isNotEmpty()) {
            Text("~ = $note", style = type.xs, color = colors.textMuted, modifier = Modifier.padding(top = 4.dp))
        }

        if (item.hasLaps) {
            OutlinedTextField(
                value = item.label,
                onValueChange = onLabelChange,
                label = { Text("Session label", style = type.sm) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
        }
    }
}

/** "2026-06-20 · 09:15:00 · 3 min" — a clip's own header line. */
private fun meta(parsed: ParsedTelemetry): String = listOfNotNull(
    parsed.date,
    parsed.time,
    "${Math.round(parsed.durationS / 60)} min",
).joinToString(" · ")

/** Why a source shows no laps yet, in the web app's words. */
private fun noLapsHint(parsed: ParsedTelemetry, state: ReviewUiState): String = when {
    parsed.needsLine -> if (state.pickedIndex == null) {
        "${parsed.gps?.size ?: 0} GPS points — set the start/finish line above to time laps."
    } else {
        "No laps cross the picked line — try a different spot."
    }
    parsed.kind == ParsedTelemetry.Kind.PDR && parsed.beaconCount == 0 ->
        "No laps found — no beacons, and the telemetry shows no repeating lap pattern (pit/paddock footage?)."
    else -> "No complete laps found (no start/finish crossings in telemetry)."
}

@Composable
private fun Advice(text: String, warning: Boolean = true) {
    Text(
        text,
        style = TrackTheme.typography.sm,
        color = if (warning) TrackTheme.colors.dangerInk else TrackTheme.colors.textMuted,
    )
}
