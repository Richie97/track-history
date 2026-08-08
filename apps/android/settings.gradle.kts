// Android client for Track Evolution (spec: docs/specs/native/NS-02-android-scaffold.md).
//
// Module layout is deliberate:
//   :core — pure Kotlin/JVM. Models, API client, recorder core, lap geometry,
//           offline queue. NO Android dependency, so its tests run as fast JVM
//           unit tests with no emulator. This is where every ported piece of
//           public/js logic lives.
//   :app  — Compose UI, services, platform integration. Needs the Android SDK.
//
// Configuring :app does require an SDK (local.properties / ANDROID_HOME), but
// `./gradlew :core:test` still runs without one, because Gradle only configures
// what a task needs. That is what keeps CI's core job SDK-free.

pluginManagement {
    repositories {
        google()
        gradlePluginPortal()
        mavenCentral()
    }
}
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.10.0"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "trackevolution"

include(":core")
include(":app")
