// :core — pure Kotlin/JVM.
//
// Everything ported from public/js lives here: domain models, the API client,
// the recorder core (NS-12), lap geometry (NS-14), and the offline cache/queue
// logic (NS-22). Keeping it Android-free is what lets those tests run in
// seconds on the JVM instead of minutes on an emulator, and it is enforced by
// the check at the bottom of this file.

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        // Warnings here are almost always real (nullability, unchecked casts)
        // in code that mirrors a dynamically typed original.
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    // `api`, not `implementation`: the models are @Serializable and the API
    // client's constructor takes an HttpClientEngine, so both leak into :core's
    // public surface and consumers need them on the compile classpath.
    api(libs.kotlinx.serialization.json)
    api(libs.ktor.client.core)
    // `api` as well: the offline layer (NS-22) publishes its sync status as a
    // StateFlow, which the banner in :app collects.
    api(libs.kotlinx.coroutines.core)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.ktor.client.mock)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("failed")
        showStackTraces = true
    }
}

// :core must never gain an Android dependency — that is the whole point of the
// module split. Fail the build rather than discover it when the tests suddenly
// need an emulator.
tasks.register("checkNoAndroidDependency") {
    val runtime = configurations.named("runtimeClasspath")
    doLast {
        val offenders = runtime.get().resolvedConfiguration.resolvedArtifacts
            .map { it.moduleVersion.id }
            .filter { it.group.startsWith("com.android") || it.group.startsWith("androidx") }
            .map { "${it.group}:${it.name}:${it.version}" }
            .distinct()
        check(offenders.isEmpty()) {
            ":core must stay Android-free, but found:\n  " + offenders.joinToString("\n  ")
        }
    }
}

tasks.named("check") { dependsOn("checkNoAndroidDependency") }
