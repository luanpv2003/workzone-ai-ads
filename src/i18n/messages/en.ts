import type { Messages } from "../translate";
import { ai } from "./en/ai";
import { campaigns } from "./en/campaigns";
import { workflow } from "./en/workflow";
import { notify } from "./en/notify";
import { customers } from "./en/customers";
import { targeting } from "./en/targeting";
import { settings } from "./en/settings";
import { system } from "./en/system";
import { core } from "./en/core";
import { playbook } from "./en/playbook";

// English: must contain every key of vi.ts (the type makes a missing key a compile error).
export const en: Messages = {
  ai, campaigns, workflow, notify, customers, targeting, settings, system, core, playbook,
  common: {
    language: "Language",
  },
  nav: {
    groups: {
      overview: "Overview",
      customers: "Conversations",
      ads: "Ads",
      results: "Results & reports",
      setup: "Setup",
    },
    sections: {
      overview: { label: "Overview", desc: "Last 7 days, to-dos and workflow progress for this client." },
      audits: { label: "AI analysis", desc: "Claude reviews the account, messages and ad content; scores account health and lists strengths and issues." },
      workflow: { label: "How it runs", desc: "What the system does for this client on its own, and on which schedule." },
      messages: { label: "Messages", desc: "Conversations on the Page. AI scores them and flags hot leads that need a reply." },
      leads: { label: "Leads", desc: "Lead-form and message leads in one place. Sales rate them right in the table or in Google Sheets (two-way sync)." },
      nurture: { label: "Follow-ups", desc: "Automatic Messenger follow-ups for people who messaged but did not buy (within 24 hours)." },
      recommendations: { label: "Pending approvals", desc: "Changes Claude suggests (budgets, pause/resume…). Review, edit, then Approve before anything reaches Meta." },
      create: { label: "Create campaign", desc: "Let Claude plan a campaign from the client's data (plus your brief), or build it step by step." },
      drafts: { label: "Drafts", desc: "Campaigns saved in the app only. Publish creates the real campaign on Meta, paused." },
      audience: { label: "Audience & targeting", desc: "Who buys and who to target: built by AI from conversations, with targeting IDs checked on Meta." },
      audiences: { label: "Custom audiences", desc: "People who messaged or engaged with the Page, plus lookalikes, for ad targeting." },
      pagePosts: { label: "Page", desc: "Recent posts and comments on the Page: pick strong posts to promote." },
      content: { label: "Content review", desc: "Send ad content to the client to review and approve before it runs." },
      campaigns: { label: "Reports", desc: "Performance of each campaign, ad set and ad over a date range." },
      googleAds: { label: "Google Ads", desc: "Google Ads data, optimization suggestions awaiting approval, and manual edits: campaigns, keywords, search terms." },
      sales: { label: "Sales (KiotViet)", desc: "In-store revenue, invoices and buyers, read from KiotViet." },
      lift: { label: "Product lift", desc: "Compare sales per product code in KiotViet before and during the ads." },
      clientReports: { label: "Client reports", desc: "Easy-to-read reports sent to the client via Zalo, email or Telegram, manually or on a schedule." },
      settings: { label: "Settings & connections", desc: "Client details and Meta, Google Ads, KiotViet connections; sync schedule and optimization automation." },
      notify: { label: "Notifications & reports", desc: "Bot posts new leads to the client's Zalo / Telegram group, and the schedule for client reports." },
      knowledge: { label: "Knowledge base", desc: "Client documents (menu, price list, contract, plan…) that Claude reads when analysing and writing ads." },
    },
  },
};
