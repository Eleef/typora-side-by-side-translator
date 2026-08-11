# Typora Side-by-Side Translator

Edit the original Markdown in Typora while reading a generated Chinese, English, Japanese, or Korean translation beside it.

[简体中文](./README.zh-CN.md)

![Typora showing an English Markdown document and its Simplified Chinese translation side by side](./docs/assets/typora-side-by-side-translator.png)

> **Alpha:** the core workflow is working on the verified Windows setup below. The plugin is not yet available in the community marketplace and has not completed external user testing.

Current development version: **`0.1.0-alpha.3`**. The installed version is also shown at the top of the plugin settings page.

## Why This Plugin

- **Stay in Typora.** The left side remains Typora's native editor; the right side is a read-only translation pane.
- **Translate deliberately.** No request is sent while you type. Full translation and stale-block refresh are explicit commands.
- **Keep source folders clean.** Each target language has an independent plugin cache. Export creates a clean language-suffixed Markdown file only when requested.
- **Choose the target language.** Simplified Chinese, Traditional Chinese, English, Japanese, and Korean are available from both settings and the translation pane.
- **Refresh only what changed.** Markdown blocks are tracked independently, while manually edited cached translations are protected from silent replacement.
- **Preserve Markdown structure.** Headings, paragraphs, lists, quotes, tables, links, code, math, and HTML follow type-specific translation rules.
- **Read as one document.** Both columns share Typora's main scroll context and support adjustable `40/60`, `50/50`, and `60/40` layouts.

## Quick Start

### Requirements

| Component | Current verified setup |
|---|---|
| Operating system | Windows 10/11 |
| Typora | 1.14.9 |
| [typora-community-plugin](https://github.com/typora-community-plugin/typora-community-plugin) | 2.9.14 |
| Node.js, for source installation | 24 |

The manifest minimums are Typora `1.12.4` and community core `2.5.28`, but those are installation thresholds rather than a claim that every newer combination is verified. macOS and Linux are not currently supported.

### Install Alpha Release

Install `typora-community-plugin` first. Then download these four assets from the [`0.1.0-alpha.3` release](https://github.com/Eleef/typora-side-by-side-translator/releases/tag/0.1.0-alpha.3) into the same directory:

- `plugin.zip`
- `SHA256SUMS.txt`
- `install-plugin.ps1`
- `doctor.ps1`

Completely close Typora, open PowerShell in that directory, and run:

```powershell
$checksumLine = Get-Content .\SHA256SUMS.txt | Where-Object { $_ -match '\s+plugin\.zip$' }
$expectedSha256 = ($checksumLine -split '\s+')[0]
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-plugin.ps1 -PackagePath .\plugin.zip -ExpectedSha256 $expectedSha256
```

The installer checks the community loader, verifies the ZIP checksum and package structure, installs the plugin, enables it, and runs the post-install doctor.

### Install From Source

Install `typora-community-plugin` first, completely close Typora, and then run:

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

### Use

1. Open a saved local `.md` file in Typora.
2. Open the community plugin settings and configure the target language, `baseUrl`, `apiKey`, `model`, and `timeoutMs`.
3. Keep the API key session-only, or explicitly select **Save in plugin settings (plaintext)** when restart convenience outweighs local-at-rest secrecy.
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
- Requests go directly from Typora to the configured provider; this project operates no proxy.
- Remote endpoints must use HTTPS. Plain HTTP is allowed only for `localhost`, `127.0.0.1`, and `::1`.
- Session mode keeps the API key only in memory and remains the default. The optional plugin-settings mode stores the key in plaintext in the current user's community plugin data; other programs running as that Windows user can read it.
- Changing the API service origin clears both the in-memory and saved key. Switching back to session mode or using the explicit delete action also removes the saved value.
- Reinstalling plugin code preserves community plugin settings. Deleting the plugin's community data directory removes the saved key.
- Translation cache is stored under `%USERPROFILE%\.typora\community-plugins\settings\data\eleef.typora-side-by-side-translator\translations`.
- The settings page can clear the current document cache, all translation caches, and diagnostic logs.
- Diagnostic logs redact credentials, local paths, URL query parameters, and sensitive error details.

The configured API provider receives the Markdown blocks selected for translation. Review that provider's data handling terms before using sensitive documents.

Legacy or damaged caches are handled conservatively. Caches created before the current block identity format remain readable and exportable, but stale refresh will not overwrite them. If a cache or map is missing or unreadable, stale refresh stops before network requests and file writes. A full translation rebuild requires an explicit user command.

## Current Limits

- Saved local `.md` files only; untitled and remote documents are unsupported.
- Source-language selection and automatic target-language routing are not provided; source detection is delegated to the configured model.
- The right pane is read-only and translation is not performed on every keystroke.
- Windows is the only supported platform for the Alpha release.
- Alpha installation is available from GitHub Releases; community marketplace installation is planned after the stable `0.1.0` release.

## Troubleshooting

Run the health check first:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

Typora updates may replace the application HTML modified by `typora-community-plugin`, making the marketplace and all community plugins disappear. If the doctor reports a failed `community-market.injection` check, close Typora and reinstall the current official community loader against the updated Typora installation. Do not restore an old Typora HTML file over the new version.

When reporting a problem, use the repository's Bug or Compatibility issue form and include the doctor summary, Typora version, community core version, and reproduction steps. Do not include API keys or unredacted logs.

## Development

```powershell
npm run typecheck
npm test
npm run build
npm run package
npm run test:windows-installer
npm run version:set -- 0.1.0-alpha.3
$env:RELEASE_TAG = "0.1.0-alpha.3"
npm run check:release
```

`npm run package` creates `release/plugin.zip` containing only `manifest.json`, `main.js`, and `style.css`. See [VERIFICATION.md](./VERIFICATION.md) for the full host checklist, [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting changes, and [SECURITY.md](./SECURITY.md) for private vulnerability reporting guidance.

The repository includes [social-preview.png](./docs/assets/social-preview.png), sized for GitHub's repository social preview setting.

## License

[MIT](./LICENSE) © Eleef
