# Contributing

Thanks for helping improve Typora Side-by-Side Translator. Windows is the currently verified host platform. macOS is an installation and packaging candidate whose real Typora runtime behavior is still unverified, so every compatibility claim needs reproducible evidence.

## Before You Start

- Search existing issues before opening a new one.
- Use the Bug, Feature, or Compatibility issue form.
- Never include API keys, private document text, unredacted logs, or full local paths.
- Keep right-pane editing, automatic per-keystroke translation, Linux support, and macOS host-compatibility work separate from fixes to the verified Windows MVP.

## Development Setup

Requirements:

- Node.js 24
- npm
- Windows 10/11 for the verified host smoke, or macOS for candidate installer testing
- Typora 1.14.9 and typora-community-plugin 2.9.14 for the currently verified host smoke

The manifest still declares Typora `1.12.4` and community core `2.5.28` as installation minimums. Do not describe that minimum pair as verified until it has completed the same host smoke.

```text
npm ci
npm run ci
```

`npm run ci` runs the clean step, tracked-file hygiene check, strict TypeScript checking, security contract tests, production build, deterministic package creation, and ZIP structure validation.

Platform installer tests are separate because they require the matching operating system:

```text
npm run test:windows-installer
npm run test:macos-installer
```

## Local Installation

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-plugin.ps1
```

macOS candidate:

```bash
./scripts/doctor-macos.sh --mode Community
./scripts/install-plugin-macos.sh
```

Fully exit Typora before installation and reopen it afterward. Follow [VERIFICATION.md](./VERIFICATION.md) for the platform evidence matrix and host smoke testing. A passing macOS installer test is not evidence that the plugin UI works in Typora on macOS.

## Pull Requests

- Explain the user-visible behavior changed and the reason for the change.
- Add or update automated tests for security, parsing, caching, and release-contract changes.
- Record the exact Typora and typora-community-plugin versions used for host testing.
- Update README, verification steps, or security documentation when behavior changes.
- Run `npm run ci` before opening the pull request.
- Do not commit `dist/`, `build/`, `release/`, `.test-dist/`, caches, logs, or credentials.

## Release Validation

Maintainers validate a release candidate with:

```powershell
npm ci
npm run version:set -- <version>
npm run ci
$env:RELEASE_TAG = "<version>"
npm run check:release
```

`version:set` updates `package.json`, `package-lock.json`, and `manifest.json` together. Version tags do not use a `v` prefix, and an existing release version must never be overwritten. A release uploads the shared `plugin.zip`, `SHA256SUMS.txt`, both Windows scripts, and both macOS scripts. The ZIP contains `manifest.json`, `main.js`, `style.css`, and the file-based interface translations under `locales/`; package, installer, and published-release checks validate the complete list. The release workflow must pass the macOS installer job before publishing, but release notes must continue to call macOS a candidate until a real-host smoke is recorded. After publishing, run `npm run check:published -- --version <version>`.

## Security Reports

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](./SECURITY.md).
