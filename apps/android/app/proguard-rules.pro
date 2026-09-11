# R8 rules for the release build (release { isMinifyEnabled = true } in
# build.gradle.kts). Google Play scores obfuscation and shrinking per app and
# flags anything under 25%, which is why minification is on; this file carries
# only what the libraries' own consumer rules don't.
#
# Nothing in :core or :app is reached by reflection from our own code: models
# and routes are @Serializable (serializers are generated at compile time and
# kept by kotlinx.serialization's bundled rules), Room instantiates the
# database through a rule room-runtime ships, WorkManager keeps
# ListenableWorker subclasses itself, and the manifest's activities and
# services are kept by AGP's default rules. So there are deliberately no
# `-keep class app.trackevolution.**` rules here — adding one would hand back
# the obfuscation this exists to provide.

# Keep line numbers so an obfuscated stack trace, once run through the
# mapping.txt the deploy workflow uploads with the bundle, points at real lines.
# The source-file attribute is renamed rather than kept, so file names are not
# leaked while the line table stays usable.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# kotlinx.serialization: the generated serializers carry their field names as
# compile-time constants (every model spells its @SerialName explicitly), so
# member renaming is safe and the library's bundled rules keep the
# `Companion.serializer()` lookups that type-safe navigation resolves at run
# time. Nothing to add — this comment exists so nobody adds a blanket keep.
