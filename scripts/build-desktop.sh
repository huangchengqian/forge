#!/usr/bin/env bash
# Build a distributable macOS .app + .dmg for Forge Desktop.
#
# Skips tauri's dmg bundler (bundle_dmg.sh drives Finder via AppleScript,
# which needs automation permissions and fails on locked-down machines);
# a plain `hdiutil` UDZO image is deterministic and permission-free.
set -euo pipefail
cd "$(dirname "$0")/../desktop"

echo "==> building frontend"
npm run build

echo "==> building app (release)"
npm run tauri build -- --bundles app

APP="src-tauri/target/release/bundle/macos/Forge Desktop.app"
DMG="src-tauri/target/release/bundle/dmg/Forge Desktop_aarch64.dmg"
mkdir -p "$(dirname "$DMG")"

echo "==> packing dmg"
hdiutil create -volname "Forge Desktop" -srcfolder "$APP" -ov -format UDZO "$DMG"

echo ""
echo "==> artifacts:"
ls -lh "$APP" "$DMG"
