import AVFoundation
import Photos
import PhotosUI
import SwiftUI

/// A video the user chose, as a URL we can read in place.
///
/// `name` is what the review screen shows and what the session's notes record —
/// "Imported from GX010042.MP4" — so it is the file's own name, not a temp path.
struct PickedVideo: Sendable, Hashable {
    var name: String
    var url: URL
}

/// Why a chosen video couldn't be read. Each has the web app's wording where one
/// exists, and each is a *stated outcome* rather than a spinner that stops.
enum PickerFailure: Error, Equatable, Sendable {
    /// The asset lives in iCloud and hasn't been downloaded to this phone.
    case notDownloaded(String)
    /// Slow-motion and edited clips come back as an `AVComposition` — there is no
    /// single file to read, and they carry no telemetry track anyway.
    case notFileBacked(String)
    /// Photos access was declined, so an asset can't be resolved to a file.
    case photoAccessDenied

    var message: String {
        switch self {
        case .notDownloaded(let name):
            "\(name) isn't downloaded to this phone. Open it in Photos or Files once to download it, then try again — importing it here would pull down the whole video."
        case .notFileBacked(let name):
            "\(name) is an edited or slow-motion clip, which iOS stores as a recipe rather than a file. Export the original, or pick it from Files instead."
        case .photoAccessDenied:
            "Track Evolution needs access to your photo library to read a clip's telemetry. You can grant it in Settings → Privacy → Photos."
        }
    }
}

/// The Photos route: `PHPickerViewController` configured against the shared photo
/// library, so its results carry an `assetIdentifier`.
///
/// That configuration is the whole point. Without a `photoLibrary:`, results are
/// anonymous item providers and the only way to get bytes is `loadFileRepresentation`,
/// which copies the entire clip first. With it, the identifier resolves to a
/// `PHAsset` whose `AVURLAsset` hands back the real file URL — at the cost of one
/// photo-library read permission, which is a price worth paying for not copying
/// gigabytes.
struct PhotoVideoPicker: UIViewControllerRepresentable {
    var onPicked: ([String]) -> Void
    var onCancel: () -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = .videos
        // A session is often several clips, and NS-30's batch anchoring needs the
        // batch: a beacon-timed recording re-anchors a beacon-less one beside it.
        config.selectionLimit = 0
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onPicked: onPicked, onCancel: onCancel)
    }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        private let onPicked: ([String]) -> Void
        private let onCancel: () -> Void

        init(onPicked: @escaping ([String]) -> Void, onCancel: @escaping () -> Void) {
            self.onPicked = onPicked
            self.onCancel = onCancel
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            let ids = results.compactMap(\.assetIdentifier)
            if ids.isEmpty { onCancel() } else { onPicked(ids) }
        }
    }
}

/// Resolving a picked `PHAsset` to a file URL, without downloading anything.
enum PhotoLibraryVideos {
    /// Ask for read access. Returns whether we have it.
    static func authorize() async -> Bool {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .authorized || status == .limited { return true }
        let granted = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        return granted == .authorized || granted == .limited
    }

    /// The file behind an asset, or a stated reason there isn't one.
    ///
    /// `isNetworkAccessAllowed` stays **false**: with it on, an iCloud-only clip
    /// downloads in full behind a spinner with no way to tell how long — which is
    /// the one thing a phone on track-day cellular must not do silently. The
    /// caller offers the download instead.
    static func fileURL(for localIdentifier: String) async throws -> PickedVideo {
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
        guard let asset = assets.firstObject else {
            throw PickerFailure.notFileBacked(localIdentifier)
        }
        let name = displayName(of: asset) ?? "Video"

        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = false
        options.deliveryMode = .highQualityFormat
        options.version = .current

        // The URL is pulled out *inside* the callback: `AVAsset` is not `Sendable`,
        // and a `URL` is — so nothing crosses the concurrency boundary but the one
        // value we actually want.
        let resolved: Result<URL, PickerFailure> = await withCheckedContinuation { continuation in
            PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { avAsset, _, _ in
                guard let avAsset else {
                    continuation.resume(returning: .failure(.notDownloaded(name)))
                    return
                }
                guard let urlAsset = avAsset as? AVURLAsset else {
                    continuation.resume(returning: .failure(.notFileBacked(name)))
                    return
                }
                continuation.resume(returning: .success(urlAsset.url))
            }
        }
        return PickedVideo(name: name, url: try resolved.get())
    }

    private static func displayName(of asset: PHAsset) -> String? {
        PHAssetResource.assetResources(for: asset).first?.originalFilename
    }
}
