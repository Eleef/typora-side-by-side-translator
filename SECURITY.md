# Security Policy

## Supported Versions

Security fixes are provided only for the latest published release. The current source tree is pre-release software and may change without backward compatibility guarantees.

## Reporting A Vulnerability

Use GitHub Private Vulnerability Reporting from the repository's **Security** tab. Do not open a public issue with vulnerability details.

Include:

- affected plugin, Typora, and typora-community-plugin versions;
- reproducible steps using non-sensitive sample data;
- expected and actual behavior;
- impact assessment;
- a proposed fix, if available.

Never include real API keys, private Markdown, unredacted diagnostic logs, or full local paths. If private reporting is not yet available, contact the maintainer through the GitHub profile without including technical details and wait for a private channel.

## Current Security Boundaries

- Translation requests are sent directly from Typora to the endpoint configured by the user.
- Remote endpoints require HTTPS; loopback-hosted local services may use HTTP.
- Session mode is the default and holds API keys in memory for one Typora session.
- Optional plugin-settings mode stores the API key in plaintext in the current user's community plugin data. Enable it only when restart convenience outweighs protection from other programs running as the same Windows user.
- Changing the API service origin, switching back to session mode, or using the delete action removes the saved key. Marketplace uninstall and code replacement do not remove plugin data; use **Erase all local plugin data** before uninstalling when settings, caches, and logs must be removed.
- The first network translation requires explicit data-transfer consent and names the configured service origin.
- Translation cache and diagnostic logs are local files and can be cleared from plugin settings. Current-document cleanup affects only the active target language.
- Raw Markdown HTML is not executed in the translation pane. Rendered output is sanitized with an explicit tag and attribute allowlist that excludes scripts and external resource elements.
- Typora and typora-community-plugin are third-party runtime dependencies outside this repository's security boundary.
