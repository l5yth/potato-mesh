# Meshtastic Reader

Meshtastic Reader – read-only PotatoMesh chat client for Android and iOS.

## Setup

```bash
cd app
flutter create .
# then replace pubspec.yaml and lib/main.dart with the versions in this repo
flutter pub get
flutter run
```

The app fetches from `https://potatomesh.net/api/messages?limit=100&encrypted=false`.
