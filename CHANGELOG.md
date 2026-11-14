# Changelog

All notable changes are listed here. Versions follow [semantic versioning](https://semver.org/); dates are YYYY-MM-DD.

## [0.1.0] - 2026-11-14

First public release.

### Added

- **Bảo's rules**: 56 numbered optimisation rules from Hồ Quốc Bảo, listed in the app (`/playbook`) and in [RULES.md](RULES.md). Every optimisation suggestion shows the rules behind it.
- Meta (Facebook / Instagram) ads management: per-client overview, approval queue with three automation modes (suggest, dry run, auto with caps and undo), campaign builder that always publishes paused.
- Google Ads: read data and make reversible changes (pause / enable, budget, target CPA, devices, negative keywords, new paused ad groups) on VND accounts.
- Message analysis for Messenger / Instagram, audience personas and verified Meta targeting, lead loop to the sales team's Zalo / Telegram group, owner reports, follow-ups inside Meta's 24-hour window.
- Bring your own AI: MCP endpoint for Claude (Code, Desktop, claude.ai) and ChatGPT; built-in Claude optional, with an API key or your own Claude plan.
- One-command self-install with Docker (`scripts/install.sh`), first-run admin setup, optional prebuilt images.
- Vietnamese and English interface (Vietnamese by default).

### Security

- Per-account login rate limit, `TRUST_PROXY` for real client IPs behind the bundled Caddy.
- OAuth consent page shows where the authorisation code goes.
- Outbound fetches of user-supplied URLs block private and metadata addresses.
- Lead links expire after 30 days; security headers on every response.
