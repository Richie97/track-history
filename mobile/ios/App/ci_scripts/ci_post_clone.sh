#!/bin/sh
# Xcode Cloud post-clone hook. Xcode Cloud only runs scripts from a ci_scripts
# directory next to the workspace (mobile/ios/App/), and a fresh clone has no
# node_modules/, www/, or Pods/ — without this the archive fails with
# "Unable to open base configuration reference file ... Pods-App.release.xcconfig".
set -e
set -x

command -v node >/dev/null 2>&1 || brew install node
command -v pod >/dev/null 2>&1 || brew install cocoapods

cd "$CI_PRIMARY_REPOSITORY_PATH/mobile"
npm ci
node scripts/sync-www.mjs
npx cap sync ios
