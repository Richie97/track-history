import AVFoundation
import SwiftUI
import UIKit

/// A player's picture and nothing else (NS-51): an `AVPlayerLayer`, letterboxed.
///
/// Not `AVPlayerViewController`, which the lap page used to embed: its controls
/// drive one player, can't keep a second in step, and can't draw the delta — the
/// stage's own transport does all three. The platform's fullscreen control goes
/// with it; the stage's full-bleed replaces it.
struct StageVideoView: UIViewRepresentable {
    let player: AVPlayer?

    func makeUIView(context: Context) -> PlayerLayerView {
        let view = PlayerLayerView()
        view.playerLayer.videoGravity = .resizeAspect
        view.backgroundColor = .black
        view.playerLayer.player = player
        return view
    }

    func updateUIView(_ view: PlayerLayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }

    /// A view whose backing layer *is* the player layer, so it resizes with the
    /// view and needs no layout code.
    final class PlayerLayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
