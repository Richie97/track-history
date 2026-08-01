package app.trackevolution.auth

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.trackevolution.core.api.AuthProvider
import app.trackevolution.core.api.AuthProviders
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * The sign-in screen.
 *
 * The Apple button is drawn from what the server advertises at
 * `GET /auth/providers`, never hardcoded visible: a deployment without the
 * `APPLE_*` secrets has no Apple flow to offer, and a button that leads to a
 * 404 is worse than no button. Both providers go through the same web endpoint
 * in a Custom Tab — there is no native SDK on either side.
 */
@Composable
fun SignInScreen(
    state: AuthState,
    onSignIn: (AuthProvider) -> Unit,
    modifier: Modifier = Modifier,
    /**
     * The instance being talked to, and a way to change it. Debug builds only —
     * `MainActivity` passes null in release, and the control disappears with it.
     * A real Settings screen arrives with NS-26.
     */
    serverOverride: ServerOverride? = null,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    val providers = (state as? AuthState.SignedOut)?.providers ?: AuthProviders.FALLBACK
    val busy = state is AuthState.SigningIn
    var editingServer by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bgPage)
            .padding(horizontal = 28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Track Evolution", style = type.h1, color = colors.textStrong)
        Text(
            "Your track-day logbook.",
            style = type.sm,
            color = colors.textMuted,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 6.dp, bottom = 32.dp),
        )

        if (busy) {
            // The browser is open, or the code is in flight. Both are short and
            // both are places where a second tap would start a second flow and
            // invalidate the first.
            Box(modifier = Modifier.height(96.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = colors.accent)
            }
        } else {
            // Narrow: a full-width button on a phone reads as a form field, and
            // this is the only action on the screen.
            val buttonModifier = Modifier.fillMaxWidth().widthIn(max = 320.dp).height(48.dp)
            if (providers.google) {
                Button(
                    onClick = { onSignIn(AuthProvider.GOOGLE) },
                    modifier = buttonModifier,
                    shape = RoundedCornerShape(TrackTheme.radii.md),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.accent,
                        contentColor = colors.accentContrast,
                    ),
                ) {
                    Text("Continue with Google", style = type.bodyStrong)
                }
            }
            if (providers.apple) {
                OutlinedButton(
                    onClick = { onSignIn(AuthProvider.APPLE) },
                    modifier = buttonModifier.padding(top = 10.dp),
                    shape = RoundedCornerShape(TrackTheme.radii.md),
                    border = BorderStroke(1.dp, colors.borderStrong),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.textStrong),
                ) {
                    Text("Continue with Apple", style = type.bodyStrong)
                }
            }
        }

        val error = (state as? AuthState.SignedOut)?.error
        if (error != null) {
            TrackCard(
                modifier = Modifier.padding(top = 24.dp).widthIn(max = 320.dp),
                color = colors.dangerTint,
                border = colors.danger,
            ) {
                // The server's own message, never a generic one of ours.
                Text(error, style = type.sm, color = colors.dangerInk)
            }
        }

        if (serverOverride != null) {
            TextButton(
                onClick = { editingServer = true },
                modifier = Modifier.padding(top = 28.dp),
            ) {
                Text(serverOverride.current, style = type.xs, color = colors.textFaint)
            }
        }
    }

    if (serverOverride != null && editingServer) {
        ServerDialog(
            current = serverOverride.current,
            onDismiss = { editingServer = false },
            onConfirm = {
                editingServer = false
                serverOverride.onChange(it)
            },
        )
    }
}

/** The server the app talks to, and a way to point it somewhere else. */
data class ServerOverride(
    val current: String,
    val onChange: (String) -> Unit,
)

/**
 * The dev-server picker. `http://10.0.2.2:8787` is offered as a one-tap preset
 * because it is the only address that gets the server's `DEV_MODE` bypass from
 * an emulator: 10.0.2.2 is the emulator's alias for the host machine, and the
 * bypass deliberately answers on local hosts only.
 */
@Composable
private fun ServerDialog(
    current: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var text by remember { mutableStateOf(current) }
    val colors = TrackTheme.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = colors.surfaceRaised,
        title = { Text("Server", style = TrackTheme.typography.h3, color = colors.textStrong) },
        text = {
            Column {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    singleLine = true,
                    textStyle = TrackTheme.typography.body,
                )
                TextButton(onClick = { text = EMULATOR_DEV_SERVER }) {
                    Text(
                        "Use $EMULATOR_DEV_SERVER (emulator → wrangler dev)",
                        style = TrackTheme.typography.xs,
                        color = colors.accentInk,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(text) }) {
                Text("Use it", color = colors.accentInk)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel", color = colors.textMuted) }
        },
    )
}

private const val EMULATOR_DEV_SERVER = "http://10.0.2.2:8787"

@Preview
@Composable
private fun SignInPreview() {
    TrackTheme(ThemeChoice.Dark) {
        SignInScreen(
            state = AuthState.SignedOut(AuthProviders(google = true, apple = true)),
            onSignIn = {},
        )
    }
}

@Preview
@Composable
private fun SignInErrorPreview() {
    TrackTheme(ThemeChoice.Light) {
        SignInScreen(
            state = AuthState.SignedOut(AuthProviders.FALLBACK, error = "invalid or expired code"),
            onSignIn = {},
        )
    }
}
