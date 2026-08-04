package app.trackevolution.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import app.trackevolution.BuildConfig
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.Vehicle
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEConfirmDialog
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEField
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/** Where the legal pages live. The app links out; it does not embed them. */
private const val DOCS_URL = "https://docs.trackevolution.app"

/**
 * Account, theme, the public share link, the prep list, the garage's cars, and
 * the legal pages (NS-26).
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
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    var confirmSignOut by remember { mutableStateOf(false) }
    var confirmDisableShare by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<Vehicle?>(null) }

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("title") {
                Text("Settings", style = TrackTheme.typography.h1, color = colors.textStrong)
            }

            item("account") { AccountCard(model, serverUrl) }

            item("appearance-header") { TESectionHeader("Appearance") }
            item("appearance") { ThemeCard(themeChoice, onThemeChange) }

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

            item("checklist-header") { TESectionHeader("Prep checklist") }
            item("checklist") {
                ChecklistTemplateCard(model, checklistTemplate, hasCustomChecklistTemplate)
            }

            item("vehicles-header") { TESectionHeader("Vehicles") }
            item("vehicles") {
                VehiclesCard(model, onOpenLink = onOpenLink, onDelete = { deleting = it })
            }

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

    deleting?.let { vehicle ->
        TEConfirmDialog(
            text = "Delete ${vehicle.name}? Its consumables, measurements and wear history go " +
                "with it. Events keep their car name and simply stop being linked.",
            confirm = "Delete vehicle",
            onConfirm = { deleting = null; model.deleteVehicle(vehicle.id) },
            onDismiss = { deleting = null },
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
            "Publish a read-only page of your track history — bests, run groups and consistency " +
                "(notes stay private). Handy for HPDE run-group placement. Anyone with the link " +
                "can view it.",
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
            "The list an upcoming event starts from. Checklists already on an event keep " +
                "whatever is on them.",
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
        Text(
            if (isCustom) {
                "This is your own list."
            } else {
                "This is the app's default — your first edit makes it yours."
            },
            style = TrackTheme.typography.xs,
            color = colors.textFaint,
            modifier = Modifier.padding(top = 4.dp),
        )
        if (isCustom) {
            TextButton(onClick = model::resetChecklistTemplate) {
                Text("Reset to default", style = TrackTheme.typography.sm, color = colors.textMuted)
            }
        }
        TEErrorBanner(model.checklistError, modifier = Modifier.padding(top = 8.dp))
    }
}

/**
 * The cars an event's Car field is matched against.
 *
 * **There is no garage page to open.** Consumable wear tracking is web and iOS
 * only for now (NS-31), so this links out to the web app rather than offering a
 * row that goes nowhere.
 */
@Composable
private fun VehiclesCard(
    model: SettingsModel,
    onOpenLink: (String) -> Unit,
    onDelete: (Vehicle) -> Unit,
) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth()) {
        Text(
            "Your cars. The default one pre-fills new events, and an event's Car field is " +
                "matched to a vehicle by name.",
            style = TrackTheme.typography.sm,
            color = colors.textMuted,
            modifier = Modifier.padding(bottom = 10.dp),
        )

        if (model.vehicles.isEmpty()) {
            TEEmpty("No cars yet — add your first below.")
        } else {
            model.vehicles.forEach { vehicle ->
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            vehicle.name,
                            style = TrackTheme.typography.bodyStrong,
                            color = colors.textStrong,
                        )
                        if (vehicle.isDefault) {
                            Text("Default", style = TrackTheme.typography.xxs, color = colors.accentInk)
                        }
                    }
                    if (!vehicle.isDefault) {
                        TextButton(onClick = { model.makeDefault(vehicle.id) }) {
                            Text(
                                "Make default",
                                style = TrackTheme.typography.xs,
                                color = colors.accentInk,
                            )
                        }
                    }
                    TextButton(onClick = { onDelete(vehicle) }) {
                        Text("Delete", style = TrackTheme.typography.xs, color = colors.danger)
                    }
                }
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = model.newVehicleName,
                onValueChange = { model.newVehicleName = it },
                placeholder = { Text("2023 Corvette Z06", style = TrackTheme.typography.sm) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = model::addVehicle, enabled = model.newVehicleName.isNotBlank()) {
                Text("Add", style = TrackTheme.typography.sm, color = colors.accentInk)
            }
        }
        TEErrorBanner(model.vehicleError, modifier = Modifier.padding(top = 8.dp))
        Text(
            "Tracking pads, tires and fluid — the garage — is on the web app for now.",
            style = TrackTheme.typography.xs,
            color = colors.textFaint,
            modifier = Modifier.padding(top = 10.dp),
        )
        TextButton(onClick = { onOpenLink("$DOCS_URL/docs/garage.html") }) {
            Text("About the garage ↗", style = TrackTheme.typography.sm, color = colors.textMuted)
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

@Composable
private fun LegalRow(title: String, onClick: () -> Unit) {
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
        Text("↗", style = TrackTheme.typography.xs, color = TrackTheme.colors.textFaint)
    }
}
