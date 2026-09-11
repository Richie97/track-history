package app.trackevolution.ui

import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.layout.PaneScaffoldDirective
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Where the two panes meet in book posture (spec: NS-34 ticket 4).
 *
 * The rule the spec gives is one sentence — nothing lays across the hinge — and
 * the arithmetic under it is a multiplication, so it is tested as one rather than
 * on a device nobody has.
 */
@OptIn(ExperimentalMaterial3AdaptiveApi::class)
class BookDirectiveTest {

    @Test
    fun `book posture puts the gutter on the crease`() {
        val directive = bookDirective(FoldGeometry(FoldPosture.Book, 0.4f), 1000.dp)
        assertEquals(400.dp, directive.defaultPanePreferredWidth)
    }

    /**
     * Everything that is not a book-postured foldable — which is every phone,
     * every tablet, and a foldable lying flat — gets the default, untouched.
     */
    @Test
    fun `every other posture keeps the default split`() {
        val default = PaneScaffoldDirective.Default.defaultPanePreferredWidth
        assertEquals(default, bookDirective(Folds.FLAT, 1000.dp).defaultPanePreferredWidth)
        assertEquals(
            default,
            bookDirective(FoldGeometry(FoldPosture.Tabletop, 0.5f), 1000.dp)
                .defaultPanePreferredWidth,
        )
        assertEquals(
            default,
            bookDirective(FoldGeometry(FoldPosture.Book, null), 1000.dp)
                .defaultPanePreferredWidth,
        )
    }

    /** A window that has not been measured yet must not produce a zero-wide pane. */
    @Test
    fun `an unmeasured window keeps the default split`() {
        assertEquals(
            PaneScaffoldDirective.Default.defaultPanePreferredWidth,
            bookDirective(FoldGeometry(FoldPosture.Book, 0.5f), 0.dp).defaultPanePreferredWidth,
        )
    }
}
