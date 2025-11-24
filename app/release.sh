#!/usr/bin/env bash

set -euo pipefail

export GIT_TAG="$(git describe --tags --abbrev=0)"
export GIT_COMMITS="$(git rev-list --count ${GIT_TAG}..HEAD)"
export GIT_SHA="$(git rev-parse --short=9 HEAD)"
export GIT_DIRTY="$(git diff --quiet --ignore-submodules HEAD || echo true || echo false)"
flutter clean
flutter pub get
flutter build apk --release \
  --dart-define=GIT_TAG="${GIT_TAG}" \
  --dart-define=GIT_COMMITS="${GIT_COMMITS}" \
  --dart-define=GIT_SHA="${GIT_SHA}" \
  --dart-define=GIT_DIRTY="${GIT_DIRTY}"

if [ "$GIT_COMMITS" -eq 0 ]; then
    TAG_NAME="$GIT_TAG"
else
    TAG_NAME="${GIT_TAG}+${GIT_COMMITS}.g${GIT_SHA}"
fi

if [ "$GIT_DIRTY" = "true" ]; then
    TAG_NAME="${TAG_NAME}.dirty"
fi

export APK_DIR="build/app/outputs/flutter-apk"
mv -v "${APK_DIR}/app-release.apk" "${APK_DIR}/potatomesh-reader-android-${TAG_NAME}.apk"
(cd "${APK_DIR}" && sha256sum "potatomesh-reader-android-${TAG_NAME}.apk" > "potatomesh-reader-android-${TAG_NAME}.apk.sha256sum")

