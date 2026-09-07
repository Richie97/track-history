package app.trackevolution.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.trackevolution.ui.theme.LayoutTokens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The layout breakpoints, pinned (spec: NS-34).
 *
 * The two constants are duplicated on iOS — `App/DesignSystem/LayoutClass.swift`,
 * with a matching `LayoutClassTests` — because the class is derived from each
 * platform's own window APIs and neither pure-logic module may import a UI
 * framework. Duplication is the accepted cost; this test and its Swift
 * counterpart are what stop it turning into drift, so a PR that changes 600 or
 * 840 here fails over there.
 *
 * The arithmetic half is plain JUnit and needs no Robolectric: `ofWidth` is a
 * pure function of a number, and running it on a simulated Android is a slower
 * way to learn the same thing.
 */
class LayoutClassTest {

    /** Material's window size class breakpoints. Changing either changes both apps. */
    @Test
    fun `breakpoints are Material's and match iOS`() {
        assertEquals(600, LayoutClass.MEDIUM_MIN_DP)
        assertEquals(840, LayoutClass.EXPANDED_MIN_DP)
    }

    /**
     * Each boundary, and one dp below it: the off-by-one that matters is whether
     * the breakpoint itself belongs to the class above.
     */
    @Test
    fun `class at each boundary`() {
        assertEquals(LayoutClass.Compact, LayoutClass.ofWidth(0))
        assertEquals(LayoutClass.Compact, LayoutClass.ofWidth(599))
        assertEquals(LayoutClass.Medium, LayoutClass.ofWidth(600))
        assertEquals(LayoutClass.Medium, LayoutClass.ofWidth(839))
        assertEquals(LayoutClass.Expanded, LayoutClass.ofWidth(840))
        assertEquals(LayoutClass.Expanded, LayoutClass.ofWidth(1280))
    }

    /**
     * A phone in landscape, which is where the two platforms genuinely differ.
     *
     * iOS classifies an iPhone in landscape as compact whatever its width,
     * because UIKit hands it a `.compact` horizontal size class and that is the
     * OS saying "this is a one-column device". Android offers no equivalent
     * signal, so a 915dp-wide phone window is classified by its width and lands
     * in expanded — the same class a small tablet gets.
     *
     * That costs nothing here: medium and expanded are the same layout until the
     * two-pane shell exists. It is a real decision for that ticket (#216), which
     * has to choose between two panes on a 915 × 412dp window and a height or
     * `smallestScreenWidthDp` guard; it is recorded on [LayoutClass] rather than
     * left to be rediscovered there.
     */
    @Test
    fun `a phone in landscape is classified by its width`() {
        // Pixel 8: 412 × 915dp.
        assertEquals(LayoutClass.Compact, LayoutClass.ofWidth(412))
        assertEquals(LayoutClass.Expanded, LayoutClass.ofWidth(915))
    }

    /**
     * The native reading of `repeat(auto-fill, minmax(280px, 1fr))`, checked
     * against what the browser does with the same numbers.
     */
    @Test
    fun `columns match the web's auto-fill grid`() {
        fun columns(width: Int) =
            LayoutMetrics(LayoutClass.ofWidth(width), width.dp).columns(280.dp, gap = 14.dp)

        // A phone's column never fits two 280dp cards.
        assertEquals(1, columns(358))
        // 280 + 14 + 280 = 574.
        assertEquals(1, columns(573))
        assertEquals(2, columns(574))
        // 3 × 280 + 2 × 14 = 868, so one dp short of it is still two columns.
        assertEquals(2, columns(867))
        assertEquals(3, columns(868))
        // A capped page (1120 − 2 × 28) takes three, not four: four would need 1162.
        assertEquals(3, columns(1064))
    }

    /** A column narrower than one card still gets a card, as CSS does. */
    @Test
    fun `columns never fall below one`() {
        assertEquals(1, LayoutMetrics(LayoutClass.Compact, 0.dp).columns(280.dp))
        assertEquals(1, LayoutMetrics(LayoutClass.Compact, 40.dp).columns(280.dp))
    }

    /**
     * Narrowing carries the window's class through, which is what stops a narrow
     * detail pane redrawing itself as a phone in the two-pane work to come.
     */
    @Test
    fun `narrowing keeps the window's class`() {
        val page = LayoutMetrics(LayoutClass.Expanded, 1400.dp).narrowedTo(1064.dp)
        assertEquals(LayoutClass.Expanded, page.layoutClass)
        assertEquals(1064.dp, page.contentWidth)
        // Narrowing only ever narrows.
        assertEquals(1064.dp, page.narrowedTo(2000.dp).contentWidth)
    }

    /**
     * `PAGE_MAX` is generated from `--page-max`, so this is really a check that
     * the generator ran: a stylesheet change with no
     * `node apps/android/tools/generate-tokens.mjs` behind it fails here.
     */
    @Test
    fun `page tokens match the stylesheet`() {
        assertEquals(1120.dp, LayoutTokens.PAGE_MAX)
        assertEquals(28.dp, LayoutTokens.PAGE_GUTTER)
    }

    /** A phone keeps its tightened gutter; everything wider takes the web's. */
    @Test
    fun `page gutter widens above phone width`() {
        assertEquals(PHONE_PAGE_GUTTER, pageGutter(LayoutClass.Compact))
        assertEquals(LayoutTokens.PAGE_GUTTER, pageGutter(LayoutClass.Medium))
        assertEquals(LayoutTokens.PAGE_GUTTER, pageGutter(LayoutClass.Expanded))
    }

    /**
     * The pages that split ask their **own column**, not the window.
     *
     * The iPad bug this mirrors, in one assertion: a 13-inch tablet in portrait
     * is an expanded *window* — it has a sidebar — and its detail pane is 683dp,
     * 627 of it usable. Reading the class there said "two columns"; reading the
     * column says one. iOS's `LayoutClassTests` pins the same numbers, so a
     * change to either side fails the other.
     */
    @Test
    fun `a split needs the column's own width, not the window's class`() {
        fun width(contentWidth: Dp) =
            LayoutMetrics(LayoutClass.Expanded, contentWidth)
                .sideColumnWidth(0.46f, 380.dp, 620.dp)

        // The detail pane of a tablet in portrait with the sidebar showing.
        assertNull(width(627.dp))
        // …and in landscape, where there is room for both.
        assertNotNull(width(969.dp))
        // The threshold is the window's own, one level down.
        assertNull(width(LayoutClass.EXPANDED_MIN_DP.dp - 1.dp))
        assertNotNull(width(LayoutClass.EXPANDED_MIN_DP.dp))
    }

    /** The floor, the fraction and the ceiling, on real pane widths. */
    @Test
    fun `the side column stays between its floor and its ceiling`() {
        fun width(contentWidth: Dp) =
            LayoutMetrics(LayoutClass.Expanded, contentWidth)
                .sideColumnWidth(0.46f, 380.dp, 620.dp)

        // At the threshold the fraction is under the floor, so the floor holds.
        assertEquals(386.4f, width(840.dp)!!.value, 0.01f)
        // A tablet with the sidebar showing, landscape: the fraction.
        assertEquals(445.74f, width(969.dp)!!.value, 0.01f)
        // A very wide window spends the extra on the page, not on the chart.
        assertEquals(620.dp, width(2000.dp))
    }

    /** Whatever the width, the page keeps more of it than the column beside it. */
    @Test
    fun `the page keeps the larger half at every width`() {
        var content = 840
        while (content <= 2400) {
            val metrics = LayoutMetrics(LayoutClass.Expanded, content.dp)
            for ((fraction, bounds) in listOf(
                0.46f to (380.dp to 620.dp),  // event
                0.42f to (340.dp to 560.dp),  // vehicle
            )) {
                val side = metrics.sideColumnWidth(fraction, bounds.first, bounds.second)
                assertNotNull("no column at $content dp", side)
                assertTrue(side!! >= bounds.first && side <= bounds.second)
                assertTrue("page column squeezed at $content dp", content.dp - side > side)
            }
            content++
        }
    }
}

/**
 * That the published class actually follows the window.
 *
 * Robolectric, because the thing under test is the wiring rather than the
 * arithmetic: `ProvideLayoutMetrics` reads `Configuration.screenWidthDp`, and the
 * `w###dp` qualifiers are how that is set without a device. A class read once at
 * launch would pass every test above and fail this one.
 */
@RunWith(RobolectricTestRunner::class)
class ProvideLayoutMetricsTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    @Config(qualifiers = "w400dp-h800dp")
    fun `a phone window is compact`() {
        assertEquals(LayoutClass.Compact, publishedClass())
    }

    @Test
    @Config(qualifiers = "w700dp-h1000dp")
    fun `a 700dp window is medium`() {
        assertEquals(LayoutClass.Medium, publishedClass())
    }

    @Test
    @Config(qualifiers = "w1000dp-h800dp")
    fun `a 1000dp window is expanded`() {
        assertEquals(LayoutClass.Expanded, publishedClass())
    }

    /**
     * The content width is the window minus its gutters, so a grid inside counts
     * columns against the space it actually has.
     */
    @Test
    @Config(qualifiers = "w1000dp-h800dp")
    fun `content width has the gutters taken off`() {
        var width = 0.dp
        compose.setContent {
            ProvideLayoutMetrics { width = LocalLayoutMetrics.current.contentWidth }
        }
        compose.waitForIdle()
        assertEquals(1000.dp - LayoutTokens.PAGE_GUTTER * 2, width)
    }

    private fun publishedClass(): LayoutClass {
        var published = LayoutClass.Compact
        compose.setContent {
            ProvideLayoutMetrics { published = LocalLayoutMetrics.current.layoutClass }
        }
        compose.waitForIdle()
        return published
    }
}
