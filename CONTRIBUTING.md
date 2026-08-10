# Contributing

Thanks for helping improve Typora Side-by-Side Translator. The project currently targets a narrow, verified Windows setup, so every behavior or compatibility claim needs reproducible evidence.

## Before You Start

- Search existing issues before opening a new one.
- Use the Bug, Feature, or Compatibility issue form.
- Never include API keys, private document text, unredacted logs, or full local paths.
- Keep right-pane editing, automatic per-keystroke translation, macOS, and Linux changes separate from fixes to the current Windows MVP.

## Development Setup

Requirements:

- Node.js 24
- npm
- Windows 10/11 for host smoke testing
- Typora 1.12.4
- typora-community-plugin 2.7.1

```powershell
npm ci
npm run ci
```

`npm run ci` runs the clean step, tracked-file hygiene check, strict TypeScript checking, security contract tests, production build, deterministic package creation, and ZIP structure validation.

## Local Installation

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-plugin.ps1
```

Fully exit and reopen Typora after installation. Follow [VERIFICATION.md](./VERIFICATION.md) for host smoke testing.

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
npm run version:set -- 0.1.0-alpha.1
npm run ci
$env:RELEASE_TAG = "0.1.0-alpha.1"
npm run check:release
```

`version:set` updates `package.json`, `package-lock.json`, and `manifest.json` together. Version tags do not use a `v` prefix. A release uploads `plugin.zip`, `SHA256SUMS.txt`, `install-plugin.ps1`, and `doctor.ps1`. The ZIP contains `manifest.json`, `main.js`, and `style.css` directly at its root. After publishing, run `npm run check:published -- --version <version>`.

## Security Reports

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](./SECURITY.md).
