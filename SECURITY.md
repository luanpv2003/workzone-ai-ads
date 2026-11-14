# Security policy

Workzone AI Ads stores advertising tokens and customer conversations, so security reports are taken seriously.

## Reporting a vulnerability

Email **agent@workzone.ai.vn** with:

- what the issue is and where (file, endpoint, screen),
- how to reproduce it,
- what an attacker could do with it.

Please do not open a public issue or pull request for a vulnerability until it has been fixed. We will acknowledge your report, keep you updated, and credit you in the release notes if you wish.

## Scope

In scope: this repository's code (authentication and access control between workspaces / clients, token handling, the MCP endpoint, anything that can change ads or spend money, personal data sent to AI providers).

Out of scope: vulnerabilities in third-party services (Meta, Google, Anthropic, Zalo, Telegram) and issues that require an already-compromised server.
