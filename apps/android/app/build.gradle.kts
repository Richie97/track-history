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
}

android {
    // Identical to the Capacitor app in mobile/android — load-bearing. It makes
    // this an in-place Play Store update that keeps ratings, the install base
    // and the App Links association in public/.well-known/assetlinks.json,
    // rather than a second listing.
    namespace = "app.trackevolution"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.trackevolution"
        // 26 keeps notification channels and the modern location APIs available
        // without compat gymnastics.
        minSdk = 26
        targetSdk = 35
        // Carried over from mobile/android/app/build.gradle. NS-27 owns the
        // rollout and must raise versionCode above whatever is live on Play
        // before the first upload, or it will be rejected.
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Signing is deliberately unconfigured: the release build must use
            // the *existing* upload key or Play rejects the update as a
            // different app. NS-27 wires that up with the real keystore.
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
            // an Application; without this the Compose chart tests fail at
            // startup rather than at an assertion.
            isIncludeAndroidResources = true
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
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
    implementation(libs.androidx.browser)
    implementation(libs.androidx.security.crypto)
    implementation(libs.play.services.location)
    // Version floor only; see the note in libs.versions.toml.
    implementation(libs.androidx.fragment)

    // The engine :core's ApiClient is constructed with. Choosing it here rather
    // than there is what keeps :core a plain JVM module.
    implementation(libs.ktor.client.okhttp)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)

    debugImplementation(libs.compose.ui.tooling)

    // Compose under Robolectric — still no emulator. This is what lets the
    // chart tests assert the degenerate datasets render and that TalkBack has
    // something to read.
    //
    // JUnit 4 rather than :core's JUnit 5: both the Robolectric runner and
    // Compose's test rule are JUnit 4, and pairing them with 5 costs an
    // extension for no benefit here.
    testImplementation(libs.junit4)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}
