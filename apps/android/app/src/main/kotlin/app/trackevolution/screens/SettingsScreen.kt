package app.trackevolution.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.background
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import app.trackevolution.BuildConfig
import app.trackevolution.ai.AICoachSettingsCard
import app.trackevolution.ai.AICoachSettingsFocus
import app.trackevolution.ai.AICoachSettingsState
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.rememberLazyListState
import app.trackevolution.clips.LocalClipStatus
import app.trackevolution.push.CommentNotificationsCard
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.Garage
import app.trackevolution.core.Units
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.telemetry.LapClips
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.TEConfirmDialog
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEField
import app.trackevolution.ui.TELoadable
import app.trackevolution.youtube.LocalYouTube
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.launch

/** Where the legal pages live. The app links out; it does not embed them. */
private const val DOCS_URL = "https://docs.trackevolution.app"

/**
 * Account, theme, units, the public share link, the prep list, the garage's
 * cars, and the legal pages (NS-26).
 *
 * **Privacy and terms are required on every platform.** The web app carries them
 * in Settings and in the footer of signed-out and share pages; a native app
 * renders no footer at all, so this screen is the only place they can be — which
 * is why they are not tucked behind an "About" tap.
 *
 * Share-link management lives here rather than on the dashboard, where the web
 * app puts it: on a phone, settings is where it is looked for, and the dashboard
 * is long enough already.
 */
@Composable
fun SettingsScreen(
    model: SettingsModel,
    checklistTemplate: List<String>,
    hasCustomChecklistTemplate: Boolean,
    themeChoice: ThemeChoice,
    onThemeChange: (ThemeChoice) -> Unit,
    serverUrl: String,
    onOpenLink: (String) -> Unit,
    onShare: (String) -> Unit,
    onSignOut: () -> Unit,
    /** The account's tier, as the server last said it (NS-32). */
    entitlement: Entitlement = Entitlement.FREE,
    /** Opens the paywall sheet. */
    onSubscribe: () -> Unit = {},
    /** Share with a coach (NS-38): its own page, one row here. */
    onOpenCoaching: () -> Unit = {},
    /** *Your first track day*, in the app's own web view. */
    onOpenTrackDaysGuide: () -> Unit = {},
    /**
     * Settings → AI assistants → AI Coach (#320): the provider keys, held by
     * this destination. Null draws no AI section (a test that doesn't care).
     */
    aiCoach: AICoachSettingsState? = null,
    /** Debug builds on a dev server: offer the server's fake AI provider. */
    offerFakeAICoach: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    var confirmSignOut by remember { mutableStateOf(false) }
    var confirmDisableShare by remember { mutableStateOf(false) }

    val youtubeAccount by LocalYouTube.current.account.collectAsState()
    val youtubeAvailable = youtubeAccount?.available == true

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    // A 401 from checking a key: the app session is gone, as everywhere.
    LaunchedEffect(aiCoach?.signedOut) { if (aiCoach?.signedOut == true) onSignOut() }
    val listState = rememberLazyListState()
    // A button found no AI Coach key: bring its block into view, once.
    LaunchedEffect(AICoachSettingsFocus.pending, model.state, aiCoach) {
        if (!AICoachSettingsFocus.pending || aiCoach == null || model.state != LoadState.Ready) return@LaunchedEffect
        AICoachSettingsFocus.pending = false
        // Lazy items have no scroll-to-key: walk forward until the block is laid out.
        while (listState.layoutInfo.visibleItemsInfo.none { it.key == "ai-header" } && listState.canScrollForward) {
            listState.scrollBy(600f)
        }
        listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == "ai-header" }?.let { listState.animateScrollToItem(it.index) }
    }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("title") {
                Text("Settings", style = TrackTheme.typography.h1, color = colors.textStrong)
            }

            item("account") { AccountCard(model, serverUrl) }

            item("subscription-header") { TESectionHeader("Subscription") }
            item("subscription") {
                SubscriptionCard(entitlement = entitlement, onSubscribe = onSubscribe, onOpenLink = onOpenLink)
            }

            item("appearance-header") { TESectionHeader("Appearance") }
            item("appearance") { ThemeCard(themeChoice, onThemeChange) }

            item("units-header") { TESectionHeader("Units") }
            item("units") { UnitsCard(model) }

            item("share-header") { TESectionHeader("Share your history") }
            item("share") {
                ShareCard(
                    model = model,
                    serverUrl = serverUrl,
                    onShare = onShare,
                    onOpenLink = onOpenLink,
                    onDisable = { confirmDisableShare = true },
                )
            }

            item("leaderboards-header") { TESectionHeader("Leaderboards") }
            item("leaderboards") { LeaderboardOptInCard(model) }

            item("checklist-header") { TESectionHeader("Prep checklist") }
            item("checklist") {
                ChecklistTemplateCard(model, checklistTemplate, hasCustomChecklistTemplate)
            }


            item("lap-videos-header") { TESectionHeader("Lap videos") }
            item("lap-videos") { LapVideosCard(LapClips.clipStorageLine(model.user?.clips)) }
            // Beside the cellular switch: both are this phone's, not the account's.
            // Settings → YouTube (NS-46): only while the feature is on for this
            // account, header and all.
            if (youtubeAvailable) {
                item("youtube-header") { TESectionHeader("YouTube") }
                item("youtube") { YouTubeSettingsCard(onOpenLink) }
            }

            item("comment-notifications") { CommentNotificationsCard() }

            item("coaching-header") { TESectionHeader("Coaching") }
            item("coaching") {
                // The shared count (NS-52) once any screen has read the feed —
                // it follows a thread being read — else `/me`'s.
                val feed by CommentsBadge.feed.collectAsState()
                CoachingCard(onOpenCoaching, unread = feed?.unread ?: model.user?.commentsUnread ?: 0)
            }

            // AI assistants (#320): the AI Coach's keys, apart from Coaching —
            // a bare "coach" is a person in this app.
            if (aiCoach != null) {
                item("ai-header") { TESectionHeader("AI assistants") }
                item("ai-coach") {
                    AICoachSettingsCard(
                        state = aiCoach,
                        pro = Entitlement.canUseAICoach(entitlement),
                        onSubscribe = onSubscribe,
                        onOpenLink = onOpenLink,
                        offerFake = offerFakeAICoach,
                    )
                }
            }

            item("track-days-header") { TESectionHeader("New to track days?") }
            item("track-days") { TrackDaysCard(onOpenTrackDaysGuide) }

            item("legal-header") { TESectionHeader("About & legal") }
            item("legal") { LegalCard(onOpenLink) }

            item("sign-out") {
                Button(
                    onClick = { confirmSignOut = true },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.dangerTint,
                        contentColor = colors.dangerInk,
                    ),
                ) {
                    Text("Sign out", style = TrackTheme.typography.bodyStrong)
                }
            }
        }
    }

    if (confirmSignOut) {
        TEConfirmDialog(
            text = if (model.pendingWrites > 0) {
                "You have ${model.pendingWrites} change${if (model.pendingWrites == 1) "" else "s"} " +
                    "that haven't synced yet — signing out discards them."
            } else {
                "Sign out of Track Evolution?"
            },
            confirm = "Sign out",
            onConfirm = { confirmSignOut = false; onSignOut() },
            onDismiss = { confirmSignOut = false },
        )
    }

    if (confirmDisableShare) {
        TEConfirmDialog(
            text = "Disable your public share link? The URL will stop working.",
            confirm = "Disable link",
            onConfirm = { confirmDisableShare = false; model.disableShare() },
            onDismiss = { confirmDisableShare = false },
        )
    }

}

@Composable
private fun AccountCard(model: SettingsModel, serverUrl: String) {
    val colors = TrackTheme.colors
    val user = model.user
    TrackCard(Modifier.fillMaxWidth()) {
        Text(
            user?.name ?: user?.email ?: "Signed in",
            style = TrackTheme.typography.h3,
            color = colors.textStrong,
        )
        if (user?.name != null && user.email.isNotBlank()) {
            Text(user.email, style = TrackTheme.typography.xs, color = colors.textMuted)
        }
        // Shown only when it isn't the hosted app — a debug build pointed at a
        // LAN server looks identical otherwise, which is the one case worth
        // knowing about.
        if (serverUrl.trimEnd('/') != ApiClient.DEFAULT_BASE_URL.trimEnd('/')) {
            Text(
                "Server: ${serverUrl.substringAfter("://").trimEnd('/')}",
                style = TrackTheme.typography.xxs,
                color = colors.textFaint,
            )
        }
    }
}

/**
 * Tier and source, and the one action that fits it (NS-32 phase C): Subscribe
 * when free, Manage when a store sold it, nothing for a legacy grant — there is
 * no subscription behind it to manage. The wording comes from `:core`'s
 * `entitlementSummary`, pinned to the web's by `contracts/logic/entitlement.json`;
 * only the date is formatted here, in the device's locale.
 */
@Composable
private fun SubscriptionCard(
    entitlement: Entitlement,
    onSubscribe: () -> Unit,
    onOpenLink: (String) -> Unit,
) {
    val colors = TrackTheme.colors
    val pro = Entitlement.isPro(entitlement)
    val manageUrl = Entitlement.manageUrl(entitlement)
    val summary = Entitlement.entitlementSummary(entitlement) { ms ->
        DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(ms))
    }
    TrackCard(Modifier.fillMaxWidth().testTag("subscription")) {
        Text(summary, style = TrackTheme.typography.h3, color = if (pro) colors.accentInk else colors.textStrong)
        Text(
            entitlementDetail(entitlement),
            style = TrackTheme.typography.xs,
            color = colors.textMuted,
            modifier = Modifier.padding(top = 4.dp),
        )
        Row(
            modifier = Modifier.padding(top = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!pro) {
                Button(
                    onClick = onSubscribe,
                    modifier = Modifier.testTag("subscribe"),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.accent,
                        contentColor = colors.accentContrast,
                    ),
                ) {
                    Text("Subscribe", style = TrackTheme.typography.bodyStrong)
                }
            }
            if (manageUrl != null) {
                TextButton(onClick = { onOpenLink(manageUrl) }, modifier = Modifier.testTag("manageSubscription")) {
                    Text(
                        if (pro) "Manage subscription ↗" else "Manage in Google Play ↗",
                        style = TrackTheme.typography.sm,
                        color = if (pro) colors.accentInk else colors.textMuted,
                    )
                }
            }
        }
    }
}

/** The line under the summary: where the tier came from, or what Pro would add. */
private fun entitlementDetail(entitlement: Entitlement): String = when {
    entitlement.source == Entitlement.Source.LEGACY ->
        "You bought the app before subscriptions — Pro is yours for life."
    Entitlement.isPro(entitlement) && entitlement.source == Entitlement.Source.GOOGLE ->
        "Subscribed through Google Play. Renewal and cancellation are handled there."
    Entitlement.isPro(entitlement) && entitlement.source == Entitlement.Source.APPLE ->
        "Subscribed through the App Store. Manage it from your iPhone's Settings, or the link below."
    Entitlement.isPro(entitlement) -> "Track Evolution Pro."
    entitlement.source != null ->
        "Your subscription has ended. The logbook stays free; nothing was deleted."
    else ->
        "The logbook is free. Pro adds the lap recorder, full telemetry analysis, the garage and the setup notebook."
}

@Composable
private fun ThemeCard(choice: ThemeChoice, onChange: (ThemeChoice) -> Unit) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth()) {
        TEField("Theme", hint = "Follows the device unless you pick one") {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ThemeChoice.entries.forEach { option ->
                    val selected = option == choice
                    TrackCard(
                        modifier = Modifier.weight(1f).clickable { onChange(option) },
                        border = if (selected) colors.accent else colors.borderHairline,
                        contentPadding = 10.dp,
                    ) {
                        Text(
                            option.name,
                            style = TrackTheme.typography.sm,
                            color = if (selected) colors.accentInk else colors.textMuted,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Imperial or metric — the web's Settings → Units, in the theme card's shape.
 *
 * The choice is the account's, not the device's: it is written to `/me` and
 * read back through `LocalUnitSystem`, so the card shows whatever the auth
 * state says rather than a local copy that could disagree with the charts.
 */
@Composable
private fun UnitsCard(model: SettingsModel) {
    val colors = TrackTheme.colors
    val current = LocalUnitSystem.current
    TrackCard(Modifier.fillMaxWidth()) {
        TEField(
            "Unit system",
            hint = "Display only — nothing you've logged changes.",
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Units.UNIT_SYSTEMS.forEach { option ->
                    val selected = option.units == current
                    TrackCard(
                        modifier = Modifier
                            .weight(1f)
                            .testTag("units:${option.units.name.lowercase()}")
                            .clickable { model.updateUnits(option.units) },
                        border = if (selected) colors.accent else colors.borderHairline,
                        contentPadding = 10.dp,
                    ) {
                        Text(
                            option.label,
                            style = TrackTheme.typography.sm,
                            color = if (selected) colors.accentInk else colors.textMuted,
                        )
                        Text(
                            option.examples,
                            style = TrackTheme.typography.xxs,
                            color = colors.textFaint,
                        )
                    }
                }
            }
        }
        TEErrorBanner(model.unitsError, modifier = Modifier.padding(top = 8.dp))
    }
}

/**
 * The per-track leaderboard opt-in — the same privacy posture as the web's
 * Settings section: exactly two things are shared per track, and everything
 * else stays private.
 */
@Composable
private fun LeaderboardOptInCard(model: SettingsModel) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Switch(
                checked = model.leaderboardOptIn,
                onCheckedChange = { model.updateLeaderboardOptIn(it) },
                colors = SwitchDefaults.colors(
                    checkedThumbColor = colors.accentInk,
                    checkedTrackColor = colors.accentTint,
                ),
            )
            Text(
                "Appear on per-track leaderboards",
                style = TrackTheme.typography.body,
                color = colors.textBody,
            )
        }
        Text(
            "Shares your name and best device-timed lap at each track. Nothing else.",
            style = TrackTheme.typography.xs,
            color = colors.textFaint,
            modifier = Modifier.padding(top = 6.dp),
        )
        HorizontalDivider(color = colors.borderHairline, modifier = Modifier.padding(vertical = 10.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Switch(
                checked = model.leaderboardShareLaps,
                onCheckedChange = { model.updateLeaderboardShareLaps(it) },
                enabled = model.leaderboardOptIn,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = colors.accentInk,
                    checkedTrackColor = colors.accentTint,
                ),
            )
            Text(
                "Let other drivers open my ranked laps",
                style = TrackTheme.typography.body,
                color = colors.textBody,
            )
        }
        Text(
            "Also shares that lap's racing line and telemetry. No other lap, no notes.",
            style = TrackTheme.typography.xs,
            color = colors.textFaint,
            modifier = Modifier.padding(top = 6.dp),
        )
        model.leaderboardError?.let {
            TEErrorBanner(it, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

@Composable
private fun ShareCard(
    model: SettingsModel,
    serverUrl: String,
    onShare: (String) -> Unit,
    onOpenLink: (String) -> Unit,
    onDisable: () -> Unit,
) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth()) {
        Text(
            "A read-only page of your bests and history. Notes stay private.",
            style = TrackTheme.typography.sm,
            color = colors.textMuted,
            modifier = Modifier.padding(bottom = 10.dp),
        )
        TEField("Link path") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "${serverUrl.substringAfter("://").trimEnd('/')}/share/",
                    style = TrackTheme.typography.xs,
                    color = colors.textFaint,
                    maxLines = 1,
                )
                OutlinedTextField(
                    value = model.slugDraft,
                    onValueChange = { model.slugDraft = it },
                    placeholder = { Text("your-name", style = TrackTheme.typography.sm) },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        TEErrorBanner(model.shareError, modifier = Modifier.padding(top = 8.dp))
        Row(
            modifier = Modifier.padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                onClick = model::saveSlug,
                enabled = model.slugDraft.isNotBlank(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.accent,
                    contentColor = colors.accentContrast,
                ),
            ) {
                Text(
                    if (model.slug == null) "Create link" else "Update path",
                    style = TrackTheme.typography.bodyStrong,
                )
            }
            if (model.slug != null) {
                TextButton(onClick = onDisable) {
                    Text("Disable", style = TrackTheme.typography.sm, color = colors.danger)
                }
            }
        }
        model.shareUrl(serverUrl)?.let { url ->
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                TextButton(onClick = { onShare(url) }) {
                    Text("Share…", style = TrackTheme.typography.bodyStrong, color = colors.accentInk)
                }
                TextButton(onClick = { onOpenLink(url) }) {
                    Text("Open ↗", style = TrackTheme.typography.sm, color = colors.textMuted)
                }
            }
        }
    }
}

/**
 * The prep list every new checklist starts from.
 *
 * Editing it never touches a checklist already on an event: those are snapshots
 * taken when the list was started, and rewriting one would untick items the
 * driver had already dealt with.
 */
@Composable
private fun ChecklistTemplateCard(
    model: SettingsModel,
    template: List<String>,
    isCustom: Boolean,
) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth()) {
        Text(
            "The list new events start from. Existing checklists don't change.",
            style = TrackTheme.typography.xs,
            color = colors.textMuted,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        template.forEachIndexed { index, text ->
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text,
                    style = TrackTheme.typography.sm,
                    color = colors.textBody,
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = { model.moveChecklistItem(index, -1) },
                    enabled = index > 0,
                ) {
                    Text("↑", style = TrackTheme.typography.sm, color = colors.textFaint)
                }
                TextButton(
                    onClick = { model.moveChecklistItem(index, 1) },
                    enabled = index < template.lastIndex,
                ) {
                    Text("↓", style = TrackTheme.typography.sm, color = colors.textFaint)
                }
                TextButton(onClick = { model.removeChecklistItem(index) }) {
                    Text("✕", style = TrackTheme.typography.sm, color = colors.textFaint)
                }
            }
            if (index < template.lastIndex) {
                HorizontalDivider(color = colors.borderHairline)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = model.newChecklistItem,
                onValueChange = { if (it.length <= 200) model.newChecklistItem = it },
                placeholder = { Text("Add item…", style = TrackTheme.typography.sm) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            TextButton(
                onClick = model::addChecklistItem,
                enabled = model.newChecklistItem.isNotBlank(),
            ) {
                Text("Add", style = TrackTheme.typography.sm, color = colors.accentInk)
            }
        }
        if (isCustom) {
            TextButton(onClick = model::resetChecklistTemplate) {
                Text("Reset to default", style = TrackTheme.typography.sm, color = colors.textMuted)
            }
        }
        TEErrorBanner(model.checklistError, modifier = Modifier.padding(top = 8.dp))
    }
}

/**
 * Best-lap videos (NS-45): the cellular switch — off by default, so a clip
 * saved at the track uploads on Wi-Fi at home — and the storage line,
 * `clipStorageLine` over `user.clips` ("Lap videos: 3.2 GB of 20 GB"), which
 * a `/me` cached before the field simply doesn't draw.
 */
@Composable
private fun LapVideosCard(storageLine: String?) {
    val colors = TrackTheme.colors
    val clips = LocalClipStatus.current
    val scope = rememberCoroutineScope()
    val cellular by clips.cellularAllowed.collectAsState(initial = false)
    TrackCard(Modifier.fillMaxWidth()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.testTag("clipCellular").toggleable(
                value = cellular,
                role = Role.Switch,
                onValueChange = { on -> scope.launch { clips.setCellularAllowed(on) } },
            ),
        ) {
            Switch(
                checked = cellular,
                onCheckedChange = null,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = colors.accentInk,
                    checkedTrackColor = colors.accentTint,
                ),
            )
            Text("Upload lap videos over cellular", style = TrackTheme.typography.body, color = colors.textBody)
        }
        Text(
            "Off, lap videos wait for Wi-Fi.",
            style = TrackTheme.typography.xs,
            color = colors.textFaint,
            modifier = Modifier.padding(top = 6.dp),
        )
        storageLine?.let {
            Text(
                it,
                style = TrackTheme.typography.sm,
                color = colors.textMuted,
                modifier = Modifier.padding(top = 8.dp).testTag("clipStorage"),
            )
        }
    }
}

/**
 * Share with a coach (NS-38) — its own page, since it has three lists and a
 * form behind it; the web's Settings carries the same one row.
 */
@Composable
private fun CoachingCard(onOpenCoaching: () -> Unit, unread: Int = 0) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth()) {
        Text(
            "Share your logbook with a coach, or open your students'.",
            style = TrackTheme.typography.sm,
            color = colors.textMuted,
            modifier = Modifier.padding(bottom = 6.dp),
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onOpenCoaching)
                .padding(vertical = 8.dp)
                .testTag("openCoaching")
                // Coach comments waiting (NS-52): the badge seen, the count heard.
                .semantics(mergeDescendants = true) {
                    if (unread > 0) stateDescription = "$unread unread comment${if (unread == 1) "" else "s"}"
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Open Coaching",
                style = TrackTheme.typography.bodyStrong,
                color = colors.accentInk,
                modifier = Modifier.weight(1f),
            )
            if (unread > 0) {
                Text(
                    unread.toString(),
                    style = TrackTheme.typography.xs,
                    color = colors.accentContrast,
                    modifier = Modifier
                        .padding(end = 8.dp)
                        .background(colors.accent, androidx.compose.foundation.shape.RoundedCornerShape(999.dp))
                        .padding(horizontal = 7.dp, vertical = 1.dp)
                        .testTag("coachingUnread"),
                )
            }
            Text("›", style = TrackTheme.typography.body, color = colors.textFaint)
        }
    }
}

/** The newcomer's guide on the docs site — the web's and iOS's same section. */
@Composable
private fun TrackDaysCard(onOpenGuide: () -> Unit) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth()) {
        Text(
            "What to expect, what to bring and where to find an event.",
            style = TrackTheme.typography.sm,
            color = colors.textMuted,
            modifier = Modifier.padding(bottom = 6.dp),
        )
        Box(Modifier.testTag("trackDaysGuide")) {
            LegalRow("Your first track day", external = false, onClick = onOpenGuide)
        }
    }
}

@Composable
private fun LegalCard(onOpenLink: (String) -> Unit) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth()) {
        LegalRow("Privacy policy") { onOpenLink("$DOCS_URL/docs/privacy.html") }
        HorizontalDivider(color = colors.borderHairline)
        LegalRow("Terms of use") { onOpenLink("$DOCS_URL/docs/terms.html") }
        HorizontalDivider(color = colors.borderHairline)
        LegalRow("Documentation") { onOpenLink(DOCS_URL) }
        Text(
            "© ${java.time.Year.now().value} Speedshift LLC",
            style = TrackTheme.typography.xs,
            color = colors.textFaint,
            modifier = Modifier.padding(top = 12.dp),
        )
        // What a bug report needs to be actionable.
        Text(
            "Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
            style = TrackTheme.typography.xxs,
            color = colors.textFaint,
        )
    }
}

/** `↗` for a link that leaves the app, `›` for one that opens a screen in it. */
@Composable
private fun LegalRow(title: String, external: Boolean = true, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            title,
            style = TrackTheme.typography.body,
            color = TrackTheme.colors.textBody,
            textDecoration = TextDecoration.Underline,
        )
        Text(if (external) "↗" else "›", style = TrackTheme.typography.xs, color = TrackTheme.colors.textFaint)
    }
}
