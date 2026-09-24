import CoreGraphics
import XCTest

@testable import TrackEvolution

/// Turning a fold into a posture (epic #277, ticket 3).
///
/// The first half is `FoldsTest.kt`'s cases, one for one and with the same
/// numbers, because `Folds.geometry` is a port and the two must decide the same
/// posture from the same fold. The second half is iOS's own reduction — the
/// division reserved region to the three plain values — which is arithmetic
/// worth pinning even though the region itself can only come from hardware or
/// Xcode 27.1's Device Hub.
final class FoldsTests: XCTestCase {

    // MARK: - FoldsTest.kt

    func testAFlatDeviceHasNoPostureWhateverItsHingeSays() {
        XCTAssertEqual(Folds.geometry(halfOpened: false, horizontal: true, hingeFraction: 0.5), Folds.FLAT)
        XCTAssertEqual(Folds.geometry(halfOpened: false, horizontal: false, hingeFraction: 0.5), Folds.FLAT)
    }

    func testHalfOpenAcrossTheMiddleIsTabletopAlongItIsBook() {
        XCTAssertEqual(
            Folds.geometry(halfOpened: true, horizontal: true, hingeFraction: 0.5),
            FoldGeometry(posture: .tabletop, hingeFraction: 0.5)
        )
        XCTAssertEqual(
            Folds.geometry(halfOpened: true, horizontal: false, hingeFraction: 0.5),
            FoldGeometry(posture: .book, hingeFraction: 0.5)
        )
    }

    func testAnUnknownHingePositionIsAssumedToBeTheMiddle() {
        let geometry = Folds.geometry(halfOpened: true, horizontal: true, hingeFraction: nil)
        XCTAssertEqual(geometry.posture, .tabletop)
        XCTAssertEqual(geometry.hingeFraction ?? -1, 0.5, accuracy: 1e-6)
    }

    /// One of the two halves would be too small to read anything in, and the
    /// ordinary layout is a better answer than a deliberate sliver.
    func testAHingeFarFromTheMiddleFallsBackToFlat() {
        XCTAssertEqual(Folds.geometry(halfOpened: true, horizontal: true, hingeFraction: 0.05), Folds.FLAT)
        XCTAssertEqual(Folds.geometry(halfOpened: true, horizontal: true, hingeFraction: 0.95), Folds.FLAT)
        XCTAssertNil(Folds.geometry(halfOpened: true, horizontal: false, hingeFraction: 0.9).hingeFraction)
    }

    /// The edges of what counts as usable, which is where an off-by-one sits —
    /// and, in `Double`, where 0.5 − 0.35 is not quite 0.15.
    func testTheLimitsThemselvesAreStillPostures() {
        XCTAssertEqual(Folds.geometry(halfOpened: true, horizontal: true, hingeFraction: 0.15).posture, .tabletop)
        XCTAssertEqual(Folds.geometry(halfOpened: true, horizontal: true, hingeFraction: 0.85).posture, .tabletop)
        XCTAssertEqual(Folds.geometry(halfOpened: true, horizontal: true, hingeFraction: 0.1499).posture, .flat)
        XCTAssertEqual(Folds.HINGE_LIMIT, 0.35, "the same limit as Android's HINGE_LIMIT")
    }

    // MARK: - The division region

    /// No region, or an empty one, is a device held flat: the region is only
    /// active while the device is partially folded.
    func testNoDivisionRegionIsFlat() {
        let window = CGSize(width: 890, height: 626)
        XCTAssertEqual(Folds.geometry(division: nil, in: window), Folds.FLAT)
        XCTAssertEqual(Folds.geometry(division: .zero, in: window), Folds.FLAT)
        XCTAssertEqual(Folds.geometry(division: CGRect(x: 0, y: 300, width: 890, height: 0), in: window), Folds.FLAT)
    }

    /// The Duo on a dash: the hinge across the window, a little below centre.
    func testAHorizontalRegionIsTabletopAtItsCentre() {
        let window = CGSize(width: 890, height: 626)
        let hinge = CGRect(x: 0, y: 330, width: 890, height: 28)
        let geometry = Folds.geometry(division: hinge, in: window)
        XCTAssertEqual(geometry.posture, .tabletop)
        XCTAssertEqual(geometry.hingeFraction ?? -1, 344.0 / 626.0, accuracy: 1e-9)
    }

    /// Held like a book: a vertical region, measured across the width.
    func testAVerticalRegionIsBookAcrossTheWidth() {
        let window = CGSize(width: 626, height: 890)
        let hinge = CGRect(x: 299, y: 0, width: 28, height: 890)
        let geometry = Folds.geometry(division: hinge, in: window)
        XCTAssertEqual(geometry.posture, .book)
        XCTAssertEqual(geometry.hingeFraction ?? -1, 313.0 / 626.0, accuracy: 1e-9)
    }

    func testARegionAgainstAnEdgeIsNotAPosture() {
        let window = CGSize(width: 890, height: 626)
        let hinge = CGRect(x: 0, y: 590, width: 890, height: 20)
        XCTAssertEqual(Folds.geometry(division: hinge, in: window), Folds.FLAT)
    }

    // MARK: - The split

    /// Android's `coerceIn(0.2f, 0.8f)`: the hinge decides, but neither half is
    /// ever a sliver. (Anything past 0.15/0.85 is already flat, so only the band
    /// between the two limits is ever clamped.)
    func testTheTopShareFollowsTheHingeWithinAFifthOfEitherEdge() {
        XCTAssertEqual(Folds.tabletopTopShare(FoldGeometry(posture: .tabletop, hingeFraction: 0.55)), 0.55, accuracy: 1e-9)
        XCTAssertEqual(Folds.tabletopTopShare(FoldGeometry(posture: .tabletop, hingeFraction: 0.16)), 0.2, accuracy: 1e-9)
        XCTAssertEqual(Folds.tabletopTopShare(FoldGeometry(posture: .tabletop, hingeFraction: 0.84)), 0.8, accuracy: 1e-9)
        XCTAssertEqual(Folds.tabletopTopShare(FoldGeometry(posture: .tabletop, hingeFraction: nil)), 0.5, accuracy: 1e-9)
    }

    // MARK: - The words

    /// Android's `attachmentText`, word for word.
    func testTheAttachmentLineIsAndroids() {
        XCTAssertEqual(RecordingScreen.attachmentText(isAttached: true, eventLabel: "VIR"), "Laps will be saved to VIR.")
        XCTAssertEqual(RecordingScreen.attachmentText(isAttached: true), "Laps will be saved to this event.")
        XCTAssertEqual(
            RecordingScreen.attachmentText(isAttached: false),
            "Not attached to an event yet — you can create one after."
        )
    }
}
