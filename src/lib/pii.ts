// Mask phone numbers, emails, account numbers before sending customer messages to Claude.
// Phone numbers run before long numbers so "+84912345678" becomes [sđt] rather than "+[số]".
// (?<![\d.,]) avoids masking prices like "1.000.000.000" by mistake.
const PATTERNS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]"],
  [/(?:\(?\+\s?84\s?\)?|(?<![\d.,])84)(?:\s*\(0\))?(?:[\s.()-]{0,3}\d){9}(?!\d)/g, "[sđt]"], // +84 912 345 678, (+84) (0) 912...
  [/(?<![\d.,])0[1-9](?:[\s.()-]{0,3}\d){8,9}(?!\d)/g, "[sđt]"], // 0912 - 345 - 678, 028 3823 4567
  [/(?<![\d.,])[35789]\d{2}[\s-]{1,3}\d{3}[\s-]{1,3}\d{3}(?!\d)/g, "[sđt]"], // 912 345 678 (leading 0 dropped)
  [/\b\d{11,19}\b/g, "[số]"], // account numbers, card numbers
  [/\b\d{9,10}\b/g, "[số]"],
];

export function maskPii(text: string): string {
  return PATTERNS.reduce((t, [re, rep]) => t.replace(re, rep), text);
}

// ------------------------------------------------------------ Customer directory: extract phones / emails customers typed in messages

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_RES = [
  /(?:\(?\+\s?84\s?\)?|(?<![\d.,])84)(?:\s*\(0\))?(?:[\s.()-]{0,3}\d){9}(?!\d)/g,
  /(?<![\d.,])0[1-9](?:[\s.()-]{0,3}\d){8,9}(?!\d)/g,
];

/** Normalize to 0xxxxxxxxx; drop if not a valid VN number (10-11 digits, leading 0). */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("840")) d = d.slice(2);
  else if (d.startsWith("84")) d = `0${d.slice(2)}`;
  return /^0[1-9]\d{8,9}$/.test(d) ? d : null;
}

/** Phones and emails in the customer's messages (newest message first). */
export function extractContacts(texts: string[]) {
  const phones: string[] = [];
  const emails: string[] = [];
  for (const t of texts) {
    for (const re of PHONE_RES) for (const m of t.matchAll(re)) {
      const p = normalizePhone(m[0]);
      if (p && !phones.includes(p)) phones.push(p);
    }
    for (const m of t.matchAll(EMAIL_RE)) {
      const e = m[0].toLowerCase().replace(/\.$/, "");
      if (!emails.includes(e)) emails.push(e);
    }
  }
  return { phones, emails };
}

/** Bot lead notice to the group ("Hiện đủ SĐT" (show full phone) off): 0912345678 → 09123xxx; sales must click the claim link to see the full number. */
const hidePhone = (p: string) => `${p.slice(0, 5)}xxx`;
export function hidePhonesIn(text: string) {
  return PHONE_RES.reduce((t, re) => t.replace(re, (m) => {
    const p = normalizePhone(m);
    return p ? hidePhone(p) : m;
  }), text);
}

/** Partial mask for default display: 0912345678 → 0912***678, nguyenvan@example.com → ng***@example.com. */
export const maskPhone = (p: string) => `${p.slice(0, 4)}***${p.slice(-3)}`;
export const maskEmail = (e: string) => {
  const [u, d] = e.split("@");
  return `${u.slice(0, 2)}***@${d}`;
};
