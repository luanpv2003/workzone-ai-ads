import type { MessageKey } from "@/i18n/translate";
/** Target audience origin of each client (Client.audienceOrigin). Imports nothing so browser-side pages can use it. */
export const AUDIENCE_ORIGINS = [
  { value: "vn", label: "Người Việt", labelKey: "targeting.audienceOrigin.vn" },
  { value: "foreign", label: "Khách nước ngoài (du khách, người nước ngoài sống ở VN)", labelKey: "targeting.audienceOrigin.foreign" },
  { value: "mixed", label: "Cả hai", labelKey: "targeting.audienceOrigin.mixed" },
] as const satisfies readonly { value: string; label: string; labelKey: MessageKey }[];
