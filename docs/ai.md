# AI in Workzone AI Ads

There are two independent ways to use AI. You can use one, both, or neither.

1. **Built-in AI**: the app itself calls Claude to analyse conversations, score leads, audit accounts, suggest optimisations and draft campaigns. Optional; needs a Claude API key, or your own Claude subscription.
2. **Bring your own AI**: connect your own Claude (Claude Code, Claude Desktop, Claude.ai) or ChatGPT to the app through MCP, and ask it about your clients in your own chat. Uses your own AI subscription; no key in the app.

Without either, the app still syncs Meta data, applies the optimisation rules, sends lead notifications and reports; the AI features show a message asking for a key.

## 1. Built-in AI (optional)

Get an API key at [console.anthropic.com](https://console.anthropic.com/) → **API Keys** → **Create Key** (it starts with `sk-ant-api`). Usage is billed per token by Anthropic.

Then either:

- **In the app (easiest):** **System settings → Claude AI**, paste the key, save. It is stored encrypted in the database and used by the web app and the background worker. Only administrators see this page.
- **In `.env`:** set `ANTHROPIC_API_KEY="sk-ant-api…"` and run `./scripts/install.sh` again.

A key saved in the app takes priority over `.env`. Optional settings in `.env`: `CLAUDE_MODEL` (default `opus`).

[Screenshot: System settings → Claude AI with the key field]

Each business (workspace) can also paste its own key under **Users & permissions**, so its clients use its own Claude account.

### Claude subscription instead of an API key

If you have a Claude Pro or Max plan, the built-in AI can run on it instead of an API key. The Docker images include the Claude Code CLI for this.

1. On a computer where Claude Code is installed and logged in to your plan, run `claude setup-token`. It prints a token that starts with `sk-ant-oat` (valid for one year).
2. In the app, open **System settings → Claude AI**, paste the token and save. The app tests it with one call before saving.

Good to know:

- The token stays on your installation: it is stored encrypted in your own database and is only passed to Claude Code, which talks to Anthropic. Use your own subscription.
- Plan limits (per 5 hours and per week) assume one person's ordinary use. Background analysis for many clients, or a whole team working in the app, can use them up; for a team or an agency use an API key. Anthropic's rules for these credentials: [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).
- When the token expires or is revoked, the AI features show a message asking you to paste a new one.
- Claude Code needs memory of its own: on a server, plan for 4 GB.
- Without Docker ([install.md → Without Docker](install.md#without-docker)): install Claude Code on the same machine. Then paste a token as above, or leave everything empty and log in with `claude` as the user that runs the app.

Privacy: names, phone numbers, emails and account numbers are masked before conversations are sent to the AI.

## 2. Bring your own AI (MCP)

The app has an MCP endpoint at:

```
PUBLIC_URL/api/mcp          for example http://localhost:3000/api/mcp or https://ads.example.com/api/mcp
```

Your AI sees exactly what you can see on the web (your businesses and clients, your role) and can: list clients, read reports, pending recommendations, the latest audit, the customer persona, conversations that need attention; queue background jobs and ask for campaign proposals; dismiss a recommendation. It **cannot change anything on Meta or Google**: pausing, budgets and publishing are still approved on the web.

Everything is on the **Connect your AI** page in the app (open it from the menu or search for it with the command menu). The page shows your MCP address and which of the options below work for your installation.

[Screenshot: the Connect your AI page]

How sign-in works:

- **Personal token**: you create it on the Connect your AI page. It starts with `wza_`, is shown once, and works until you revoke it. Sent as `Authorization: Bearer <token>`. Only its hash is stored.
- **OAuth 2.1** (Claude.ai, Claude Desktop connectors, ChatGPT, Claude Code): the AI app registers itself (dynamic client registration), opens a page of your installation where you sign in and click **Allow**, and gets a token valid for 7 days that renews itself for up to 90 days (PKCE S256). Discovery is at `PUBLIC_URL/.well-known/oauth-authorization-server` and `PUBLIC_URL/.well-known/oauth-protected-resource`.

Revoke any connection under **Active connections** on the same page.

Which option works where:

| | On your computer (`http://localhost`) | On your server (`https://` domain) |
|---|---|---|
| Claude Code | Yes, personal token | Yes, personal token or OAuth |
| Claude Desktop | Yes, through `mcp-remote` + personal token | Yes, custom connector (OAuth) |
| Claude.ai (web) | No | Yes, custom connector (OAuth) |
| ChatGPT | No | Yes, developer-mode connector (OAuth) |

Claude.ai, ChatGPT and Claude Desktop's custom connectors call your installation from their own servers on the internet, so they need a public HTTPS address ([server.md](server.md)). Claude Code and `mcp-remote` run on your own computer, so `localhost` works.

### Claude Code

1. On **Connect your AI**, under Claude Code, type a name (for example "My MacBook") and click **Create token**.
2. Copy the command shown (the token is already in it) and run it in a terminal on the computer with Claude Code:

   ```bash
   claude mcp add --transport http workzone-ai-ads http://localhost:3000/api/mcp --header "Authorization: Bearer wza_…"
   ```

3. Start `claude` and ask, for example, "Which of my clients has the highest cost per lead this week?". `/mcp` inside Claude Code shows the connection.

On a server you can skip the token: `claude mcp add --transport http workzone-ai-ads https://ads.example.com/api/mcp`, then run `/mcp` in Claude Code and choose **Authenticate**; a browser page of your installation asks you to sign in and click **Allow**.

### Claude Desktop

**On your computer** (the app runs on `localhost`): Claude Desktop reaches it through the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge, which needs [Node.js](https://nodejs.org/) 18+ on the same computer.

1. On **Connect your AI**, under Claude Desktop, click **Create token**, and copy the config snippet shown.
2. In Claude Desktop: **Settings → Developer → Edit Config**. This opens `claude_desktop_config.json`:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
3. Paste the snippet. It looks like this (if the file already has `"mcpServers"`, add only the `"workzone-ai-ads"` entry inside it):

   ```json
   {
     "mcpServers": {
       "workzone-ai-ads": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "http://localhost:3000/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
         "env": { "AUTH_HEADER": "Bearer wza_…" }
       }
     }
   }
   ```

   The token sits in `env` so the arguments contain no spaces (this matters on Windows). For a plain-http address other than localhost (for example `http://192.168.1.20:3000`), `mcp-remote` also needs `"--allow-http"` at the end of `args`; the snippet on the page adds it for you.

4. Quit Claude Desktop completely and open it again. The tools appear in the tools menu of a new chat.

**On your server** (public `https://` address): no token or config file.

1. In Claude Desktop or on claude.ai: **Settings → Connectors → Add custom connector**.
2. Name it "Workzone AI Ads", paste `https://ads.example.com/api/mcp`, click **Add**, then **Connect**.
3. A page of your installation opens: sign in if needed and click **Allow**.

On Team / Enterprise plans an owner may need to add the connector first under the organisation settings.

### Claude.ai (web)

Same as Claude Desktop on a server, above (connectors are shared between claude.ai and Claude Desktop). Needs the public HTTPS address.

### ChatGPT

Needs the public HTTPS address and a ChatGPT plan that allows developer mode (custom connectors).

1. In ChatGPT: **Settings → Apps & Connectors → Advanced settings**, turn on **Developer mode**.
2. Back in **Apps & Connectors**, click **Create**. Name: "Workzone AI Ads". MCP server URL: `https://ads.example.com/api/mcp`. Authentication: **OAuth**. Tick that you trust the application, click **Create**.
3. A page of your installation opens: sign in if needed and click **Allow**.
4. In a new chat, choose the connector from the **+** menu (Developer mode) and ask your question.

[Screenshot: ChatGPT → Create connector dialog]

ChatGPT's menu names change from time to time; if they differ, look for "Connectors" or "Apps" and "Developer mode" in its settings.

### Trying a connector from your computer

Claude.ai and ChatGPT cannot reach `localhost`. To try them before setting up a server, a temporary tunnel gives your local install a public HTTPS address; see "Optional: a temporary public address" in [meta.md](meta.md#optional-a-temporary-public-address-for-the-webhook). Set `PUBLIC_URL` to the tunnel address while you test (OAuth uses it), and set it back afterwards.
