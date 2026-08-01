package app.trackevolution.ui.theme

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Box
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

@Preview(showBackground = true, heightDp = 1400)
@Composable
private fun TokenGalleryPreview() {
    TokenGalleryScreen()
}
