import { norm } from "./text";
import type { MessageKey, T } from "@/i18n/translate";

// Standard industries for aggregating targeting performance across clients (picked from a list, not free text).
export const INDUSTRIES = [
  { key: "fnb", label: "Nhà hàng – F&B – Cà phê", words: ["nha hang", "f&b", "fnb", "am thuc", "quan an", "ca phe", "cafe", "coffee", "tra sua", "bar", "pub", "restaurant", "bep", "mon an", "do an"] },
  { key: "beauty_spa", label: "Spa – Thẩm mỹ – Làm đẹp", words: ["spa", "tham my", "lam dep", "nail", "salon", "toc", "massage", "triet long", "skincare"] },
  { key: "clinic", label: "Phòng khám – Y tế – Nha khoa", words: ["phong kham", "nha khoa", "benh vien", "y te", "bac si", "clinic", "rang"] },
  { key: "study_abroad", label: "Giáo dục – Du học – Học bổng", words: ["du hoc", "hoc bong", "study abroad", "visa du hoc", "truong quoc te"] },
  { key: "training", label: "Đào tạo – Khóa học – Ngoại ngữ", words: ["dao tao", "khoa hoc", "ngoai ngu", "tieng anh", "ielts", "trung tam", "hoc vien", "giao duc"] },
  { key: "real_estate", label: "Bất động sản", words: ["bat dong san", "can ho", "chung cu", "dat nen", "nha pho", "bds", "real estate"] },
  { key: "interior", label: "Nội thất – Xây dựng", words: ["noi that", "xay dung", "thiet ke nha", "sofa", "do go", "kien truc"] },
  { key: "fashion", label: "Thời trang – Phụ kiện", words: ["thoi trang", "quan ao", "giay", "tui", "phu kien", "fashion"] },
  { key: "cosmetics", label: "Mỹ phẩm", words: ["my pham", "son moi", "kem duong", "serum", "cosmetic"] },
  { key: "retail", label: "Bán lẻ – Thương mại điện tử", words: ["ban le", "shop", "cua hang", "thuong mai dien tu", "online", "sieu thi"] },
  { key: "travel_hotel", label: "Du lịch – Khách sạn – Homestay", words: ["du lich", "khach san", "homestay", "resort", "tour", "hotel"] },
  { key: "mother_baby", label: "Mẹ và bé", words: ["me va be", "me be", "tre em", "em be", "bim", "sua cho be"] },
  { key: "auto", label: "Ô tô – Xe máy", words: ["o to", "oto", "xe hoi", "xe may", "showroom xe"] },
  { key: "finance", label: "Tài chính – Bảo hiểm", words: ["tai chinh", "bao hiem", "ngan hang", "vay von", "dau tu", "chung khoan"] },
  { key: "events", label: "Sự kiện – Cưới hỏi", words: ["su kien", "cuoi", "wedding", "tiec", "event"] },
  { key: "b2b", label: "Dịch vụ doanh nghiệp (B2B)", words: ["b2b", "doanh nghiep", "phan mem", "saas", "logistics", "van tai", "marketing agency"] },
  { key: "other", label: "Khác", words: [] as string[] },
] as const;

/** Industry labels in the UI language of `t` (INDUSTRY_LABEL stays Vietnamese for existing importers). */
export const industryLabels = (t: T): Record<string, string> =>
  Object.fromEntries(INDUSTRIES.map((i) => [i.key, t(`core.industries.${i.key}` as MessageKey)]));

type IndustryKey = (typeof INDUSTRIES)[number]["key"];

/** Guess the standard industry from the industry description / name / brief (pre-fill, user-editable). Priority follows list order. */
export function guessIndustry(...texts: (string | null | undefined)[]): IndustryKey | null {
  // Whole-word matching (avoids "bar" matching inside "barber"...).
  const words = (s: string) => ` ${norm(s).replace(/[^a-z0-9&]+/g, " ").trim()} `;
  const t = words(texts.filter(Boolean).join(" "));
  for (const i of INDUSTRIES) if (i.words.some((w) => t.includes(words(w)))) return i.key;
  return null;
}
