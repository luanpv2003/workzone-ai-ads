import { db } from "./db";
import { cleanTemplates, parseTemplates, type Templates } from "./notify-templates";

// System-wide shared message templates (System settings → Bot message templates). See lib/notify-templates.ts.

const KEY = "notify.templates";

export async function globalTemplates(): Promise<Templates> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  return parseTemplates(row?.value, "global");
}

export async function saveGlobalTemplates(v: unknown) {
  const t = cleanTemplates(v, "global");
  const value = JSON.stringify(t);
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  return t;
}
