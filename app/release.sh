#!/usr/bin/env bash

# Copyright © 2025-26 l5yth & contributors
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

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
