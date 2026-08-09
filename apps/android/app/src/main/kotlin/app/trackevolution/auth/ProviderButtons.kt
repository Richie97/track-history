package app.trackevolution.auth

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.trackevolution.R
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackTheme

/**
 * The provider sign-in buttons, drawn to each brand's spec.
 *
 * This is the one place the design system's no-hex-literals rule bends on
 * purpose: Google's and Apple's branding guidelines mandate the exact colors of
 * their buttons and forbid recoloring their marks, so the values live here
 * rather than in the generated token set, and neither button follows the app
 * theme beyond choosing its light or dark variant. What the pair *does* share
 * is everything the brands leave to us — one width, one height, the app's
 * corner radius, one label font — so two providers read as one choice.
 *
 * Google is the neutral scheme from the sign-in branding guidelines: white
 * with a #747775 border and #1F1F1F text in light theme, #131314 with a
 * #8E918F border and #E3E3E3 text in dark, the 20dp four-color G on both, and
 * the label in Roboto Medium — the one font the guidelines name, and Android's
 * system default. Apple allows exactly black and white: black on the light
 * theme, white on the dark — the same inversion the web's `.btn.apple` does
 * via `--text-strong`/`--surface-card` and the iOS screen makes against
 * `colorScheme`. The label matches Google's, which Apple's non-Apple-platform
 * guidance permits (and consistency is the point of this file).
 */
@Composable
fun GoogleSignInButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val dark = TrackTheme.isDark
    Button(
        onClick = onClick,
        modifier = modifier,
        shape = RoundedCornerShape(TrackTheme.radii.md),
        border = BorderStroke(1.dp, if (dark) GOOGLE_BORDER_DARK else GOOGLE_BORDER_LIGHT),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (dark) GOOGLE_SURFACE_DARK else Color.White,
            contentColor = if (dark) GOOGLE_INK_DARK else GOOGLE_INK_LIGHT,
        ),
    ) {
        Image(
            painter = painterResource(R.drawable.ic_google_g),
            contentDescription = null,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(10.dp))
        Text("Continue with Google", style = ProviderLabelStyle)
    }
}

@Composable
fun AppleSignInButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val dark = TrackTheme.isDark
    Button(
        onClick = onClick,
        modifier = modifier,
        shape = RoundedCornerShape(TrackTheme.radii.md),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (dark) Color.White else Color.Black,
            contentColor = if (dark) Color.Black else Color.White,
        ),
    ) {
        Icon(
            painter = painterResource(R.drawable.ic_apple_logo),
            contentDescription = null,
            // Intrinsic size (16×20dp): the mark is taller than wide, and
            // squaring it into a 20dp box would distort exactly the thing
            // Apple's guidelines say not to touch.
        )
        Spacer(Modifier.width(10.dp))
        Text("Continue with Apple", style = ProviderLabelStyle)
    }
}

/**
 * Roboto Medium ([FontFamily.Default] on Android), per Google's guidelines,
 * shared by both buttons so the pair matches. Deliberately not Geist: the app
 * face on Google's button is what the branding guidelines exist to prevent.
 */
private val ProviderLabelStyle = TextStyle(
    fontFamily = FontFamily.Default,
    fontWeight = FontWeight.Medium,
    fontSize = 15.sp,
)

private val GOOGLE_SURFACE_DARK = Color(0xFF131314)
private val GOOGLE_BORDER_LIGHT = Color(0xFF747775)
private val GOOGLE_BORDER_DARK = Color(0xFF8E918F)
private val GOOGLE_INK_LIGHT = Color(0xFF1F1F1F)
private val GOOGLE_INK_DARK = Color(0xFFE3E3E3)

@Preview
@Composable
private fun ProviderButtonsPreview() {
    TrackTheme(ThemeChoice.Light) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val m = Modifier.widthIn(max = 320.dp).fillMaxWidth().height(48.dp)
            GoogleSignInButton(onClick = {}, modifier = m)
            AppleSignInButton(onClick = {}, modifier = m)
        }
    }
}

@Preview
@Composable
private fun ProviderButtonsDarkPreview() {
    TrackTheme(ThemeChoice.Dark) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val m = Modifier.widthIn(max = 320.dp).fillMaxWidth().height(48.dp)
            GoogleSignInButton(onClick = {}, modifier = m)
            AppleSignInButton(onClick = {}, modifier = m)
        }
    }
}
