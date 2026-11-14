# Connect Meta (Facebook / Instagram ads)

The app reads and manages a client's ads and Page messages through the Meta Marketing API with an access token. The most reliable token is a **System User token**: it does not expire and does not depend on any one person's Facebook login.

You do this once per Meta Business (Business Manager). One token can serve every ad account and Page that system user is given.

Contents: [1. Meta app](#1-create-a-meta-app) · [2. System user](#2-create-a-system-user) · [3. Assign assets](#3-assign-the-ad-account-and-the-page) · [4. Token](#4-generate-the-token) · [5. Paste it in the app](#5-paste-the-token-in-the-app) · [6. Webhook (optional)](#6-message-webhook-optional)

You need: admin access to the client's Business portfolio (business.facebook.com), and a [developer account](https://developers.facebook.com/) on the same Facebook profile.

## 1. Create a Meta app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create app**.
2. Name it (for example "Acme Ads Manager"), enter your contact email.
3. Use case: choose **Other**, then app type **Business**. (In some accounts the use case list shows **Create & manage ads with Marketing API**; choose that one if present.)
4. Business portfolio: select the business that owns or manages the client's ad account. Click **Create app**.
5. In the app dashboard, add the **Marketing API** product (**Add product** → Marketing API → **Set up**), if it was not added by the use case.
6. Note the **App ID** and, under **App settings → Basic**, the **App secret** (click **Show**). You need them only for the webhook (step 6).

[Screenshot: Create app → app type "Business"]

The app can stay in **Development** mode with standard access: a System User token works for the ad accounts and Pages assigned to it in your own business.

## 2. Create a system user

1. Open [business.facebook.com/settings](https://business.facebook.com/settings) (Meta Business Suite → **Settings**), and pick the right business portfolio top left.
2. **Users → System users → Add**.
3. Name it (for example "ads-app"), role **Admin** (needed to manage campaigns and budgets). Click **Create system user**.

[Screenshot: Business settings → System users → Add]

## 3. Assign the ad account and the Page

Still on the system user:

1. Click **Assign assets** (or **Add assets**).
2. **Ad accounts** → tick the client's ad account → turn on **Manage ad account** (full control). Save.
3. **Pages** → tick the client's Facebook Page → turn on full control (at minimum: content, messages, ads, insights). Save.
4. If the client's leads come from Instant Forms, the Page must also allow lead access: **Integrations → Leads access** → select the Page → make sure the system user (or the app) is allowed.

Also connect the app to the business: **Accounts → Apps → Add → Connect an app ID**, paste the App ID (skip if it is already listed).

[Screenshot: Assign assets → Ad accounts with "Manage ad account" on]

## 4. Generate the token

1. **Users → System users** → select the system user → **Generate new token**.
2. App: choose the app from step 1.
3. Token expiration: **Never**.
4. Tick these permissions (the app checks for exactly this list and tells you if one is missing):

   | Permission | Used for |
   |---|---|
   | `ads_read` | Read campaigns, ad sets, ads and metrics |
   | `ads_management` | Pause / resume, budgets, create campaigns (always created paused), after your approval |
   | `business_management` | Find the ad accounts and Pages of the business |
   | `pages_show_list` | List the Pages the token can use |
   | `pages_read_engagement` | Read Page posts and engagement |
   | `pages_read_user_content` | Read comments and customer posts on the Page |
   | `pages_manage_ads` | Promote Page posts, ads that open Messenger |
   | `pages_manage_metadata` | Turn on the message webhook for the Page |
   | `pages_messaging` | Read Messenger / Instagram conversations, send follow-ups inside Meta's 24-hour window |
   | `leads_retrieval` | Read Instant Form leads |

5. Click **Generate token** and copy it right away. It is shown only once (if you lose it, generate a new one; the old one keeps working until you revoke it).

[Screenshot: Generate token with the permission list]

Keep the token like a password.

## 5. Paste the token in the app

1. In the app, open the client (or **Add client**), then **Settings & connections → Info & Meta**.
2. **Data source**: choose **Real Meta API**.
3. Paste the token in the token field and click **Check & find accounts**. The app shows whose token it is, when it expires ("never expires" for a system user), and any missing permissions.
4. Pick the **Fanpage** and the **Ad account** (and Instagram, if any). Click **Save**.
5. Click **Update & analyze → Full analysis** at the top of the client page to run the first sync and build the profile.

The client's currency setting must match the ad account currency: the app checks this with Meta before any budget change and refuses on a mismatch.

All clients' tokens, their owners and expiry are listed under **System settings → Client tokens**, where you can replace a token for every client that uses it at once.

## 6. Message webhook (optional)

New messages reach the app in two ways:

- **Automatic fetching, always on.** The background worker pulls new conversations for every connected client **every 2 minutes**, and ad metrics every 15 minutes. Nothing to set up. This is all you need on your computer.
- **Webhook.** Meta pushes each message the moment it arrives, and tells the app **which ad the customer came from**. That second part only exists through the webhook (and only for conversations started after it is turned on), and it is what lets the app score lead quality per ad. Recommended on a server.

The webhook needs a public HTTPS address that Meta can call: `PUBLIC_URL/api/meta/webhook`.

### On your server

1. In the app: **System settings → Message webhook**. Copy the **Callback URL** (`https://ads.example.com/api/meta/webhook`) and the **Verify token** shown there.
2. Same page: enter your Meta app's **App ID** and **App secret** (step 1) and click **Save app**. The secret is stored encrypted and used to check that each webhook call really comes from Meta.
3. In the Meta app dashboard: **Webhooks** (in the left menu, or **Add product → Webhooks**). Choose the object **Page** → **Subscribe to this object**, paste the Callback URL and the Verify token, click **Verify and save**.
4. Under **Page**, subscribe to the fields: `messages`, `message_echoes`, `messaging_referrals`, `messaging_postbacks`.
5. Back in the app, on **System settings → Message webhook**, click **Enable webhook for the Page** for each client. This subscribes the client's Page to your app.
6. Send a test message to the Page. "Last event received" on the same page updates within seconds.

[Screenshot: Meta app → Webhooks → Page with the four fields subscribed]

In newer app dashboards, webhooks for Messenger can also sit under **Use cases → Engage with customers on Messenger from Meta → Customize → Messenger API settings → Configure webhooks**; the callback URL, verify token and fields are the same.

### On your computer

You can skip the webhook: messages are fetched automatically every couple of minutes. You only lose "which ad the customer came from" for new conversations.

### Optional: a temporary public address for the webhook

To try the webhook (or the Claude.ai / ChatGPT connectors) from your computer, a free [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) gives your local install a temporary `https://` address, without an account:

```bash
# macOS: brew install cloudflared     Linux / Windows: see the Cloudflare link above
cloudflared tunnel --url http://localhost:3000
```

It prints an address like `https://random-words.trycloudflare.com`. Then:

1. Put it in `.env` as `PUBLIC_URL="https://random-words.trycloudflare.com"` (leave `COOKIE_SECURE="false"`, you keep using the app at `http://localhost:3000`) and run `./scripts/install.sh` again.
2. Follow "On your server" above with that address.

Limits: the address changes every time you restart `cloudflared`, so the Meta webhook (and `PUBLIC_URL`) must be updated each time, and it works only while your computer and the tunnel are running. For anything lasting, use a server with a domain ([server.md](server.md)) or a named Cloudflare Tunnel.

## Troubleshooting

| Message in the app | Fix |
|---|---|
| "Missing permissions: …" | Generate a new token (step 4) and tick every permission in the list. |
| "The token sees no Pages" | The Page is not assigned to the system user (step 3), or `pages_show_list` was not ticked. |
| "The token sees no ad accounts" | The ad account is not assigned to the system user (step 3). |
| Webhook "Verify and save" fails | `PUBLIC_URL` must be the exact public `https://` address, and the app must be reachable from the internet. Check with `curl https://ads.example.com/login`. |
| Messages arrive but "Last event received" stays empty | The App secret saved in the app does not match the Meta app, or **Enable webhook for the Page** was not clicked for that client. |
