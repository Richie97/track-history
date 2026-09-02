import SwiftUI
import TrackEvolutionKit
import UniformTypeIdentifiers

/// Pick a video on the phone and get lap times out of it (NS-30).
///
/// The web app's **Import video / telemetry…** does this on a laptop; this does it
/// on the device that already has the footage — a GoPro clip arrives over Wi-Fi
/// into Photos, a Corvette PDR clip lands in Files off a USB stick, and both are
/// usually there before the laptop is opened.
///
/// Two phases on one screen: choose, then review. The review half is the *same*
/// `ReviewScreen` a stopped recording goes through, because the laps, the line
/// picker and the save are the same job.
struct ImportScreen: View {
    /// The event this import came from, pre-selected in the review's event picker.
    var eventId: Int?
    /// A clip handed straight to the app by Files or the share sheet.
    var incoming: URL?

    @Environment(AppRouter.self) private var router
    @Environment(AuthController.self) private var auth
    @State private var model = ImportModel()
    @State private var showingFileImporter = false
    @State private var showingPhotoPicker = false
    @State private var showingPaywall = false

    /// The Pro gate (NS-32 rule 5), from the cached entitlement, so an import in a
    /// paddock with no signal proceeds for a driver who was Pro at the last sync.
    /// Off until phase D flips `Entitlement.gatesEnabled`.
    private var gate: ProGate.Decision {
        ProGate.decide(.videoImport, entitlement: auth.entitlement)
    }

    var body: some View {
        Group {
            if let clips = model.clips {
                ReviewScreen(source: .imported(clips), preferredEventId: eventId, onFinish: { router.popToRoot() })
            } else {
                ScrollView {
                    if gate == .paywall {
                        gated
                            .padding(TESpacing.pageGutter)
                    } else {
                        chooser
                            .padding(TESpacing.pageGutter)
                    }
                }
                .background(Color(.bgPage))
                .navigationTitle("Import video")
                .navigationBarTitleDisplayMode(.inline)
            }
        }
        // Keyed on the gate: a clip handed over by Files while free is parsed the
        // moment a subscription made from the sheet lands, not lost.
        .task(id: gate) {
            if gate == .proceed, let incoming, model.clips == nil, !model.isParsing {
                await model.parse([PickedVideo(name: incoming.lastPathComponent, url: incoming)])
            }
        }
    }

    /// What a free account sees instead of the pickers: the paywall, one tap away,
    /// rather than disabled buttons that explain nothing.
    private var gated: some View {
        VStack(alignment: .leading, spacing: TESpacing.gridGap) {
            TECard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Telemetry import is a Pro feature")
                        .teStyle(.h3)
                        .foregroundStyle(Color(.textStrong))
                    Text("""
                        Corvette PDR and GoPro clips carry telemetry alongside the picture. Track \
                        Evolution Pro reads it on this phone — the video never leaves it — and turns \
                        it into lap times and channel graphs.
                        """)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                    Button("See Track Evolution Pro") { showingPaywall = true }
                        .buttonStyle(TEButtonStyle(kind: .accent))
                        .accessibilityIdentifier("importPaywall")
                        .sheet(isPresented: $showingPaywall) {
                            PaywallSheet(context: .videoImport)
                        }
                }
            }
        }
    }

    @ViewBuilder
    private var chooser: some View {
        VStack(alignment: .leading, spacing: TESpacing.gridGap) {
            TECard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Lap times from video")
                        .teStyle(.h3)
                        .foregroundStyle(Color(.textStrong))
                    Text("""
                        Corvette PDR and GoPro clips carry telemetry alongside the picture. \
                        Pick one and the laps come out of it here — the video never leaves \
                        this phone and is never copied; only its telemetry track is read.
                        """)
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))

                    if model.isParsing {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text(model.progress)
                                .teStyle(.sm)
                                .foregroundStyle(Color(.textMuted))
                        }
                        Button("Cancel") { model.cancel() }
                            .buttonStyle(TEButtonStyle(kind: .quiet))
                    } else {
                        filesButton
                        photosButton
                    }

                    if let failure = model.failure {
                        TEErrorBanner(message: failure)
                    }
                }
            }

            TECard {
                VStack(alignment: .leading, spacing: 6) {
                    Text("What works")
                        .teStyle(.eyebrow)
                        .foregroundStyle(Color(.textMuted))
                    Text("""
                        A PDR clip recorded with the track's beacon arrives with exact lap \
                        times and needs nothing from you. A GoPro clip, or a PDR one without \
                        beacons, has GPS but no lap markers — tap where the start/finish line \
                        is and every pass across it is timed.
                        """)
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                    Text("""
                        `.vbo` and other logger files stay on the web app, where the screen is \
                        bigger and the SD card is already in the laptop.
                        """)
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                }
            }
        }
    }
    /// Each picker lives on its own view with exactly **one** presentation
    /// modifier, and only in the chooser phase.
    ///
    /// Two modals attached to one view is a documented way to wedge SwiftUI here
    /// (see `apps/ios/README.md`), and the obvious shape — `.fileImporter` and
    /// `.sheet` both hung off this screen's root — would have kept them attached
    /// through the review phase too, next to the review's own confirmation dialog.
    /// Splitting them costs nothing and keeps the rule intact.
    private var filesButton: some View {
        Button("Choose from Files") { showingFileImporter = true }
            .buttonStyle(TEButtonStyle(kind: .accent))
            .accessibilityIdentifier("importFromFiles")
            .fileImporter(
                isPresented: $showingFileImporter,
                // Multiple selection from the start: a session is often several
                // clips, and the batch is what lets a beacon-timed PDR recording
                // re-anchor a beacon-less one beside it.
                allowedContentTypes: [.mpeg4Movie, .quickTimeMovie, .movie],
                allowsMultipleSelection: true
            ) { result in
                switch result {
                case .success(let urls):
                    Task {
                        await model.parse(urls.map { PickedVideo(name: $0.lastPathComponent, url: $0) })
                    }
                case .failure(let error):
                    model.failure = error.localizedDescription
                }
            }
    }

    private var photosButton: some View {
        Button("Choose from Photos") {
            Task {
                if await model.authorizePhotos() { showingPhotoPicker = true }
            }
        }
        .buttonStyle(TEButtonStyle(kind: .quiet))
        .accessibilityIdentifier("importFromPhotos")
        .sheet(isPresented: $showingPhotoPicker) {
            PhotoVideoPicker(
                onPicked: { ids in
                    showingPhotoPicker = false
                    Task { await model.parsePhotos(ids) }
                },
                onCancel: { showingPhotoPicker = false }
            )
            .ignoresSafeArea()
        }
    }
}

/// Picking and parsing, and the states in between.
///
/// The parse runs in one task off the main actor with the `FileHandle` confined to
/// it, and checks for cancellation between samples — a driver who picked the wrong
/// 4 GB clip must be able to back out.
@MainActor
@Observable
final class ImportModel {
    /// nil until a selection has been parsed; then the review takes over.
    private(set) var clips: [ImportedClip]?
    private(set) var isParsing = false
    private(set) var progress = ""
    var failure: String?

    private var task: Task<Void, Never>?

    func authorizePhotos() async -> Bool {
        if await PhotoLibraryVideos.authorize() { return true }
        failure = PickerFailure.photoAccessDenied.message
        return false
    }

    /// Resolve picked assets to files without downloading anything, then parse.
    func parsePhotos(_ localIdentifiers: [String]) async {
        var picks: [PickedVideo] = []
        var problems: [String] = []
        for id in localIdentifiers {
            do {
                picks.append(try await PhotoLibraryVideos.fileURL(for: id))
            } catch let failure as PickerFailure {
                problems.append(failure.message)
            } catch {
                problems.append(error.localizedDescription)
            }
        }
        failure = problems.isEmpty ? nil : problems.joined(separator: "\n\n")
        if picks.isEmpty { return }
        await parse(picks)
    }

    func parse(_ picks: [PickedVideo]) async {
        guard !picks.isEmpty else { return }
        task?.cancel()
        isParsing = true
        progress = "Reading telemetry from \(picks.count) file\(picks.count == 1 ? "" : "s")…"

        let work = Task { [picks] in
            do {
                let parsed = try await TelemetryImporter.parse(picks)
                await MainActor.run {
                    self.clips = parsed
                    self.isParsing = false
                }
            } catch is CancellationError {
                await MainActor.run { self.isParsing = false }
            } catch {
                await MainActor.run {
                    self.failure = error.localizedDescription
                    self.isParsing = false
                }
            }
        }
        task = work
        await work.value
    }

    func cancel() {
        task?.cancel()
        task = nil
        isParsing = false
    }
}
