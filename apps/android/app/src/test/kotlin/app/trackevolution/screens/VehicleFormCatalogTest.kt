package app.trackevolution.screens

import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import app.trackevolution.core.model.CatalogCar
import app.trackevolution.core.model.Vehicle
import app.trackevolution.ui.theme.TrackTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The *Edit car* form's catalog picker (#222), driven through the screen.
 *
 * The matching and the pre-fill rule are pure and pinned in `GarageTest`; what
 * this checks is the wiring — that a pick lands in the two number fields, that a
 * typed name survives it, that the driver's own number is asked about rather
 * than replaced, and that clearing the pick keeps the numbers. Each of those is
 * a rule the ticket states, and each is the kind of thing a refactor of the form
 * breaks without a compile error.
 *
 * The window is tall on purpose: the form is not scrollable on its own (the
 * page's `LazyColumn` scrolls it), so on Robolectric's default screen the
 * catalog field and the Save button sit below the fold, a `performClick` lands
 * on nothing, and every assertion after it fails for a reason that has nothing
 * to do with the picker.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w480dp-h2400dp")
class VehicleFormCatalogTest {

    @get:Rule
    val compose = createComposeRule()

    private val catalog = listOf(
        car(1, "Chevrolet", "Corvette", "C7", 2014, 2019, 2710, 16.25),
        car(2, "Chevrolet", "Corvette", "C8", 2020, null, 2722, 15.7),
        car(3, "Mazda", "MX-5", "ND", 2015, null, 2310, 15.5),
    )

    @Test
    fun `picking a car fills both numbers and keeps the name`() {
        var saved: VehicleEdit? = null
        show(vehicle(name = "Betty"), onSave = { saved = it })

        compose.onNodeWithTag("pickCatalogCar").performClick()
        compose.onNodeWithTag("catalogSearch").performTextInput("c7")
        compose.onNodeWithText("Chevrolet Corvette · C7 · 2014–2019").performClick()

        compose.onNodeWithTag("wheelbaseField").assertTextContains("2710")
        compose.onNodeWithTag("steeringRatioField").assertTextContains("16.25")
        compose.onNodeWithTag("catalogSource").assertTextContains("test")

        compose.onNodeWithText("Save").performClick()
        val edit = requireNotNull(saved)
        assertEquals("Betty", edit.name)
        assertEquals(1, edit.catalogId)
        assertEquals(2710, edit.wheelbaseMm)
        assertEquals(16.25, edit.steeringRatio!!, 0.0)
    }

    @Test
    fun `a hand-typed number is asked about, not replaced`() {
        show(vehicle(name = "Betty", wheelbaseMm = 2700, steeringRatio = 15.0))

        compose.onNodeWithTag("pickCatalogCar").performClick()
        compose.onNodeWithTag("catalogSearch").performTextInput("c7")
        compose.onNodeWithText("Chevrolet Corvette · C7 · 2014–2019").performClick()

        // Nothing moved on its own…
        compose.onNodeWithTag("wheelbaseField").assertTextContains("2700")
        compose.onNodeWithTag("steeringRatioField").assertTextContains("15")
        // …and each field got its own question.
        assertEquals(2, compose.onAllNodesWithText("Use the catalog's").fetchSemanticsNodes().size)
        compose.onAllNodesWithText("Use the catalog's")[0].performClick()
        compose.onNodeWithTag("wheelbaseField").assertTextContains("2710")
        compose.onNodeWithText("Keep mine").performClick()
        compose.onNodeWithTag("steeringRatioField").assertTextContains("15")
    }

    @Test
    fun `re-picking replaces the previous pick's numbers silently`() {
        // The stored numbers are the C7's, from the C7 row.
        show(vehicle(name = "Betty", catalogId = 1, wheelbaseMm = 2710, steeringRatio = 16.25))

        compose.onNodeWithTag("pickCatalogCar").performClick()
        compose.onNodeWithTag("catalogSearch").performTextInput("c8")
        compose.onNodeWithText("Chevrolet Corvette · C8 · 2020–").performClick()

        compose.onNodeWithTag("wheelbaseField").assertTextContains("2722")
        compose.onNodeWithTag("steeringRatioField").assertTextContains("15.7")
        assertEquals(0, compose.onAllNodesWithText("Use the catalog's").fetchSemanticsNodes().size)
    }

    @Test
    fun `clearing the pick keeps the numbers`() {
        var saved: VehicleEdit? = null
        show(vehicle(name = "Betty", catalogId = 1, wheelbaseMm = 2710, steeringRatio = 16.25), onSave = { saved = it })

        compose.onNodeWithTag("clearCatalogCar").performClick()
        compose.onNodeWithTag("wheelbaseField").assertTextContains("2710")
        compose.onNodeWithText("Save").performClick()

        val edit = requireNotNull(saved)
        assertNull(edit.catalogId)
        assertEquals(2710, edit.wheelbaseMm)
        assertEquals(16.25, edit.steeringRatio!!, 0.0)
    }

    private fun show(vehicle: Vehicle, onSave: (VehicleEdit) -> Unit = {}) {
        compose.setContent {
            TrackTheme {
                VehicleForm(vehicle, catalog = catalog, catalogError = null, onCancel = {}, onSave = onSave)
            }
        }
    }

    private fun vehicle(
        name: String,
        catalogId: Int? = null,
        wheelbaseMm: Int? = null,
        steeringRatio: Double? = null,
    ) = Vehicle(
        id = 1,
        name = name,
        isDefault = true,
        catalogId = catalogId,
        wheelbaseMm = wheelbaseMm,
        steeringRatio = steeringRatio,
    )

    private fun car(
        id: Int, make: String, model: String, generation: String?, from: Int, to: Int?, wheelbase: Int, ratio: Double?,
    ) = CatalogCar(
        id = id, make = make, model = model, generation = generation, yearFrom = from, yearTo = to,
        wheelbaseMm = wheelbase, steeringRatio = ratio, source = "test",
    )
}
