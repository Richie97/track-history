package app.trackevolution.ui.theme

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.trackevolution.ui.CARD_GRID_MINIMUM
import app.trackevolution.ui.LayoutClass
import app.trackevolution.ui.LayoutMetrics
import app.trackevolution.ui.LocalLayoutMetrics
import app.trackevolution.ui.pageGutter
import kotlinx.coroutines.launch

/**
 * The design-system gallery: every color token in both themes, the type scale
 * and the radii, on one scrolling screen.
 *
 * It lives in the **debug source set**, so it is not merely unreachable in a
 * release build — it isn't compiled into one. This is how the port gets reviewed
 * against https://trackevolution.app without diffing hex codes by eye, and how
 * the largest system font scale gets checked: turn font size up in Settings and
 * open it.
 *
 * Launch it from the "TE Tokens" launcher icon a debug install adds, or:
 *
 *   adb shell am start -n app.trackevolution/app.trackevolution.ui.theme.TokenGalleryActivity
 */
class TokenGalleryActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { TokenGalleryScreen() }
    }
}

@Composable
private fun TokenGalleryScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // The real preference, not local state: until Settings exists (NS-26) this
    // is the only thing that writes it, and "persists across launch" is a
    // claim worth being able to check.
    val preference = remember(context) { ThemePreference(context.applicationContext) }
    val choice by preference.choice.collectAsState(initial = ThemeChoice.System)
    TrackTheme(choice) {
        val colors = TrackTheme.colors
        val type = TrackTheme.typography
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .background(colors.bgPage)
                // The activity is edge to edge by default on API 35, so without
                // this the first row sits under the status bar.
                .systemBarsPadding()
                .padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = PaddingValues(vertical = 24.dp),
        ) {
            item {
                Text("Design tokens", style = type.h1, color = colors.textStrong)
                Text(
                    "Generated from public/style.css — the source of truth.",
                    style = type.sm,
                    color = colors.textMuted,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            item {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(vertical = 8.dp),
                ) {
                    ThemeChoice.entries.forEach { option ->
                        FilterChip(
                            selected = choice == option,
                            onClick = { scope.launch { preference.set(option) } },
                            label = { Text(option.name, style = type.sm) },
                        )
                    }
                }
            }

            item { SectionHeading("Colors") }
            items(ColorTokenCatalog, key = { it.name }) { token ->
                Swatch(token.name, token.css, token.select(colors))
            }

            item { SectionHeading("Type scale") }
            items(type.all, key = { it.first }) { (name, style) ->
                Column(modifier = Modifier.padding(vertical = 6.dp)) {
                    Text(name, style = type.xxs, color = colors.textFaint)
                    Text("1:58.421 — Road Atlanta", style = style, color = colors.textStrong)
                }
            }

            item { SectionHeading("Radii") }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    TrackTheme.radii.all.forEach { (name, dp) ->
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(
                                modifier = Modifier
                                    .size(52.dp)
                                    .clip(RoundedCornerShape(dp))
                                    .background(colors.surfaceRaised)
                                    .border(
                                        1.dp,
                                        colors.borderHairline,
                                        RoundedCornerShape(dp),
                                    ),
                            )
                            Text(name, style = type.xxs, color = colors.textMuted)
                        }
                    }
                }
            }

            item { SectionHeading("Layout classes") }
            item { LayoutClassRow() }

            item { SectionHeading("Depth") }
            item {
                TrackCard {
                    Text("A card", style = type.h3, color = colors.textStrong)
                    Text(
                        "Hairline border plus one surface step. No shadow, no tonal wash.",
                        style = type.sm,
                        color = colors.textMuted,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun SectionHeading(text: String) {
    Text(
        text.uppercase(),
        style = TrackTheme.typography.eyebrow,
        color = TrackTheme.colors.textFaint,
        modifier = Modifier.padding(top = 20.dp, bottom = 4.dp),
    )
}

@Composable
private fun Swatch(name: String, css: String, color: Color) {
    val colors = TrackTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(44.dp)
                .clip(RoundedCornerShape(TrackTheme.radii.sm))
                // Over a checker-ish backdrop so the translucent tokens
                // (borders, tints, chart dim) read as translucent.
                .background(colors.bgSubtle)
                .border(1.dp, colors.borderHairline, RoundedCornerShape(TrackTheme.radii.sm)),
            contentAlignment = Alignment.Center,
        ) {
            Box(modifier = Modifier.fillMaxSize().padding(4.dp).background(color))
        }
        Column(modifier = Modifier.padding(start = 12.dp)) {
            Text(name, style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
            Text(css, style = TrackTheme.typography.xs, color = colors.textFaint)
        }
    }
}

/**
 * The layout class this window is in, and the breakpoints it sits between.
 *
 * Resize the window — a foldable, a freeform window, split screen — and watch
 * the highlight move: that it moves *at all* is the thing worth seeing here,
 * since a class read once at launch would look identical until someone folded a
 * phone in the paddock.
 */
@Composable
private fun LayoutClassRow() {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    val metrics = LocalLayoutMetrics.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            LayoutClass.entries.forEach { entry ->
                val live = entry == metrics.layoutClass
                Text(
                    entry.name.lowercase(),
                    style = type.sm,
                    color = if (live) colors.accentContrast else colors.textMuted,
                    modifier = Modifier
                        .clip(RoundedCornerShape(TrackTheme.radii.sm))
                        .background(if (live) colors.accent else colors.surfaceRaised)
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
        }
        Text(
            "breakpoints ${LayoutClass.MEDIUM_MIN_DP} / ${LayoutClass.EXPANDED_MIN_DP}dp · " +
                "page-max ${LayoutTokens.PAGE_MAX.value.toInt()} · " +
                "gutter ${LayoutTokens.PAGE_GUTTER.value.toInt()}",
            style = type.xxs,
            color = colors.textMuted,
        )
        Text(
            "content column ${metrics.contentWidth.value.toInt()}dp · " +
                "${metrics.columns(CARD_GRID_MINIMUM)} card columns",
            style = type.xxs,
            color = colors.textFaint,
        )
    }
}

@Preview(showBackground = true, heightDp = 1400)
@Composable
private fun TokenGalleryPreview() {
    TokenGalleryScreen()
}

// The three layout classes, side by side in the IDE. The gallery is the one
// screen that can be previewed without standing up a screen model and a fake
// server, so it is where the widths are looked at (NS-34 ticket 1).
@Preview(name = "compact 400dp", widthDp = 400, heightDp = 900)
@Preview(name = "medium 700dp", widthDp = 700, heightDp = 900)
@Preview(name = "expanded 1000dp", widthDp = 1000, heightDp = 900)
@Composable
private fun LayoutClassPreviews() {
    // `@Preview(widthDp = …)` resizes the *composable*, not the configuration
    // that ProvideLayoutMetrics reads, so the class is fed in from the preview's
    // own constraints here. On a device the provider is the only source.
    BoxWithConstraints {
        val layoutClass = LayoutClass.ofWidth(maxWidth.value.toInt())
        CompositionLocalProvider(
            LocalLayoutMetrics provides LayoutMetrics(
                layoutClass = layoutClass,
                contentWidth = maxWidth - pageGutter(layoutClass) * 2,
            ),
        ) {
            TrackTheme {
                Column(Modifier.background(TrackTheme.colors.bgPage).padding(16.dp)) {
                    LayoutClassRow()
                }
            }
        }
    }
}
