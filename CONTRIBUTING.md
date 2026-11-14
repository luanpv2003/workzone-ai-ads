# Contributing

Thanks for helping. Any language is fine for issues and pull requests; code and code comments are in English.

## Ways to contribute

- **Report a bug or idea**: open an issue. Screenshots and steps help.
- **Share an optimization rule** from your own campaigns: open an issue describing the rule, why it works, and where you saw it (industry, market, roughly how many accounts or results). Numbers with a denominator ("14 of 20 accounts") make it easier to judge.
- **Industry pitfalls and interest sets**: what to avoid, and which interests worked as "right need" (H1) or "adjacent situation" (H2+) groups.
- **Code**: fixes, new integrations, translations, tests. Issues labelled `good first issue` are a good start.

## Development

```bash
npm ci
cp .env.example .env
npm run setup && npm run seed
npm run dev
```

Before opening a pull request:

```bash
npm run typecheck
npm run lint
```

## Pull requests

- Keep each pull request focused on one change and explain the why.
- Never add code that changes anything on Meta / Google without going through the approval flow (`src/lib/recommendations.ts`). MCP tools must stay read / queue / recommend only.
- Never send unmasked personal data (phone, email, names) to an AI provider; use `src/lib/pii.ts`.
- Do not commit secrets, real client data or screenshots containing them.
- UI text goes through the translation files (Vietnamese and English), not hard-coded strings.

## Security

Please do not open public issues for security problems. See [SECURITY.md](SECURITY.md).

## Conduct

Be respectful. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
