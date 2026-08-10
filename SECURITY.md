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
- API keys are held in memory for one Typora session and are not intentionally persisted by the plugin.
- Translation cache and diagnostic logs are local files and can be cleared from plugin settings.
- Typora and typora-community-plugin are third-party runtime dependencies outside this repository's security boundary.
