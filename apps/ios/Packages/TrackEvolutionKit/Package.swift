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
    dependencies: [
        // The offline cache and write queue (NS-21). SQL rather than SwiftData
        // because the queue needs explicit ordering, temp-id rewriting, and a
        // queued write plus its optimistic cache patch committing in one
        // transaction — an object graph fights all three.
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0")
    ],
    targets: [
        .target(name: "TrackEvolutionKit", dependencies: [.product(name: "GRDB", package: "GRDB.swift")]),
        .testTarget(name: "TrackEvolutionKitTests", dependencies: ["TrackEvolutionKit"])
    ]
)
