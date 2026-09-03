package app.trackevolution.billing

import android.app.Activity
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * The paywall (NS-32 rule 5): a sheet, never a disabled button. It names the
 * price and the term from Play's own `ProductDetails` (so it is localised and
 * agrees with what Play charges), carries both legal links, and has a Restore.
 *
 * The copy draws the tier line the spec fixes: **Free is the logbook, Pro is the
 * analysis.** Nothing anyone already has is behind this sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PaywallSheet(
    billing: BillingController,
    onDismiss: () -> Unit,
    onOpenLink: (String) -> Unit,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    val state by billing.state.collectAsState()
    val activity = LocalContext.current as? Activity

    LaunchedEffect(Unit) { if (state.plans.isEmpty()) billing.refreshProducts() }

    // Yearly pre-selected: it is the better deal, and the card says by how much.
    var selectedPlan by rememberSaveable { mutableStateOf(BillingProducts.YEARLY) }
    val plans = state.plans
    val monthly = plans.firstOrNull { it.basePlanId == BillingProducts.MONTHLY }
    val yearly = plans.firstOrNull { it.basePlanId == BillingProducts.YEARLY }
    val selected = plans.firstOrNull { it.basePlanId == selectedPlan } ?: plans.firstOrNull()
    val savings = PaywallPlans.savingsPercent(monthly, yearly)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = colors.surfaceRaised,
        modifier = Modifier.testTag("paywall"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("TRACK EVOLUTION PRO", style = type.eyebrow, color = colors.accentInk)
            Text("Turn lap times into analysis", style = type.h1, color = colors.textStrong)
            Text(
                "The logbook is free — tracks, events, sessions, lap times, best laps, progress " +
                    "charts, sharing and leaderboards, with no limit, and lap times out of Corvette " +
                    "PDR and GoPro video. Pro is the analysis: the GPS lap recorder with live timing, " +
                    "the per-lap channel graphs and sector splits inside those same videos, and the " +
                    "garage's consumable wear tracking.",
                style = type.sm,
                color = colors.textMuted,
            )

            when {
                state.loadingPlans -> Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.height(18.dp), color = colors.accent)
                    Text(
                        "Fetching prices from Google Play…",
                        style = type.sm,
                        color = colors.textMuted,
                        modifier = Modifier.padding(start = 10.dp),
                    )
                }

                plans.isEmpty() -> {
                    Text(
                        state.unavailable ?: "Prices aren't available right now.",
                        style = type.sm,
                        color = colors.textMuted,
                    )
                    TextButton(onClick = billing::refreshProducts) {
                        Text("Try again", style = type.bodyStrong, color = colors.accentInk)
                    }
                }

                else -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    plans.forEach { plan ->
                        PlanCard(
                            plan = plan,
                            selected = plan.basePlanId == selected?.basePlanId,
                            badge = if (plan.basePlanId == BillingProducts.YEARLY && savings != null) "Save $savings%" else null,
                            onClick = { selectedPlan = plan.basePlanId },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }

            Button(
                onClick = { if (selected != null && activity != null) billing.buy(activity, selected) },
                enabled = selected != null && activity != null && !state.busy,
                modifier = Modifier.fillMaxWidth().testTag("paywallSubscribe"),
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.accent,
                    contentColor = colors.accentContrast,
                ),
            ) {
                Text(
                    when {
                        state.busy -> "Opening Google Play…"
                        selected == null -> "Subscribe"
                        selected.trial != null -> "Start ${selected.trial} — then ${selected.price} / ${selected.period}"
                        else -> "Subscribe — ${selected.price} / ${selected.period}"
                    },
                    style = type.bodyStrong,
                )
            }

            Text(
                "Renews automatically until cancelled in Google Play; cancel any time and keep Pro to " +
                    "the end of the period. A lapse never touches your logbook — every lap you've " +
                    "recorded or entered stays, and nothing you save is ever rejected.",
                style = type.xs,
                color = colors.textFaint,
            )

            TEErrorBanner(state.message)

            Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = billing::restore, enabled = !state.busy, modifier = Modifier.testTag("paywallRestore")) {
                    Text("Restore purchases", style = type.sm, color = colors.textMuted)
                }
                TextButton(onClick = onDismiss) {
                    Text("Not now", style = type.sm, color = colors.textMuted)
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                LegalLink("Privacy policy", LegalLinks.PRIVACY, onOpenLink)
                LegalLink("Terms of use", LegalLinks.TERMS, onOpenLink)
            }
        }
    }
}

@Composable
private fun PlanCard(
    plan: Plan,
    selected: Boolean,
    badge: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    TrackCard(
        modifier = modifier
            .clickable(onClick = onClick)
            .semantics {
                contentDescription = buildString {
                    append(plan.title)
                    append(", ")
                    append(plan.price)
                    append(" per ")
                    append(plan.period)
                    plan.trial?.let { append(", $it") }
                    if (selected) append(", selected")
                }
            }
            .testTag("plan-${plan.basePlanId}"),
        border = if (selected) colors.accent else colors.borderHairline,
        contentPadding = 12.dp,
    ) {
        Text(plan.title, style = type.h3, color = if (selected) colors.accentInk else colors.textStrong)
        Text(plan.price, style = type.h2, color = colors.textStrong, maxLines = 1)
        Text("per ${plan.period}", style = type.xs, color = colors.textMuted)
        plan.trial?.let { Text(it, style = type.xxs, color = colors.accentInk, modifier = Modifier.padding(top = 4.dp)) }
        badge?.let { Text(it, style = type.xxs, color = colors.textFaint, modifier = Modifier.padding(top = 4.dp)) }
    }
}

@Composable
private fun LegalLink(label: String, url: String, onOpenLink: (String) -> Unit) {
    Text(
        "$label ↗",
        style = TrackTheme.typography.xs.copy(textDecoration = TextDecoration.Underline),
        color = TrackTheme.colors.textMuted,
        modifier = Modifier.clickable { onOpenLink(url) },
    )
}
