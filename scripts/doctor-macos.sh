#!/usr/bin/env bash

set -u

mode="Installed"
typora_home=""
community_root=""
redact_paths=false
plugin_id="eleef.typora-side-by-side-translator"
failures=0
warnings=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      mode="${2:-}"
      shift 2
      ;;
    -p|--path)
      typora_home="${2:-}"
      shift 2
      ;;
    --community-root)
      community_root="${2:-}"
      shift 2
      ;;
    --redact-paths)
      redact_paths=true
      shift
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [[ "$mode" != "Community" && "$mode" != "Installed" ]]; then
  printf 'Mode must be Community or Installed.\n' >&2
  exit 2
fi

display_path() {
  if [[ "$redact_paths" == true ]]; then
    printf '<local-path>'
  else
    printf '%s' "$1"
  fi
}

write_result() {
  local level="$1"
  local code="$2"
  local message="$3"
  printf '[%s] %s - %s\n' "$level" "$code" "$message"
}

add_pass() {
  write_result "PASS" "$1" "$2"
}

add_warning() {
  warnings=$((warnings + 1))
  write_result "WARN" "$1" "$2"
}

add_failure() {
  failures=$((failures + 1))
  write_result "FAIL" "$1" "$2"
}

read_plist_raw() {
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null
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

version_ge() {
  local left_version="${1%%-*}"
  local right_version="${2%%-*}"
  local IFS='.'
  local left=()
  local right=()
  local index left_part right_part
  read -r -a left <<< "$left_version"
  read -r -a right <<< "$right_version"
  for index in 0 1 2 3; do
    left_part="${left[$index]:-0}"
    right_part="${right[$index]:-0}"
    left_part="${left_part//[^0-9]/}"
    right_part="${right_part//[^0-9]/}"
    left_part="${left_part:-0}"
    right_part="${right_part:-0}"
    if ((10#$left_part > 10#$right_part)); then
      return 0
    fi
    if ((10#$left_part < 10#$right_part)); then
      return 1
    fi
  done
  return 0
}

if [[ -z "$typora_home" ]]; then
  for candidate in "/Applications/Typora.app" "$HOME/Applications/Typora.app"; do
    if [[ -d "$candidate" ]]; then
      typora_home="$candidate"
      break
    fi
  done
fi

typora_version=""
window_html=""
if [[ -z "$typora_home" || ! -d "$typora_home" ]]; then
  add_failure "typora.installation" "Typora.app was not found. Pass --path with its application path."
else
  info_plist="$typora_home/Contents/Info.plist"
  if [[ -f "$info_plist" ]]; then
    typora_version="$(read_plist_raw "$info_plist" "CFBundleShortVersionString" || true)"
  fi
  if [[ -n "$typora_version" ]]; then
    add_pass "typora.installation" "Typora $typora_version found at $(display_path "$typora_home")"
  else
    add_failure "typora.installation" "Typora version could not be read from $(display_path "$info_plist")"
  fi

  for candidate in \
    "$typora_home/Contents/Resources/TypeMark/index.html" \
    "$typora_home/Contents/Resources/app/index.html" \
    "$typora_home/Contents/Resources/appsrc/index.html"; do
    if [[ -f "$candidate" ]]; then
      window_html="$candidate"
      break
    fi
  done

  if [[ -z "$window_html" ]]; then
    add_failure "community-market.window-html" "Typora index.html was not found in the application bundle."
  elif /usr/bin/grep -Eq 'plugins/loader\.js' "$window_html"; then
    add_pass "community-market.injection" "Community loader injection is present in $(display_path "$window_html")"
  else
    add_failure "community-market.injection" "Community loader injection is missing. Re-run the official install-macos.sh after granting Terminal App Management access."
  fi
fi

if [[ -z "$community_root" ]]; then
  community_root="$HOME/Library/Application Support/abnerworks.Typora/plugins"
fi

if [[ -d "$community_root" ]]; then
  add_pass "community-market.runtime-path" "Typora runtime plugin path exists: $(display_path "$community_root")"
else
  add_failure "community-market.runtime-path" "typora-community-plugin runtime files are missing from $(display_path "$community_root")"
fi

loader_path="$community_root/loader.js"
loader_config_path="$community_root/loader.json"
if [[ -s "$loader_path" ]]; then
  add_pass "community-market.loader" "Community loader exists: $(display_path "$loader_path")"
else
  add_failure "community-market.loader" "Community loader is missing."
fi

core_version=""
if [[ -s "$loader_config_path" ]] && json_is_valid "$loader_config_path"; then
  add_pass "community-market.loader-config" "loader.json is readable: $(display_path "$loader_config_path")"
  core_version="$(read_json_raw "$loader_config_path" "coreVersion" || true)"
else
  add_failure "community-market.loader-config" "loader.json is missing or invalid."
fi

if [[ -z "$core_version" ]]; then
  add_failure "community-market.core-version" "loader.json does not contain a valid coreVersion."
elif [[ -s "$community_root/$core_version/core.js" && -s "$community_root/$core_version/core.css" ]]; then
  add_pass "community-market.core" "Community core $core_version is installed."
else
  add_failure "community-market.core" "Community core files are incomplete for version $core_version."
fi

if [[ "$mode" == "Installed" ]]; then
  plugin_root="$community_root/plugins/$plugin_id"
  required_files=(
    "manifest.json"
    "main.js"
    "style.css"
    "locales/lang.en.json"
    "locales/lang.ja.json"
    "locales/lang.ko.json"
    "locales/lang.zh-cn.json"
    "locales/lang.zh-tw.json"
  )
  for required_file in "${required_files[@]}"; do
    installed_file="$plugin_root/$required_file"
    if [[ -s "$installed_file" ]]; then
      add_pass "plugin.file.$required_file" "Installed plugin file is present: $(display_path "$installed_file")"
    else
      add_failure "plugin.file.$required_file" "Installed plugin file is missing or empty: $(display_path "$installed_file")"
    fi
  done

  manifest_path="$plugin_root/manifest.json"
  if [[ -s "$manifest_path" ]] && json_is_valid "$manifest_path"; then
    add_pass "plugin.manifest" "Plugin manifest is readable."
    manifest_id="$(read_json_raw "$manifest_path" "id" || true)"
    min_core_version="$(read_json_raw "$manifest_path" "minCoreVersion" || true)"
    min_app_version="$(read_json_raw "$manifest_path" "minAppVersion" || true)"
    if [[ "$manifest_id" == "$plugin_id" ]]; then
      add_pass "plugin.manifest-id" "Installed manifest ID matches $plugin_id"
    else
      add_failure "plugin.manifest-id" "Installed manifest ID does not match its plugin directory."
    fi
    if /usr/bin/grep -Eq '"darwin"' "$manifest_path"; then
      add_pass "plugin.platform" "Plugin manifest declares macOS (darwin)."
    else
      add_failure "plugin.platform" "Plugin manifest does not declare macOS (darwin)."
    fi
    if [[ -n "$core_version" && -n "$min_core_version" ]] && version_ge "$core_version" "$min_core_version"; then
      add_pass "plugin.core-compatibility" "Core $core_version satisfies plugin minimum $min_core_version."
    else
      add_failure "plugin.core-compatibility" "Installed community core is older than the plugin minimum."
    fi
    if [[ -n "$typora_version" && -n "$min_app_version" ]] && version_ge "$typora_version" "$min_app_version"; then
      add_pass "plugin.typora-compatibility" "Typora $typora_version satisfies plugin minimum $min_app_version."
    else
      add_failure "plugin.typora-compatibility" "Installed Typora is older than the plugin minimum."
    fi
  else
    add_failure "plugin.manifest" "Plugin manifest is missing or invalid."
  fi

  plugin_states_path="$community_root/settings/plugins.json"
  if [[ -s "$plugin_states_path" ]] && json_is_valid "$plugin_states_path"; then
    add_pass "plugin.enabled-config" "Plugin state JSON is readable."
    if /usr/bin/grep -Eq '"eleef\.typora-side-by-side-translator"[[:space:]]*:[[:space:]]*true' "$plugin_states_path"; then
      add_pass "plugin.enabled" "The plugin is enabled in the global community configuration."
    else
      add_failure "plugin.enabled" "The plugin is installed but not enabled."
    fi
  else
    add_failure "plugin.enabled-config" "Plugin state JSON is missing or invalid."
  fi

  runtime_log_path="$community_root/settings/data/logs/typora-side-by-side-translator.log"
  if [[ -s "$runtime_log_path" ]] && /usr/bin/grep -Fq "\"manifestId\":\"$plugin_id\"" "$runtime_log_path"; then
    add_pass "plugin.runtime-marker" "A successful plugin startup marker exists in the diagnostic log."
  else
    add_warning "plugin.runtime-marker" "No macOS startup marker exists yet. Restart Typora and open the plugin once before claiming host verification."
  fi
  add_warning "plugin.verified-matrix" "The macOS installer and package are automated candidates; a real Typora-on-macOS smoke test has not been completed."
fi

if /usr/bin/pgrep -x Typora >/dev/null 2>&1; then
  add_warning "typora.running" "Typora is open. Close it before installing or replacing plugin files."
else
  add_pass "typora.running" "No Typora process is open."
fi

printf 'doctor_platform=darwin\n'
printf 'doctor_mode=%s\n' "$mode"
printf 'doctor_failures=%s\n' "$failures"
printf 'doctor_warnings=%s\n' "$warnings"
if ((failures > 0)); then
  exit 1
fi
exit 0
