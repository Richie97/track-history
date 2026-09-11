import Foundation

/// Keeps a clip dropped onto the app readable for as long as the import needs it
/// (NS-34 ticket 5).
///
/// It exists because of a lifetime mismatch. `NSItemProvider` vends the dropped
/// file as a URL that is valid **only inside its completion block**, and the
/// import that reads it starts a moment later, on a screen that has to be pushed
/// first. Something has to carry the file across that gap, and which thing
/// depends on how the drop arrived — see `EventScreen.droppedClip(from:then:)`,
/// which decides:
///
/// - A clip shared **in place** (a drag from Files) is borrowed under a security
///   scope. Opening the scope is what extends the URL; this holds it open.
/// - A clip the provider would only hand over **as a copy** has already been
///   copied, and the system deletes that copy the instant the callback returns.
///   The handler moves it somewhere of ours first, and this deletes it when it is
///   done — it is our file, and a track-day clip left behind is gigabytes in the
///   user's storage with nothing pointing at it.
///
/// One clip at a time, released the moment it is replaced. A dropped clip is a
/// thing you are importing right now, not a library, and holding two would mean
/// nobody could say when either was finished with. The cost of being wrong is one
/// re-drop; the cost of holding everything is a leak with no end.
///
/// `FileTelemetryByteSource` opens its own scope over the same URL when it reads;
/// the counts nest, and it stops the one it started. That is deliberate
/// duplication rather than an oversight: the byte source must work for a URL from
/// `.fileImporter` and from Photos too, so it cannot rely on anyone else having
/// opened one.
@MainActor
final class DroppedClip {
    static let shared = DroppedClip()

    private var held: URL?
    /// Whether `held` is a file of ours to delete rather than someone else's to
    /// let go of.
    private var heldIsOurs = false
    /// Whether a security scope was opened for `held` and so has to be closed.
    private var scopeOpen = false

    private init() {}

    /// Take over a clip, releasing the previous one.
    ///
    /// `scoped` is `startAccessingSecurityScopedResource`'s own answer, passed in
    /// rather than re-asked: a URL that never had a scope must not have one
    /// stopped, and only the caller knows which it was. `temporary` marks a copy
    /// the handler had to make, which this deletes on the way out.
    func hold(_ url: URL, scoped: Bool, temporary: Bool) {
        release()
        guard scoped || temporary else { return }
        held = url
        heldIsOurs = temporary
        if scoped { scopeOpen = true }
    }

    func release() {
        guard let url = held else { return }
        if scopeOpen { url.stopAccessingSecurityScopedResource() }
        if heldIsOurs {
            // The whole per-drop directory, not just the file in it.
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
        held = nil
        heldIsOurs = false
        scopeOpen = false
    }
}
