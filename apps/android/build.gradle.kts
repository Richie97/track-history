// Root build file. Plugins are declared `apply false` here and applied in the
// modules that need them, so adding :app later cannot disturb :core.

plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
