#!/usr/bin/env bash

set -euo pipefail

workspace="$(cd "$(dirname "$0")/.." && pwd -P)"
sandbox="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/typora-side-by-side-macos-smoke.XXXXXX")"
typora_home="$sandbox/Applications/Typora.app"
community_root="$sandbox/Library/Application Support/abnerworks.Typora/plugins"
plugin_id="eleef.typora-side-by-side-translator"
plugin_root="$community_root/plugins/$plugin_id"
settings_path="$community_root/settings/data/$plugin_id.json"
state_path="$community_root/settings/plugins.json"

cleanup() {
  /bin/rm -rf "$sandbox"
}
trap cleanup EXIT

/bin/mkdir -p \
  "$typora_home/Contents/Resources/TypeMark" \
  "$community_root/2.9.14" \
  "$community_root/settings/data"

/usr/bin/plutil -create xml1 "$typora_home/Contents/Info.plist"
/usr/bin/plutil -insert CFBundleShortVersionString -string "1.14.9" "$typora_home/Contents/Info.plist"
printf '%s\n' '<html><body><script src="file:///Users/alice/Library/Application%20Support/abnerworks.Typora/plugins/loader.js" type="module"></script></body></html>' > "$typora_home/Contents/Resources/TypeMark/index.html"
printf '%s\n' 'loader' > "$community_root/loader.js"
printf '%s\n' '{"coreVersion":"2.9.14","debug":false}' > "$community_root/loader.json"
printf '%s\n' 'core' > "$community_root/2.9.14/core.js"
printf '%s\n' 'style' > "$community_root/2.9.14/core.css"
/bin/mkdir -p "$community_root/plugins/typora-bilingual"
printf '%s\n' 'legacy' > "$community_root/plugins/typora-bilingual/main.js"
printf '%s\n' '{"typora-bilingual":true}' > "$state_path"

/bin/bash "$workspace/scripts/doctor-macos.sh" \
  --mode Community \
  --path "$typora_home" \
  --community-root "$community_root"

/bin/bash "$workspace/scripts/install-plugin-macos.sh" \
  --path "$typora_home" \
  --community-root "$community_root"

for required_file in \
  manifest.json \
  main.js \
  style.css \
  locales/lang.en.json \
  locales/lang.ja.json \
  locales/lang.ko.json \
  locales/lang.zh-cn.json \
  locales/lang.zh-tw.json; do
  test -s "$plugin_root/$required_file"
done
/usr/bin/grep -Eq '"eleef\.typora-side-by-side-translator"[[:space:]]*:[[:space:]]*true' "$state_path"
if /usr/bin/grep -Eq '"typora-bilingual"' "$state_path"; then
  printf 'Legacy plugin enabled state was not removed.\n' >&2
  exit 1
fi
test ! -d "$community_root/plugins/typora-bilingual"

printf '%s\n' '{"settings":{"baseUrl":"https://api.example.com/v1","model":"test-model","credentialStorageMode":"plugin-settings","credentialStorageVersion":1,"storedApiKey":"placeholder-key","sessionCredentialConfigured":false}}' > "$settings_path"
settings_hash_before="$(/usr/bin/shasum -a 256 "$settings_path" | /usr/bin/awk '{print $1}')"
package_hash="$(/usr/bin/shasum -a 256 "$workspace/release/plugin.zip" | /usr/bin/awk '{print $1}')"

/bin/bash "$workspace/scripts/install-plugin-macos.sh" \
  --path "$typora_home" \
  --community-root "$community_root" \
  --package "$workspace/release/plugin.zip" \
  --expected-sha256 "$package_hash"

settings_hash_after="$(/usr/bin/shasum -a 256 "$settings_path" | /usr/bin/awk '{print $1}')"
test "$settings_hash_before" = "$settings_hash_after"

# Community uninstall removes plugin code but deliberately leaves plugin settings behind.
/bin/rm -rf "$plugin_root"
/bin/bash "$workspace/scripts/install-plugin-macos.sh" \
  --path "$typora_home" \
  --community-root "$community_root" \
  --package "$workspace/release/plugin.zip" \
  --expected-sha256 "$package_hash"
settings_hash_after_reinstall="$(/usr/bin/shasum -a 256 "$settings_path" | /usr/bin/awk '{print $1}')"
test "$settings_hash_before" = "$settings_hash_after_reinstall"

printf '%s\n' '{"settings":{"baseUrl":"https://api.example.com/v1","model":"test-model","credentialStorageMode":"session","credentialStorageVersion":1,"storedApiKey":"","sessionCredentialConfigured":true}}' > "$settings_path"
if /bin/bash "$workspace/scripts/install-plugin-macos.sh" \
  --path "$typora_home" \
  --community-root "$community_root" \
  --package "$workspace/release/plugin.zip" \
  --expected-sha256 "$package_hash"; then
  printf 'Session-only credential guard did not stop installation.\n' >&2
  exit 1
fi

/bin/cp "$plugin_root/locales/lang.en.json" "$sandbox/lang.en.json"
/bin/rm "$plugin_root/locales/lang.en.json"
if /bin/bash "$workspace/scripts/doctor-macos.sh" \
  --mode Installed \
  --path "$typora_home" \
  --community-root "$community_root"; then
  printf 'Doctor did not detect a missing locale file.\n' >&2
  exit 1
fi
/bin/cp "$sandbox/lang.en.json" "$plugin_root/locales/lang.en.json"

printf 'macos_installer_smoke=passed\n'
printf 'macos_zip_installer_smoke=passed\n'
printf 'macos_session_credential_guard=passed\n'
printf 'macos_persisted_settings_preservation=passed\n'
printf 'macos_settings_only_reinstall=passed\n'
printf 'macos_legacy_plugin_migration=passed\n'
printf 'macos_damaged_install_detection=passed\n'
