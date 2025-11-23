#!/usr/bin/env bash

export GIT_TAG="$(git describe --tags --abbrev=0)"
export GIT_COMMITS="$(git rev-list --count ${GIT_TAG}..HEAD)"
export GIT_SHA="$(git rev-parse --short=9 HEAD)"
export GIT_DIRTY="$(git diff --quiet --ignore-submodules HEAD || echo true || echo false)"
flutter clean
flutter pub get
flutter run \
  --dart-define=GIT_TAG="${GIT_TAG}" \
  --dart-define=GIT_COMMITS="${GIT_COMMITS}" \
  --dart-define=GIT_SHA="${GIT_SHA}" \
  --dart-define=GIT_DIRTY="${GIT_DIRTY}" \
  --device-id 38151FDJH00D4C

