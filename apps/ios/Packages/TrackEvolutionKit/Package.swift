// swift-tools-version: 6.0
import PackageDescription

// The pure-logic module shared by the app, the CarPlay scene and the tests.
// It builds for macOS as well as iOS on purpose: `swift test` then runs the
// whole suite natively, with no simulator to boot. Nothing in here may import
// UIKit or SwiftUI — see apps/ios/README.md.
let package = Package(
    name: "TrackEvolutionKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "TrackEvolutionKit", targets: ["TrackEvolutionKit"])
    ],
    targets: [
        .target(name: "TrackEvolutionKit"),
        .testTarget(name: "TrackEvolutionKitTests", dependencies: ["TrackEvolutionKit"])
    ]
)
