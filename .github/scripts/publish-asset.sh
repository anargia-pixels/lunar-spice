#!/usr/bin/env bash
# Publishes one built asset to the GitHub release for $RELEASE_TAG as soon as its job
# finishes, so one platform's release does not wait on, or fail with, another's build.
# Usage: publish-asset.sh <asset-path>
# Needs GH_TOKEN and RELEASE_TAG in the environment.
set -euo pipefail

asset=$1

# The first job to finish creates the release. Two jobs can race here, so a failed
# create is fine as long as the release exists afterwards.
if ! gh release view "$RELEASE_TAG" >/dev/null 2>&1; then
  gh release create "$RELEASE_TAG" --verify-tag \
    --title "Lunar Spice $RELEASE_TAG" --notes "" ||
    gh release view "$RELEASE_TAG" >/dev/null
fi

gh release upload "$RELEASE_TAG" "$asset" --clobber
