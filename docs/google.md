# Connect Google Ads

The app reads Google Ads data (campaigns, keywords, search terms) and makes guarded, reversible changes through the Google Ads API. You set up **one connection for the whole install**: a Google Ads manager account (MCC) whose sub-accounts are your clients' ad accounts, plus your own Google Cloud OAuth client and developer token.

Contents: [1. Manager account](#1-manager-account-mcc) · [2. Developer token](#2-developer-token) · [3. OAuth client](#3-oauth-client-google-cloud) · [4. Paste and connect](#4-paste-and-connect) · [5. Pick each client's account](#5-pick-each-clients-account) · [What the app changes](#what-the-app-changes)

You need: a Google Ads manager account you administer, and a Google Cloud project.

## 1. Manager account (MCC)

1. If you do not have one, create it at [ads.google.com/home/tools/manager-accounts](https://ads.google.com/home/tools/manager-accounts/).
2. Link each client's ad account under it (**Accounts → + → Link existing account**), and have the client accept the request.
3. Note the manager account ID (`123-456-7890`, top right in Google Ads).

The app only sees accounts under this MCC. One ad account can belong to one client in the app.

## 2. Developer token

1. In the MCC: **Admin → API Center**. Fill in the form and accept the terms.
2. Copy the **developer token** (22 characters).

**Access level matters.** Check it in API Center:

- **Test Account**: works only with Google Ads test accounts. Calls to real accounts fail with `DEVELOPER_TOKEN_NOT_APPROVED`.
- **Explorer**: works with real accounts, capped at 2,880 operations a day.
- **Basic** (apply from the same page, Google reviews it in a few business days): 15,000 operations a day. Apply when you outgrow Explorer.

## 3. OAuth client (Google Cloud)

1. In [console.cloud.google.com](https://console.cloud.google.com/), select or create a project.
2. **APIs & Services → Library**: enable the **Google Ads API**.
3. **Google Auth Platform → Branding / Audience**: set up the consent screen. User type **External** (or **Internal** if you use Google Workspace and only staff will connect). Then **Publish app**.
   In **Testing** mode Google expires refresh tokens after 7 days and the connection drops every week. Published apps that only you use do not need Google's verification.
4. **Google Auth Platform → Clients → Create client**: type **Web application**. Under **Authorized redirect URIs** add:
   ```
   <PUBLIC_URL>/api/google-ads/callback
   ```
   for example `https://ads.example.com/api/google-ads/callback`, or `http://localhost:3000/api/google-ads/callback` on a local install. It must match `PUBLIC_URL` exactly (the app also shows this URI on the settings screen).
5. Copy the **Client ID** (`….apps.googleusercontent.com`) and **Client secret** (`GOCSPX-…`).

## 4. Paste and connect

1. In the app, sign in as an admin: **System settings → Google Ads**.
2. Paste the Client ID, Client secret, developer token and MCC ID. **Save**.
3. Click **Connect Google** and sign in with an email that has access to the MCC. Approve the consent screen.

The status turns to **Connected**. Credentials are stored encrypted with `ENCRYPTION_KEY`. Access does not expire on its own; it is lost only if the permission is removed at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) or the email's password changes. Then click **Reconnect Google**.

## 5. Pick each client's account

For each client: **Client settings → Google Ads** → choose the ad account from the list (or paste its customer ID). The scheduler syncs Google data every hour; use the sync button on the client's Google Ads tab to pull it right away.

## What the app changes

- Only reversible operations: pause / enable, daily budget, target CPA, device bid adjustments, adding negative keywords, creating new ad groups in **paused** state. Nothing is ever deleted on Google.
- Changes proposed by rules or AI wait in **Approvals** until a person approves them. MCP tools (your own Claude / ChatGPT) never change Google directly.
- Writes run only on accounts billed in **VND**. Other currencies stay read-only, so a budget figure is never applied in the wrong currency.

## Troubleshooting

| Error | Cause |
|---|---|
| `redirect_uri_mismatch` | The redirect URI in the OAuth client does not match `PUBLIC_URL` + `/api/google-ads/callback`. |
| `DEVELOPER_TOKEN_NOT_APPROVED` | The token only has Test Account access (step 2). |
| Daily quota exhausted | Explorer access allows 2,880 operations a day. Apply for Basic (step 2). |
| `USER_PERMISSION_DENIED` | The connected email has no access to the MCC, or the ad account is not under the MCC. |
| Connection drops after a week | The consent screen is still in **Testing**. Publish it (step 3) and reconnect. |
