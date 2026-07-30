// Android client for Track Evolution (spec: docs/specs/native/NS-02-android-scaffold.md).
//
// Module layout is deliberate:
//   :core — pure Kotlin/JVM. Models, API client, recorder core, lap geometry,
//           offline queue. NO Android dependency, so its tests run as fast JVM
//           unit tests with no emulator. This is where every ported piece of
//           public/js logic lives.
//   :app  — Compose UI, services, platform integration. Added once the Android
//           SDK is available; it is deliberately absent here so that
//           `./gradlew :core:test` configures and runs without an SDK install.

pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
    }
}

rootProject.name = "trackevolution"

include(":core")
