// :app — Compose UI, services and platform integration (spec: NS-02).
//
// Everything that can be tested without an emulator belongs in :core instead.
// This module is the thin Android shell around it: activities, services,
// permissions, notifications, Android Auto later (NS-20).

import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
    // Navigation's type-safe routes are @Serializable classes, so :app needs the
    // same plugin :core has.
    alias(libs.plugins.kotlin.serialization)
}

// Read through Gradle's provider API rather than System.getenv, so a value is a
// tracked build input: changing a version override re-runs the build instead of
// being served a stale one from the cache. Blank counts as unset — GitHub Actions
// hands an omitted workflow input to the job as an empty string, not as nothing.
//
// An extension on Project rather than a plain top-level function: inside
// android { } the innermost receiver is the Android extension, and hanging this
// off Project is what makes it resolve against the script's own receiver.
fun Project.env(name: String): String? =
    providers.environmentVariable(name).orNull?.trim()?.takeIf { it.isNotEmpty() }

android {
    // Inherited from the web-view shell this replaced — load-bearing. It makes
    // this an in-place Play Store update that keeps ratings, the install base
    // and the App Links association in public/.well-known/assetlinks.json,
    // rather than a second listing.
    namespace = "app.trackevolution"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.trackevolution"
        // 26 keeps notification channels and the modern location APIs available
        // without compat gymnastics.
        minSdk = 26
        // Google Play requires the target to stay within a year of the latest
        // Android release, and enforces it at *upload*: from 31 Aug 2026, an
        // update targeting below 36 (Android 16) is simply refused. This is a
        // recurring annual deadline, not a one-off — expect to raise it again
        // around Aug 2027, and note the check is on the target, so bumping
        // compileSdk alone does nothing.
        targetSdk = 36
        // versionCode must be strictly greater than the highest already
        // uploaded to Play — including builds that were rejected, since a
        // rejected submission still burns its code (version code 1 was the
        // Android Auto submission Play rejected; 2 was the first accepted one).
        //
        // Every uploaded build sets TE_VERSION_CODE: the deploy workflow
        // (android-release.yml) derives it from main's commit count — strictly
        // monotonic, already far past anything burned in the Console — so the
        // per-merge internal-track uploads never need a human to mint numbers,
        // and its dispatch input can still override past whatever the Console
        // actually holds. The 3 below is only what local builds get; it is not
        // kept in step with Play.
        versionCode = env("TE_VERSION_CODE")?.toInt() ?: 3
        versionName = env("TE_VERSION_NAME") ?: "1.4"
    }

    signingConfigs {
        // The release build must be signed with the *existing* upload key, or
        // Play rejects the update as a different app (NS-27). So the key lives
        // in neither a checkout nor a keystore.properties file: the deploy
        // workflow writes it from a repository secret, and it dies with the
        // runner.
        val keystore = env("TE_UPLOAD_KEYSTORE")
        if (keystore != null) {
            create("upload") {
                storeFile = file(keystore)
                storePassword = env("TE_UPLOAD_KEYSTORE_PASSWORD")
                keyAlias = env("TE_UPLOAD_KEY_ALIAS")
                keyPassword = env("TE_UPLOAD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Without that environment — every local build — the release variant
            // stays *unsigned* rather than falling back to the debug key:
            // `assembleRelease` still works on a laptop, and an artifact signed
            // with anything but the real upload key cannot be produced by
            // accident. The deploy workflow verifies the signer before uploading.
            signingConfigs.findByName("upload")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        // BuildConfig.DEBUG gates the dev-server override on the sign-in screen
        // (NS-09), which must never be reachable in a release build.
        buildConfig = true
    }

    testOptions {
        unitTests {
            // Robolectric needs the merged resources and manifest to stand up
            // an Application; without this the offline-store and chart tests
            // fail at startup rather than at an assertion.
            isIncludeAndroidResources = true
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

ksp {
    // The schema is checked in. There is deliberately no destructive-migration
    // fallback (see OfflineDatabase): the write queue holds sessions that exist
    // nowhere else yet, so a future schema change owes this database a real
    // migration, and a committed schema is what makes that diffable in review.
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    // The pure-logic module. Depending on it here is what proves the module
    // split actually works end to end, rather than discovering at NS-16 that
    // the shell cannot consume it.
    implementation(project(":core"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.viewmodel.savedstate)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.security.crypto)
    implementation(libs.play.services.location)
    // Version floor only; see the note in libs.versions.toml.
    implementation(libs.androidx.fragment)

    // The engine :core's ApiClient is constructed with. Choosing it here rather
    // than there is what keeps :core a plain JVM module.
    implementation(libs.ktor.client.okhttp)

    // The durable half of NS-22: Room backs :core's OfflinePersistence, and
    // WorkManager is what replays the queue after the process is gone.
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.androidx.work.runtime.ktx)

    // The logbook's navigation (NS-26). Type-safe routes, so a deep link that
    // no longer matches fails to compile rather than at a tap.
    implementation(libs.androidx.navigation.compose)

    // Android Auto (NS-20) — DEBUG ONLY, and deliberately so. Shipping a
    // car-compatible artifact to Play is what got the app rejected under the car
    // app quality guidelines (PF-1: no meaningful POI functionality, because a
    // lap timer is not a POI app and no driving-task category exists). Keeping
    // these off the release classpath means a release APK cannot carry the Car
    // App Library at all. The manifest half is in src/debug/AndroidManifest.xml;
    // the sources are in src/debug/kotlin. See TrackAutoService.
    //
    // Still in :app rather than a separate :auto module because the car screen
    // drives the recorder directly and a library module cannot depend on an
    // application one.
    debugImplementation(libs.androidx.car.app)
    debugImplementation(libs.androidx.car.app.projected)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)

    debugImplementation(libs.compose.ui.tooling)

    // Robolectric — still no emulator. It runs Room against real SQLite for the
    // offline queue's durability (NS-22) and Compose itself for the charts'
    // degenerate datasets (NS-24).
    //
    // JUnit 4 rather than :core's JUnit 5: both the Robolectric runner and
    // Compose's test rule are JUnit 4, and pairing them with 5 costs an
    // extension for no benefit here.
    testImplementation(libs.junit4)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.kotlinx.coroutines.test)
    // Drives ApiClient without a server, so the form's track-name rule is
    // asserted against the bytes that would actually be sent.
    testImplementation(libs.ktor.client.mock)
    // Pairs with the debug-only car sources above: AutoRecordingTest lives in
    // src/testDebug, so a release unit-test compile never needs this.
    testDebugImplementation(libs.androidx.car.app.testing)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}

/**
 * A release build must not be an Android Auto app.
 *
 * Play rejected this app under the car app quality guidelines (`PF-1`) because
 * NS-20 declared the POI category for what is a lap timer, and there is no car
 * category a driving task fits. The car code still exists and is still tested,
 * but only in the `debug` source set — because the car review fires on any
 * submission carrying a car-compatible artifact while the Android Auto form
 * factor is opted in, and a failure in the production track rejects the *whole*
 * submission, freezing ordinary phone updates.
 *
 * That invariant is invisible: moving one <service> block back into
 * src/main/AndroidManifest.xml compiles, tests, and ships — and is only caught
 * weeks later by a store review. CI builds the debug variant only, so nothing
 * else would notice. Hence this, in the spirit of :core's
 * checkNoAndroidDependency.
 */
tasks.register("checkReleaseHasNoCarApp") {
    // Pure file I/O on purpose: nothing to resolve, so this behaves identically
    // with or without an Android SDK and cannot be broken by AGP creating its
    // variant configurations later than this script is evaluated.
    val mainManifest = layout.projectDirectory.file("src/main/AndroidManifest.xml").asFile
    val mainRes = layout.projectDirectory.dir("src/main/res").asFile
    val root = projectDir

    doLast {
        // Any one of these is enough to make the built artifact "Android Auto
        // compatible" as far as the Play review pipeline is concerned.
        val markers = listOf(
            "androidx.car.app.CarAppService",
            "androidx.car.app.category",
            "com.google.android.gms.car.application",
        )
        val sources = (listOf(mainManifest) + mainRes.walkTopDown().filter {
            it.isFile && it.extension == "xml"
        }).filter { it.exists() }

        val declaring = sources.mapNotNull { file ->
            markers.firstOrNull { file.readText().contains(it) }
                ?.let { "${file.relativeTo(root)} ($it)" }
        }
        check(declaring.isEmpty()) {
            "A release build must not declare an Android Auto app. Play rejects it " +
                "under car app quality PF-1, and a car rejection in the production " +
                "track blocks phone updates too. Move these to src/debug:\n  " +
                declaring.joinToString("\n  ")
        }
    }
}

tasks.named("check") { dependsOn("checkReleaseHasNoCarApp") }
