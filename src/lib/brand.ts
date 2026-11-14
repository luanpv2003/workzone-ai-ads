// Branding and operator identity. Everything installation-specific lives here so the
// codebase carries no hard-coded company, domain or contact. Set these in .env.
export const BRAND = {
  /** Product name shown in the UI. */
  app: process.env.NEXT_PUBLIC_APP_NAME || "Workzone AI Ads",
  /** Legal operator of this installation (privacy policy, data deletion). */
  operator: process.env.NEXT_PUBLIC_OPERATOR_NAME || "the operator of this installation",
  /** Name shown to clients as "who runs your ads" (reports, bot, emails). Defaults to the app name. */
  agency: process.env.NEXT_PUBLIC_OPERATOR_NAME || process.env.NEXT_PUBLIC_APP_NAME || "Workzone AI Ads",
  /** Operator website, shown on reports and legal pages. Empty = hidden. */
  site: process.env.NEXT_PUBLIC_OPERATOR_SITE || "",
};
