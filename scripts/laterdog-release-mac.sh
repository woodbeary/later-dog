#!/bin/bash
set -euo pipefail

RELEASE_TAG="${1:-}"
REPO="${LATERDOG_RELEASE_REPO:-woodbeary/later-dog}"
if [[ ! "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-preview\.[0-9]+)?$ ]]; then
  echo "Usage: scripts/laterdog-release-mac.sh vX.Y.Z (or vX.Y.Z-preview.N)" >&2
  exit 2
fi
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "The checkout has uncommitted changes; release from a clean worktree of main." >&2
  exit 1
fi
SHA="$(git rev-parse HEAD)"
if ! git branch -r --contains "$SHA" | grep -q 'origin/main$'; then
  echo "$SHA is not on origin/main yet; push it first." >&2
  exit 1
fi
if gh release view "$RELEASE_TAG" -R "$REPO" > /dev/null 2>&1; then
  echo "Release $RELEASE_TAG already exists; refusing to replace its binaries." >&2
  exit 1
fi

KEY_DIR="$HOME/.appstoreconnect/private_keys"
if [ -z "${APPLE_API_KEY_ID:-}" ]; then
  keys=("$KEY_DIR"/AuthKey_*.p8)
  if [ "${#keys[@]}" -ne 1 ] || [ ! -f "${keys[0]}" ]; then
    echo "Set APPLE_API_KEY_ID: $KEY_DIR should hold exactly one AuthKey_<KEY ID>.p8." >&2
    exit 1
  fi
  APPLE_API_KEY_ID="$(basename "${keys[0]}" .p8)"
  APPLE_API_KEY_ID="${APPLE_API_KEY_ID#AuthKey_}"
fi
KEY="$KEY_DIR/AuthKey_$APPLE_API_KEY_ID.p8"
if [ -z "${APPLE_API_ISSUER:-}" ]; then
  APPLE_API_ISSUER="$(asc auth issuer-id 2>/dev/null || true)"
fi
if [ ! -f "$KEY" ] || [ -z "$APPLE_API_ISSUER" ]; then
  echo "Notarization needs $KEY and APPLE_API_ISSUER (or an asc profile)." >&2
  exit 1
fi

IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"Developer ID Application: \([^"]*\)".*/\1/p' | head -n 1)"
if [ -z "$IDENTITY" ]; then
  echo "No Developer ID Application identity is in this Mac's keychain." >&2
  exit 1
fi
TEAM="$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')"
export LATERDOG_MAC_IDENTITY="$IDENTITY"
export LATERDOG_NOTARIZE=1
export LATERDOG_UPDATE_FEED="https://github.com/$REPO/releases/latest/download/"

notarize() {
  local file="$1" json
  json="$(mktemp)"
  xcrun notarytool submit "$file" --key "$KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait --timeout 30m --output-format json > "$json" || true
  cat "$json"; echo
  local id status
  id="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).id ?? ""' "$json" 2>/dev/null || true)"
  status="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).status ?? ""' "$json" 2>/dev/null || true)"
  rm -f "$json"
  if [ "$status" != Accepted ]; then
    if [ -n "$id" ]; then xcrun notarytool log "$id" --key "$KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"; fi
    echo "Apple did not accept $file; nothing was published." >&2
    exit 1
  fi
}

echo "== Package $SHA, signed as $IDENTITY"
rm -rf dist dist-server release out
pnpm laterdog:package
pnpm test:packaged-server

echo "== Inspect the app"
APP='release/mac-arm64/later.dog.app'
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist"
test -f "$APP/Contents/Resources/server/laterdog/main.js"
test -f "$APP/Contents/Resources/server/laterdog/mcp.js"
test -f "$APP/Contents/Resources/licenses/later.dog-NOTICE.txt"
if [ ! -x "$APP/Contents/Resources/later.dog Speech.app/Contents/MacOS/speech-helper" ]; then
  echo "The app has no dictation helper: it could not be compiled on this Mac. Refusing to release without dictation." >&2
  exit 1
fi
codesign --verify --deep --strict "$APP"
codesign -dr - "$APP" 2>&1 | grep -q 'anchor apple generic'
codesign -dr - "$APP" 2>&1 | grep -Eq "certificate leaf\[subject\.OU\] = \"?$TEAM\"?"
FEED="$(ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/later.dog" -p "require(process.argv[1]).laterdogUpdateFeed ?? ''" "$PWD/$APP/Contents/Resources/app.asar/package.json")"
echo "Update feed: ${FEED:-none}"
test "$FEED" = "$LATERDOG_UPDATE_FEED"
grep -Eq '^updaterCacheDirName: [A-Za-z0-9._-]+$' "$APP/Contents/Resources/app-update.yml"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
if [[ "$RELEASE_TAG" != "v$VERSION" && "$RELEASE_TAG" != "v$VERSION"-preview.* ]]; then
  echo "The app is $VERSION; a $RELEASE_TAG release would offer it as an update forever." >&2
  exit 1
fi

echo "== Notarize and staple the app"
WORK="$(mktemp -d)"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$WORK/notarize.zip"
notarize "$WORK/notarize.zip"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl -a -vvv -t exec "$APP"

echo "== Compare the app's files with the previous release"
(cd "$(dirname "$APP")" && find later.dog.app \( -type f -o -type l \)) | LC_ALL=C sort > "$WORK/files.txt"
if [ -n "${LATERDOG_PREVIOUS_FILES:-}" ]; then
  cp "$LATERDOG_PREVIOUS_FILES" "$WORK/previous-files.txt"
else
  PREVIOUS_TAG="$(gh release view -R "$REPO" --json tagName -q .tagName)"
  mkdir -p "$WORK/previous"
  if gh release download "$PREVIOUS_TAG" -R "$REPO" -p later.dog-macOS-arm64-files.txt -D "$WORK/previous"; then
    cp "$WORK/previous/later.dog-macOS-arm64-files.txt" "$WORK/previous-files.txt"
  else
    gh release download "$PREVIOUS_TAG" -R "$REPO" -p later.dog-macOS-arm64.zip -D "$WORK/previous"
    zipinfo -1 "$WORK/previous/later.dog-macOS-arm64.zip" > "$WORK/previous-files.txt"
  fi
  echo "Previous release: $PREVIOUS_TAG"
fi
node scripts/release-file-list.mjs "$WORK/previous-files.txt" "$WORK/files.txt"

echo "== Build, sign, notarize and staple the disk image"
DMG='release/later.dog-macOS-arm64.dmg'
rm -f "$DMG"
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dmg --arm64 --prepackaged "$APP" --publish never -c.dmg.artifactName=later.dog-macOS-arm64.dmg
hdiutil verify "$DMG"
codesign --force --sign "Developer ID Application: $IDENTITY" --timestamp "$DMG"
codesign --verify --strict "$DMG"
notarize "$DMG"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl -a -vvv -t open --context context:primary-signature "$DMG"

echo "== Release files"
mkdir -p out
ditto -c -k --sequesterRsrc --keepParent "$APP" out/later.dog-macOS-arm64.zip
cp "$DMG" out/later.dog-macOS-arm64.dmg
cp "$WORK/files.txt" out/later.dog-macOS-arm64-files.txt
node scripts/laterdog-release-files.mjs --tag "$RELEASE_TAG" --zip out/later.dog-macOS-arm64.zip --dmg out/later.dog-macOS-arm64.dmg --out out --repository "$REPO"
assets=(out/later.dog-macOS-arm64.dmg out/later.dog-macOS-arm64.zip out/SHA256SUMS.txt out/later.dog-macOS-arm64-files.txt)
[[ -f out/latest-mac.yml ]] && assets+=(out/latest-mac.yml)
prerelease=()
[[ "$RELEASE_TAG" == *-preview.* ]] && prerelease=(--prerelease)

if [ "${LATERDOG_RELEASE_DRY_RUN:-}" = 1 ]; then
  echo "Dry run: built and notarized ${assets[*]} for $RELEASE_TAG; not published."
  exit 0
fi
gh release create "$RELEASE_TAG" "${assets[@]}" -R "$REPO" --target "$SHA" "${prerelease[@]}" --title "later.dog $RELEASE_TAG" --notes-file out/NOTES.md
echo "Published $RELEASE_TAG from $SHA."
