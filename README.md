# Typora Side-by-Side Translator

Edit the original Markdown in Typora while reading a generated Chinese, English, Japanese, or Korean translation beside it.

[简体中文](./README.zh-CN.md)

![Typora with an English Markdown source on the left and a cached Simplified Chinese translation pane on the right](./docs/assets/typora-side-by-side-translator.png)

_Live capture from Typora 1.14.9 on Windows: source editing remains native on the left, while the cached read-only translation stays beside it._

> **Alpha:** the core workflow is verified on Windows. macOS packaging, installation and diagnostics are automated candidates, but the plugin has not completed a real Typora-on-macOS smoke test. The plugin is not yet available in the community marketplace.

Current development version: **`0.1.0-alpha.3`**. The installed version is also shown at the top of the plugin settings page.

## Why This Plugin

- **Stay in Typora.** The left side remains Typora's native editor; the right side is a read-only translation pane.
- **Translate deliberately.** No request is sent while you type. Full translation and stale-block refresh are explicit commands.
- **Keep source folders clean.** Each target language has an independent plugin cache. Export creates a clean language-suffixed Markdown file only when requested.
- **Choose the target language.** Simplified Chinese, Traditional Chinese, English, Japanese, and Korean are available from both settings and the translation pane.
- **Use the plugin in your language.** The interface can follow Typora automatically or use English, Simplified Chinese, Traditional Chinese, Japanese, or Korean independently of the translation target.
- **Refresh only what changed.** Markdown blocks are tracked independently, while manually edited cached translations are protected from silent replacement.
- **Preserve Markdown structure.** Headings, paragraphs, lists, quotes, tables, links, code, math, and HTML follow type-specific translation rules.
- **Read as one document.** Both columns share Typora's main scroll context and support adjustable `40/60`, `50/50`, and `60/40` layouts.

## Quick Start

### Requirements

| Platform | Status | Current evidence |
|---|---|---|
| Windows 10/11 | Supported Alpha | Typora 1.14.9 + `typora-community-plugin` 2.9.14 real-host smoke |
| macOS | Candidate, unverified in Typora | `darwin` package contract and macOS installer/doctor; CI gate defined, remote run pending |
| Linux | Unsupported | No installer or host smoke |

The manifest minimums are Typora `1.12.4` and community core `2.5.28`; these are installation thresholds, not evidence that every newer host combination is verified. Source installation uses Node.js 24.

### Install a Published Alpha Release

Install `typora-community-plugin` first. Open the [Releases page](https://github.com/Eleef/typora-side-by-side-translator/releases), select an available release, and download the assets for your platform from the same version into one directory. The repository may be ahead of the latest published Alpha; use the source-install path below when validating the current development version.

The macOS assets below start with the next release that contains this candidate work; older Alpha releases contain only the Windows pair.

- `plugin.zip`
- `SHA256SUMS.txt`
- `install-plugin.ps1`
- `doctor.ps1`
- `install-plugin-macos.sh`
- `doctor-macos.sh`

#### Windows

Completely close Typora, open PowerShell in that directory, and run:

```powershell
$checksumLine = Get-Content .\SHA256SUMS.txt | Where-Object { $_ -match '\s+plugin\.zip$' }
$expectedSha256 = ($checksumLine -split '\s+')[0]
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-plugin.ps1 -PackagePath .\plugin.zip -ExpectedSha256 $expectedSha256
```

The installer checks the community loader, verifies the ZIP checksum and package structure, installs the plugin, enables it, and runs the post-install doctor.

Before upgrading an existing installation, check the API-key storage mode in plugin settings. A session-only key cannot survive closing Typora, so the installer stops and asks you to select **Save locally (plaintext, default)** first. If re-entering the key after installation is acceptable, explicitly append `-AcceptSessionCredentialLoss`. The installer verifies that persisted plugin settings are byte-for-byte unchanged by the upgrade.

#### macOS Candidate

Install the official community loader first. Its macOS installer requires Terminal permission under **System Settings → Privacy & Security → App Management** because it injects the loader into `Typora.app`. Completely close Typora, then run:

```bash
checksum=$(awk '$2 == "plugin.zip" { print $1 }' SHA256SUMS.txt)
chmod +x install-plugin-macos.sh doctor-macos.sh
./install-plugin-macos.sh --package ./plugin.zip --expected-sha256 "$checksum"
```

The same `plugin.zip` is used on Intel and Apple Silicon; the plugin contains JavaScript and no native CPU-specific module. The installer uses Typora's actual macOS user-data plugin directory, verifies the package and community loader, enables the plugin, preserves persistent settings, and runs the macOS doctor. This path remains **unverified in a real Typora-on-macOS session**.

### Install From Source

Install `typora-community-plugin` first, completely close Typora, and then use the matching platform commands.

Windows:

```powershell
npm ci
npm run ci
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1 -Mode Community
powershell -ExecutionPolicy Bypass -File .\scripts\install-plugin.ps1
```

The installer verifies that the community marketplace loader is present, copies the plugin, enables it without writing an incompatible UTF-8 BOM to `plugins.json`, and performs a post-install health check. The installed directory is:

```text
%USERPROFILE%\.typora\community-plugins\plugins\eleef.typora-side-by-side-translator
```

macOS candidate:

```bash
npm ci
npm run ci
./scripts/doctor-macos.sh --mode Community
./scripts/install-plugin-macos.sh
```

The default macOS plugin directory is:

```text
~/Library/Application Support/abnerworks.Typora/plugins/plugins/eleef.typora-side-by-side-translator
```

### Use

1. Open a saved local `.md` file in Typora.
2. Open the community plugin settings, choose the interface and target languages, then configure `baseUrl`, `apiKey`, `model`, and `timeoutMs`.
3. The API key is saved locally in plaintext plugin settings by default so it survives restarts and updates. Select **Do not save (current Typora session only)** when local-at-rest secrecy is more important than convenience.
4. Open the community command panel. In the verified setup the shortcut is `F2`.
5. Search for **Side-by-Side Translator** and run **Toggle Pane**.
6. Run **Translate Current File** to create the selected language's cached translation.
7. After editing the source, run **Refresh Stale Blocks** when you want changed blocks translated again.
8. While a request is running, use **Cancel Translation** to stop it without replacing the existing cache.
9. Run **Export Target File** to write a clean language-suffixed Markdown file beside the source file.

## How It Works

```text
saved Markdown
      |
      v
Markdown block extraction --> OpenAI-compatible /chat/completions endpoint
      |                                      |
      |                                      v
      +---------------------------- cached translation + map
                                             |
                           +-----------------+-----------------+
                           v                                   v
                    read-only right pane              clean *.zh.md export
```

The source language is detected by the configured model. The target is selected from Simplified Chinese (`.zh.md`), Traditional Chinese (`.zh-TW.md`), English (`.en.md`), Japanese (`.ja.md`), or Korean (`.ko.md`). Switching targets reads that language's independent cache and never sends a request automatically. OpenAI-compatible remote APIs and loopback-hosted local model services are supported. Code, math, and HTML blocks are retained without translation; link text may be translated while URLs remain unchanged.

## Data Safety

- Markdown is sent only after **Translate Current File** or **Refresh Stale Blocks**.
- Before the first network translation, the plugin names the configured service and requires explicit data-transfer consent; declining sends nothing.
- Requests go directly from Typora to the configured provider; this project operates no proxy.
- Remote endpoints must use HTTPS. Plain HTTP is allowed only for `localhost`, `127.0.0.1`, and `::1`.
- Local plugin settings are the default and store the API key as plaintext in the current user's community plugin data; other programs running as the same operating-system user can read it. The optional session mode keeps the key only in memory and cannot recover it after closing, restarting, or updating Typora.
- Changing the API service origin clears both the in-memory and saved key. Switching back to session mode or using the explicit delete action also removes the saved value.
- Reinstalling or uninstalling plugin code does not remove community settings, caches, or logs. The upgrade installer verifies that persisted settings are unchanged; a session-only key still disappears when Typora closes. Use **Erase all local plugin data** in the plugin settings before uninstalling when local data must be removed.
- Translation cache is stored below the community plugin settings data directory: `%USERPROFILE%\.typora\community-plugins\settings\data\...` on the verified Windows layout, or `~/Library/Application Support/abnerworks.Typora/plugins/settings/data/...` on the macOS candidate layout.
- **Clear current document** removes only the active target language's cache pair. The settings page can also clear all translation caches, diagnostic logs, or all plugin-local data; exported Markdown files are never deleted.
- Diagnostic logs redact credentials, local paths, URL query parameters, and sensitive error details.
- The read-only pane escapes raw Markdown HTML and sanitizes rendered output with a strict allowlist; executable markup and external resource elements are removed.

The configured API provider receives the Markdown blocks selected for translation. Review that provider's data handling terms before using sensitive documents. The saved consent can be removed together with all local plugin data.

Legacy or damaged caches are handled conservatively. Caches created before the current block identity format remain readable and exportable, but stale refresh will not overwrite them. If a cache or map is missing or unreadable, stale refresh stops before network requests and file writes. A full translation rebuild requires an explicit user command.

## Current Limits

- Saved local `.md` files only; untitled and remote documents are unsupported.
- Source-language selection and automatic target-language routing are not provided; source detection is delegated to the configured model.
- The right pane is read-only and translation is not performed on every keystroke.
- Windows is the supported Alpha platform. macOS is a code/install candidate whose real Typora UI and runtime behavior remain unverified.
- Alpha installation is available from GitHub Releases; community marketplace installation is planned after the stable `0.1.0` release.

## Troubleshooting

Run the health check first:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

On macOS:

```bash
./scripts/doctor-macos.sh --redact-paths
```

Typora updates may replace the application HTML modified by `typora-community-plugin`, making the marketplace and all community plugins disappear. If the doctor reports a failed `community-market.injection` check, close Typora and reinstall the current official community loader against the updated Typora installation. Do not restore an old Typora HTML file over the new version.

When reporting a problem, rerun the doctor with `-RedactPaths`, then use the repository's Bug or Compatibility issue form and include that redacted summary, Typora version, community core version, and reproduction steps. Do not include API keys or unredacted logs.

## Development

```powershell
npm run typecheck
npm test
npm run build
npm run package
npm run test:windows-installer
npm run test:macos-installer
npm run version:set -- <version>
$env:RELEASE_TAG = "<version>"
npm run check:release
```

`npm run package` creates one architecture-neutral `release/plugin.zip` with `manifest.json`, `main.js`, `style.css`, and five interface-language resources under `locales/`. Windows and macOS installers validate the same package. See [VERIFICATION.md](./VERIFICATION.md) for the evidence matrix and the macOS real-host checks that remain open.

The repository includes [social-preview.png](./docs/assets/social-preview.png), sized for GitHub's repository social preview setting.

## License

[MIT](./LICENSE) © Eleef
