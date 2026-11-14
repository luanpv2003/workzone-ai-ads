import { AI_LANGUAGE, type Locale } from "@/i18n/config";
import { getLocale } from "@/i18n/server";

// Language the AI writes user-facing text in: the user's UI language (Vietnamese outside a request: cron, background jobs).
// Text addressed to the client's own customers (ad copy, suggested replies, customer messages, bot messages to the client's team)
// does NOT follow this rule: each prompt states the language for those (Vietnamese, the language of the client's customers).

function outputLanguageRuleFor(locale: Locale) {
  const lang = AI_LANGUAGE[locale];
  return (
    `OUTPUT LANGUAGE: ${lang}. Write all user-facing text (summaries, rationale, explanations, titles, labels, questions, notes, guides, reasons) in ${lang}` +
    (locale === "vi" ? " with full, correct diacritics (never write Vietnamese without diacritics)." : ".") +
    ` Text addressed to the client's own customers or published to them (ad copy, suggested replies, customer messages, bot messages to the client's team) follows the language rules stated in the task above, not this line.`
  );
}

/** Instruction appended to every system prompt (generateStructured) so user-facing text matches the UI language. */
export async function outputLanguageRule() {
  return outputLanguageRuleFor(await getLocale());
}
