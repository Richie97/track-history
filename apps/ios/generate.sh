#!/bin/sh
# Regenerate TrackEvolution.xcodeproj from project.yml.
#
# The generated project is committed, so this only needs running after editing
# project.yml, adding a source directory, or changing Schemes/*.xcscheme.
#
#   brew install xcodegen   # once
#   apps/ios/generate.sh
set -eu

cd "$(dirname "$0")"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen not found — install it with: brew install xcodegen" >&2
  exit 1
fi

xcodegen generate

# XcodeGen can't express a scheme that points at a local package's test target,
# so the Kit scheme is hand-written and copied in afterwards.
mkdir -p TrackEvolution.xcodeproj/xcshareddata/xcschemes
cp Schemes/*.xcscheme TrackEvolution.xcodeproj/xcshareddata/xcschemes/

echo "Wrote TrackEvolution.xcodeproj"
