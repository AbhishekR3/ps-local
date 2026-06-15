# Security Policy

## Supported Versions

Only the latest release is supported with security fixes. No LTS or backport policy.

| Version | Supported |
|---------|-----------|
| 1.0.x (latest) | Yes |
| < 1.0.0 | No |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting: **[Report a vulnerability](https://github.com/AbhishekR3/ps-local/security/advisories/new)**
(Settings → Security → Advisories → New draft security advisory).

If you prefer email: `abhishekramesh@gmail.com` — include "ps-local security" in the subject.

## Scope

**In scope** — please report:
- Logic bugs in the battle log writer (`showdown-ui/electron/main/index.ts`, `app/main.js`) that could expose unintended data
- Vulnerabilities in the WebSocket tap (`helper/extension/injected.js`) — e.g. frame injection or origin bypass
- Ad/analytics blocker bypass that causes tracking requests to reach third-party ad networks
- Local file path traversal or unintended file writes in the log output path
- Content Security Policy bypass in the Electron renderer

**Out of scope** — report these to the respective upstream project:
- Bugs in `vendor/pokemon-showdown` or `vendor/pokemon-showdown-client` (report to [Smogon/Pokemon-Showdown](https://github.com/smogon/pokemon-showdown/security))
- Electron framework vulnerabilities (report to [electron/electron](https://github.com/electron/electron/security))
- Issues specific to the live `play.pokemonshowdown.com` service

## Response

This is a solo/small-team project — no SLA. Best-effort response, typically within a week.

Coordinated disclosure is appreciated: allow reasonable time to fix before public disclosure. Credit will be given in the CHANGELOG.
