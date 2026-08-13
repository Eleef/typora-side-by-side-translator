#!/usr/bin/env bash

set -euo pipefail

typora_home=""
community_root=""
package_path=""
expected_sha256=""
accept_session_credential_loss=false
plugin_id="eleef.typora-side-by-side-translator"
legacy_plugin_ids=("eleef.typora-side-by-side-translation" "typora-bilingual" "jiang.typora-bilingual")
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
workspace="$(cd "$script_dir/.." && pwd -P)"
doctor="$script_dir/doctor-macos.sh"
source_path="$workspace/build/typora-side-by-side-translator"
source_kind="build"
temporary_source_root=""
target_backup=""
state_backup=""
install_complete=false
target_installed=false
state_update_started=false
target_backup_created=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--path)
      typora_home="${2:-}"
      shift 2
      ;;
    --community-root)
      community_root="${2:-}"
      shift 2
      ;;
    --package)
      package_path="${2:-}"
      shift 2
      ;;
    --expected-sha256)
      expected_sha256="${2:-}"
      shift 2
      ;;
    --accept-session-credential-loss)
      accept_session_credential_loss=true
      shift
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [[ "$(/usr/bin/uname -s)" != "Darwin" ]]; then
  printf 'This installer must run on macOS.\n' >&2
  exit 1
fi

for command_path in /usr/bin/ditto /usr/bin/osascript /usr/bin/plutil /usr/bin/shasum /usr/bin/unzip; do
  if [[ ! -x "$command_path" ]]; then
    printf 'Required macOS tool is missing: %s\n' "$command_path" >&2
    exit 1
  fi
done

if [[ -z "$typora_home" ]]; then
  for candidate in "/Applications/Typora.app" "$HOME/Applications/Typora.app"; do
    if [[ -d "$candidate" ]]; then
      typora_home="$candidate"
      break
    fi
  done
fi
if [[ -z "$typora_home" || ! -d "$typora_home" ]]; then
  printf 'Typora.app was not found. Pass --path with its application path.\n' >&2
  exit 1
fi

if [[ -z "$community_root" ]]; then
  community_root="$HOME/Library/Application Support/abnerworks.Typora/plugins"
fi
if [[ ! -d "$community_root" ]]; then
  printf 'typora-community-plugin is not installed at: %s\n' "$community_root" >&2
  exit 1
fi
community_root="$(cd "$community_root" && pwd -P)"
plugins_root="$community_root/plugins"
/bin/mkdir -p "$plugins_root"
plugins_root="$(cd "$plugins_root" && pwd -P)"
target="$plugins_root/$plugin_id"
staging="$plugins_root/$plugin_id.installing"
target_backup="$plugins_root/$plugin_id.previous"
plugin_settings_path="$community_root/settings/data/$plugin_id.json"
plugin_states_path="$community_root/settings/plugins.json"

cleanup() {
  local exit_code=$?
  if [[ "$install_complete" != true ]]; then
    if [[ "$target_installed" == true ]]; then
      /bin/rm -rf "$target"
    fi
    if [[ "$target_backup_created" == true && -d "$target_backup" ]]; then
      /bin/rm -rf "$target"
      /bin/mv "$target_backup" "$target"
    fi
    if [[ "$state_update_started" == true && -n "$state_backup" && -f "$state_backup" ]]; then
      /bin/cp "$state_backup" "$plugin_states_path"
    fi
  else
    /bin/rm -rf "$target_backup"
  fi
  /bin/rm -rf "$staging"
  if [[ -n "$temporary_source_root" && -d "$temporary_source_root" ]]; then
    case "$temporary_source_root" in
      /tmp/*|/private/tmp/*|"${TMPDIR:-/tmp}"*) /bin/rm -rf "$temporary_source_root" ;;
      *) printf 'Refusing to clean unexpected temporary path: %s\n' "$temporary_source_root" >&2 ;;
    esac
  fi
  trap - EXIT
  exit "$exit_code"
}
trap cleanup EXIT

sha256_file() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print tolower($1)}'
}

read_json_raw() {
  JSON_PATH="$1" JSON_KEY="$2" /usr/bin/osascript -l JavaScript 2>/dev/null <<'JXA'
ObjC.import('Foundation');
const env = $.NSProcessInfo.processInfo.environment;
const filepath = ObjC.unwrap(env.objectForKey('JSON_PATH'));
const keyPath = ObjC.unwrap(env.objectForKey('JSON_KEY'));
const source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(filepath), $.NSUTF8StringEncoding, null));
let value = JSON.parse(source);
for (const key of keyPath.split('.')) {
  if (value === null || typeof value !== 'object' || !(key in value)) throw new Error('JSON key not found.');
  value = value[key];
}
if (value === null || typeof value === 'object') throw new Error('JSON value is not scalar.');
const output = $(String(value)).dataUsingEncoding($.NSUTF8StringEncoding);
$.NSFileHandle.fileHandleWithStandardOutput.writeData(output);
JXA
}

json_is_valid() {
  JSON_PATH="$1" /usr/bin/osascript -l JavaScript >/dev/null 2>&1 <<'JXA'
ObjC.import('Foundation');
const env = $.NSProcessInfo.processInfo.environment;
const filepath = ObjC.unwrap(env.objectForKey('JSON_PATH'));
const source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(filepath), $.NSUTF8StringEncoding, null));
JSON.parse(source);
JXA
}

set_plugin_enabled() {
  PLUGIN_STATES_PATH="$plugin_states_path" PLUGIN_ID="$plugin_id" LEGACY_PLUGIN_IDS="${legacy_plugin_ids[*]}" \
    /usr/bin/osascript -l JavaScript <<'JXA'
ObjC.import('Foundation');
const env = $.NSProcessInfo.processInfo.environment;
const filepath = ObjC.unwrap(env.objectForKey('PLUGIN_STATES_PATH'));
const pluginId = ObjC.unwrap(env.objectForKey('PLUGIN_ID'));
const legacyIds = ObjC.unwrap(env.objectForKey('LEGACY_PLUGIN_IDS')).split(' ');
const source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(filepath), $.NSUTF8StringEncoding, null));
const document = JSON.parse(source || '{}');
for (const legacyId of legacyIds) delete document[legacyId];
document[pluginId] = true;
const output = $(JSON.stringify(document, null, 2) + '\n');
const written = output.writeToFileAtomicallyEncodingError($(filepath), true, $.NSUTF8StringEncoding, null);
if (!written) throw new Error('Could not write plugin state JSON.');
JXA
}

validate_package_tree() {
  local root="$1"
  local actual expected
  if [[ -n "$(/usr/bin/find "$root" -type l -print -quit)" ]]; then
    printf 'Plugin package must not contain symbolic links.\n' >&2
    return 1
  fi
  actual="$(cd "$root" && /usr/bin/find . ! -name . -print | /usr/bin/sed 's#^\./##' | LC_ALL=C /usr/bin/sort)"
  expected="$(printf '%s\n' \
    'locales' \
    'locales/lang.en.json' \
    'locales/lang.ja.json' \
    'locales/lang.ko.json' \
    'locales/lang.zh-cn.json' \
    'locales/lang.zh-tw.json' \
    'main.js' \
    'manifest.json' \
    'style.css' | LC_ALL=C /usr/bin/sort)"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Plugin package has unexpected or missing entries.\nActual:\n%s\n' "$actual" >&2
    return 1
  fi
  local file
  for file in manifest.json main.js style.css locales/lang.en.json locales/lang.ja.json locales/lang.ko.json locales/lang.zh-cn.json locales/lang.zh-tw.json; do
    if [[ ! -f "$root/$file" || -L "$root/$file" || ! -s "$root/$file" ]]; then
      printf 'Plugin package file is missing or empty: %s\n' "$file" >&2
      return 1
    fi
  done
}

validate_zip_entries() {
  local archive="$1"
  local actual expected
  actual="$(/usr/bin/unzip -Z1 "$archive" | LC_ALL=C /usr/bin/sort)" || return 1
  expected="$(printf '%s\n' \
    'locales/lang.en.json' \
    'locales/lang.ja.json' \
    'locales/lang.ko.json' \
    'locales/lang.zh-cn.json' \
    'locales/lang.zh-tw.json' \
    'main.js' \
    'manifest.json' \
    'style.css' | LC_ALL=C /usr/bin/sort)"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Plugin ZIP has unexpected, missing, duplicate, or unsafe entries.\nActual:\n%s\n' "$actual" >&2
    return 1
  fi
  if /usr/bin/unzip -Z1 "$archive" | /usr/bin/grep -Eq '(^/|(^|/)\.\.(/|$)|\\)'; then
    printf 'Plugin ZIP contains an unsafe path.\n' >&2
    return 1
  fi
}

if /usr/bin/pgrep -x Typora >/dev/null 2>&1; then
  printf 'Typora is open. Close Typora before installing the plugin.\n' >&2
  exit 1
fi

if [[ -n "$package_path" ]]; then
  if [[ ! -f "$package_path" ]]; then
    printf 'Plugin package not found: %s\n' "$package_path" >&2
    exit 1
  fi
  package_path="$(cd "$(dirname "$package_path")" && pwd -P)/$(basename "$package_path")"
  actual_sha256="$(sha256_file "$package_path")"
  if [[ -n "$expected_sha256" ]]; then
    normalized_expected="$(printf '%s' "$expected_sha256" | /usr/bin/tr '[:upper:]' '[:lower:]')"
    if [[ ! "$normalized_expected" =~ ^[0-9a-f]{64}$ ]]; then
      printf 'Expected SHA-256 must contain exactly 64 hexadecimal characters.\n' >&2
      exit 1
    fi
    if [[ "$actual_sha256" != "$normalized_expected" ]]; then
      printf 'Plugin package checksum mismatch: %s\n' "$actual_sha256" >&2
      exit 1
    fi
  fi
  validate_zip_entries "$package_path"
  temporary_source_root="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/typora-side-by-side-package.XXXXXX")"
  /usr/bin/ditto -x -k "$package_path" "$temporary_source_root"
  source_path="$temporary_source_root"
  source_kind="zip"
  printf 'verified_package_sha256=%s\n' "$actual_sha256"
fi

if [[ ! -d "$source_path" ]]; then
  printf 'Build output not found: %s\n' "$source_path" >&2
  exit 1
fi
validate_package_tree "$source_path"

source_manifest="$source_path/manifest.json"
if ! json_is_valid "$source_manifest"; then
  printf 'Plugin manifest is invalid JSON.\n' >&2
  exit 1
fi
manifest_id="$(read_json_raw "$source_manifest" "id" || true)"
manifest_version="$(read_json_raw "$source_manifest" "version" || true)"
if [[ "$manifest_id" != "$plugin_id" || -z "$manifest_version" ]]; then
  printf 'Plugin manifest id or version is invalid.\n' >&2
  exit 1
fi
if ! /usr/bin/grep -Eq '"darwin"' "$source_manifest"; then
  printf 'Plugin manifest does not declare macOS (darwin).\n' >&2
  exit 1
fi

/bin/bash "$doctor" --mode Community --path "$typora_home" --community-root "$community_root"

settings_hash_before=""
if [[ -f "$plugin_settings_path" ]]; then
  if ! json_is_valid "$plugin_settings_path"; then
    printf 'Plugin settings are invalid JSON; no plugin files were changed: %s\n' "$plugin_settings_path" >&2
    exit 1
  fi
  settings_hash_before="$(sha256_file "$plugin_settings_path")"
  storage_mode="$(read_json_raw "$plugin_settings_path" "settings.credentialStorageMode" || true)"
  storage_version="$(read_json_raw "$plugin_settings_path" "settings.credentialStorageVersion" || true)"
  stored_api_key="$(read_json_raw "$plugin_settings_path" "settings.storedApiKey" || true)"
  base_url="$(read_json_raw "$plugin_settings_path" "settings.baseUrl" || true)"
  model="$(read_json_raw "$plugin_settings_path" "settings.model" || true)"
  session_marker_present=false
  session_marker=""
  if session_marker="$(read_json_raw "$plugin_settings_path" "settings.sessionCredentialConfigured")"; then
    session_marker_present=true
  fi
  if [[ -z "$storage_mode" ]]; then
    if [[ "$storage_version" =~ ^[0-9]+$ ]] && ((storage_version >= 1)); then
      storage_mode="plugin-settings"
    else
      storage_mode="session"
    fi
  fi
  has_stored_key=false
  if [[ "$storage_mode" == "plugin-settings" && -n "$stored_api_key" ]]; then
    has_stored_key=true
  fi
  has_session_risk=false
  if [[ "$session_marker_present" == true ]]; then
    if [[ "$session_marker" == "true" && "$has_stored_key" != true ]]; then
      has_session_risk=true
    fi
  elif [[ "$storage_mode" == "session" && -n "$base_url" && -n "$model" ]]; then
    has_session_risk=true
  fi
  if [[ "$has_session_risk" == true && "$has_stored_key" != true && "$accept_session_credential_loss" != true ]]; then
    printf 'The configured API key was session-only and cannot survive a closed Typora session. Re-enter it in Typora and choose local plaintext storage before the next update, or rerun with --accept-session-credential-loss.\n' >&2
    exit 1
  fi
  if [[ "$has_stored_key" == true ]]; then
    printf 'credential_retention=plaintext-persisted\n'
  elif [[ "$has_session_risk" == true ]]; then
    printf 'credential_retention=session-loss-accepted\n'
  elif [[ "$storage_mode" == "plugin-settings" ]]; then
    printf 'credential_retention=plaintext-empty\n'
  else
    printf 'credential_retention=session-empty\n'
  fi
fi

/bin/mkdir -p "$(dirname "$plugin_states_path")"
if [[ ! -f "$plugin_states_path" ]]; then
  printf '{}\n' > "$plugin_states_path"
fi
if ! json_is_valid "$plugin_states_path"; then
  printf 'Community plugin state is invalid JSON; no plugin files were changed: %s\n' "$plugin_states_path" >&2
  exit 1
fi
state_backup="$plugin_states_path.typora-side-by-side-translator.bak"
/bin/cp "$plugin_states_path" "$state_backup"

case "$target" in
  "$plugins_root"/*) ;;
  *) printf 'Unsafe plugin target: %s\n' "$target" >&2; exit 1 ;;
esac
/bin/rm -rf "$staging" "$target_backup"
/bin/mkdir -p "$staging"
/bin/cp -R "$source_path"/. "$staging"/

package_files=(manifest.json main.js style.css locales/lang.en.json locales/lang.ja.json locales/lang.ko.json locales/lang.zh-cn.json locales/lang.zh-tw.json)
for package_file in "${package_files[@]}"; do
  if [[ "$(sha256_file "$source_path/$package_file")" != "$(sha256_file "$staging/$package_file")" ]]; then
    printf 'Staged plugin file hash mismatch: %s\n' "$package_file" >&2
    exit 1
  fi
done

if [[ -d "$target" ]]; then
  /bin/mv "$target" "$target_backup"
  target_backup_created=true
fi
/bin/mv "$staging" "$target"
target_installed=true
state_update_started=true
set_plugin_enabled

if [[ -n "$settings_hash_before" ]]; then
  if [[ ! -f "$plugin_settings_path" || "$(sha256_file "$plugin_settings_path")" != "$settings_hash_before" ]]; then
    printf 'Plugin settings changed or disappeared during installation.\n' >&2
    exit 1
  fi
  printf 'verified_settings_preserved=true\n'
fi

/bin/bash "$doctor" --mode Installed --path "$typora_home" --community-root "$community_root"
install_complete=true
for legacy_plugin_id in "${legacy_plugin_ids[@]}"; do
  legacy_path="$plugins_root/$legacy_plugin_id"
  case "$legacy_path" in
    "$plugins_root"/*) ;;
    *) printf 'Skipping unsafe legacy plugin path: %s\n' "$legacy_path" >&2; continue ;;
  esac
  if [[ -d "$legacy_path" ]] && ! /bin/rm -rf "$legacy_path"; then
    printf 'Warning: could not remove legacy plugin directory: %s\n' "$legacy_path" >&2
  fi
done
printf 'verified_installed_file_hashes=%s\n' "${package_files[*]}"
printf 'enabled_plugin_id=%s\n' "$plugin_id"
printf 'installed_to=%s\n' "$target"
printf 'installed_version=%s\n' "$manifest_version"
printf 'install_source=%s\n' "$source_kind"
