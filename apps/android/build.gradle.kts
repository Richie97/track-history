// Root build file. Plugins are declared `apply false` here and applied in the
// modules that need them, so adding :app later cannot disturb :core.

// Every plugin any module uses is resolved once here, including the ones only
// :app applies. The Kotlin JVM and Kotlin Android plugins are the same artifact,
// so declaring the version in two places makes Gradle refuse to resolve either
// ("already on the classpath with an unknown version").
plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.ksp) apply false
}
