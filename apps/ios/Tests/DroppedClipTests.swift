import UniformTypeIdentifiers
import XCTest

@testable import TrackEvolution

/// Dropping a clip onto the event page (spec: NS-34 ticket 5).
///
/// A drag *session* between Files and this app is not something a simulator can
/// be made to perform, so the test starts where the drop lands: an
/// `NSItemProvider` over a real file, which is what the system hands the drop
/// handler. That covers the two decisions in it — which providers are taken, and
/// that the clip is read where it lies rather than copied — and leaves only the
/// drag itself to a manual pass.
///
/// `@MainActor` because `DroppedClip` is: the holder guards a security scope that
/// the UI hands over and the importer reads, so it has one home and the test
/// keeps to it. `wait(for:)` still services the main queue, which is how the
/// handler's own hop back to the main actor lands.
@MainActor
final class DroppedClipTests: XCTestCase {
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("drop-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        DroppedClip.shared.release()
        try? FileManager.default.removeItem(at: scratch)
    }

    /// A file provider is typed by its extension, which is how a dropped `.mp4`
    /// arrives. The bytes are irrelevant here — nothing parses them until the
    /// import screen does.
    private func provider(named name: String) throws -> NSItemProvider {
        let url = scratch.appendingPathComponent(name)
        try Data("not really a video".utf8).write(to: url)
        let provider = try XCTUnwrap(NSItemProvider(contentsOf: url))
        // Set explicitly: a provider built in-process doesn't carry one, while a
        // real drag from Files does, and the name is what the imported session's
        // notes quote. Without it the handler can only use the system's invented
        // temp name, which is the best available and not worth pretending about.
        provider.suggestedName = name
        return provider
    }

    /// A file in a directory of its own, as `droppedClip` keeps one.
    private func boxed(_ name: String) throws -> URL {
        let box = scratch.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: box, withIntermediateDirectories: true)
        let url = box.appendingPathComponent(name)
        try Data().write(to: url)
        return url
    }

    /// Somewhere for the main-actor callback to leave its answer. Unchecked
    /// because the only write is on the main actor and the only read is after
    /// `wait(for:)` has seen it happen.
    private final class Delivered: @unchecked Sendable {
        var url: URL?
    }

    func testAClipIsTakenAndOpenedWhereItLies() throws {
        let opened = expectation(description: "opened")
        let delivered = Delivered()

        let accepted = EventScreen.droppedClip(from: [try provider(named: "lap.mp4")]) { url in
            delivered.url = url
            opened.fulfill()
        }

        XCTAssertTrue(accepted, "a video provider should be accepted")
        wait(for: [opened], timeout: 10)
        let url = try XCTUnwrap(delivered.url)
        // The assertion that matters, and the one that caught the bug this
        // handler was written around: the file is **still there** when the
        // importer would open it. A provider that won't share the original hands
        // back a copy it deletes the moment the callback returns, so a handler
        // that merely passes that URL along delivers a path to nothing.
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: url.path),
            "the dropped clip must outlive the drop callback"
        )
        // And it keeps its own name, because the imported session's notes quote
        // it — "Imported from lap.mp4", never the provider's invented temp name.
        XCTAssertEqual(url.lastPathComponent, "lap.mp4")
    }

    /// The in-place branch is the one a real drag from Files takes, and it is the
    /// branch a simulator cannot produce: an `NSItemProvider` built in-process
    /// copies instead. So this pins the *other* half — that a copy the system made
    /// is adopted rather than borrowed, which is what makes it safe to delete.
    func testACopiedClipIsAdoptedSoItCanBeCleanedUp() throws {
        let opened = expectation(description: "opened")
        let delivered = Delivered()
        _ = EventScreen.droppedClip(from: [try provider(named: "lap.mp4")]) { url in
            delivered.url = url
            opened.fulfill()
        }
        wait(for: [opened], timeout: 10)
        let url = try XCTUnwrap(delivered.url)
        XCTAssertFalse(
            url.path.hasPrefix(scratch.path),
            "the provider's copy, moved somewhere of ours — not the file the test wrote"
        )

        DroppedClip.shared.release()
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: url.path),
            "a copy we made is a copy we delete: a track-day clip left behind is gigabytes"
        )
    }

    /// A `.mov` is a movie too — the file importer takes QuickTime alongside MP4,
    /// and a drop must not be fussier than the picker beside it.
    func testQuickTimeIsAClipToo() throws {
        let opened = expectation(description: "opened")
        let accepted = EventScreen.droppedClip(from: [try provider(named: "lap.mov")]) { _ in
            opened.fulfill()
        }
        XCTAssertTrue(accepted)
        wait(for: [opened], timeout: 10)
    }

    /// Anything that isn't a video is declined rather than swallowed, so the drop
    /// bounces back to where it came from instead of pushing an importer that
    /// would then have to explain itself.
    func testSomethingThatIsNotAVideoIsDeclined() throws {
        let delivered = Delivered()
        let accepted = EventScreen.droppedClip(from: [try provider(named: "notes.txt")]) { url in
            delivered.url = url
        }
        XCTAssertFalse(accepted)
        XCTAssertNil(delivered.url)
    }

    func testAnEmptyDropIsDeclined() {
        XCTAssertFalse(EventScreen.droppedClip(from: []) { _ in })
    }

    /// One clip at a time: taking a new one lets go of the previous one, and a
    /// release leaves nothing behind. Both files here are `temporary`, which is
    /// the case with something to observe — a scope is a kernel grant with no
    /// reader, a file either exists or does not.
    func testHoldingASecondClipReleasesTheFirst() throws {
        // A directory each, the way the handler stores them — it keeps a clip in
        // a box of its own so the file can carry its real name, and releasing
        // removes the box.
        let first = try boxed("first.mp4")
        let second = try boxed("second.mp4")

        DroppedClip.shared.hold(first, scoped: false, temporary: true)
        DroppedClip.shared.hold(second, scoped: false, temporary: true)
        // Taking the second let go of the first, so only the second is still
        // being held — and releasing now cleans up that one alone.
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.path))
        DroppedClip.shared.release()
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.path))
    }
}
