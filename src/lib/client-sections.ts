import type { MessageKey, T } from "@/i18n/translate";
import {
  BarChart3,
  Bell,
  BookOpen,
  ClipboardCheck,
  Contact,
  Crosshair,
  FileText,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  Newspaper,
  PackageSearch,
  Plus,
  Repeat,
  Search,
  Send,
  Settings,
  ShoppingBag,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";

/**
 * Sections of the client page — a single source for the sidebar menu, page title + intro,
 * the breadcrumb in the top bar and the Quick search box. Add new client pages here.
 * `desc`: one sentence on what this page is for, written for newcomers.
 */
export type CountKey = "recs" | "replies" | "drafts" | "docs";
type Section = {
  path: string;
  label: string;
  desc: string;
  icon: LucideIcon;
  count?: CountKey;
  urgent?: boolean;
  /** Only shown when the client has connected this service (connected in Settings & connections). */
  needs?: "google" | "kiot";
  /** Sub-pages are tabs of this section (the header still shows title + description; not a "detail page"). */
  tabs?: boolean;
};
type SectionGroup = { key: string; label: string; items: Section[] };

const CLIENT_SECTIONS: SectionGroup[] = [
  {
    key: "overview",
    label: "Tổng quan",
    items: [
      { path: "", label: "Tổng quan", icon: LayoutDashboard, desc: "Số liệu 7 ngày, việc cần làm và tiến độ quy trình của khách này." },
      { path: "/audits", label: "Phân tích AI", icon: Sparkles, desc: "Claude kiểm tra tài khoản, tin nhắn và nội dung quảng cáo; chấm điểm sức khỏe, chỉ ra điểm mạnh và vấn đề." },
      { path: "/workflow", label: "Sơ đồ hoạt động", icon: Workflow, desc: "Hệ thống đang tự làm gì cho khách này và theo lịch nào." },
    ],
  },
  {
    key: "customers",
    label: "Khách nhắn tin",
    items: [
      { path: "/messages", label: "Tin nhắn", icon: MessageSquare, count: "replies", urgent: true, desc: "Hội thoại khách nhắn vào Page. AI chấm điểm và đánh dấu khách nóng cần trả lời." },
      { path: "/leads", label: "Danh sách khách", icon: Contact, desc: "Khách từ Form lead và Tin nhắn ở cùng một chỗ. Sale đánh giá ngay ở bảng, hoặc trên Google Sheet (đồng bộ 2 chiều)." },
      { path: "/nurture", label: "Chăm sóc lại", icon: Repeat, desc: "Tự gửi tin Messenger nhắc khách đã nhắn mà chưa chốt (trong 24 giờ)." },
    ],
  },
  {
    key: "ads",
    label: "Quảng cáo",
    items: [
      { path: "/recommendations", label: "Đề xuất chờ duyệt", icon: Inbox, count: "recs", urgent: true, desc: "Thay đổi Claude đề xuất (ngân sách, tắt/bật…). Xem, sửa rồi bấm Duyệt thì mới áp dụng lên Meta." },
      { path: "/create", label: "Tạo chiến dịch", icon: Plus, desc: "Nhờ Claude lên camp từ dữ liệu khách (kèm yêu cầu của bạn nếu có), hoặc tự tạo từng bước." },
      { path: "/drafts", label: "Bản nháp", icon: FileText, count: "drafts", desc: "Chiến dịch đã soạn, chỉ lưu trong hệ thống. Bấm Đăng để tạo chiến dịch thật trên Meta ở trạng thái Tạm dừng." },
      { path: "/audience", label: "Chân dung & targeting", icon: Crosshair, desc: "Khách mua là ai và nên nhắm tới ai — AI dựng từ tin nhắn, ID targeting tra thật trên Meta." },
      { path: "/audiences", label: "Tệp đối tượng", icon: Users, desc: "Tệp người đã nhắn tin / tương tác Page và tệp tương tự (Lookalike) để chạy quảng cáo." },
      { path: "/page-posts", label: "Fanpage", icon: Newspaper, desc: "Bài viết và bình luận gần đây trên Page — chọn bài tốt để chạy quảng cáo." },
      { path: "/content", label: "Duyệt nội dung", icon: ClipboardCheck, desc: "Gửi mẫu nội dung quảng cáo cho khách xem và duyệt trước khi chạy." },
    ],
  },
  {
    key: "results",
    label: "Kết quả & báo cáo",
    items: [
      { path: "/campaigns", label: "Báo cáo & đánh giá", icon: BarChart3, desc: "Hiệu quả từng chiến dịch, nhóm và mẫu quảng cáo theo khoảng ngày." },
      { path: "/google-ads", label: "Google Ads", icon: Search, needs: "google", desc: "Số liệu Google Ads, đề xuất tối ưu chờ duyệt và sửa tay: chiến dịch, từ khóa, cụm từ tìm kiếm." },
      { path: "/sales", label: "Bán hàng (KiotViet)", icon: ShoppingBag, needs: "kiot", desc: "Doanh thu, hóa đơn và khách mua tại cửa hàng, đọc từ KiotViet." },
      { path: "/lift", label: "Đo theo mã hàng", icon: PackageSearch, needs: "kiot", desc: "So số bán từng mã hàng trên KiotViet trước và trong khi chạy quảng cáo." },
      { path: "/client-reports", label: "Gửi báo cáo cho khách", icon: Send, desc: "Báo cáo dễ hiểu gửi khách qua Zalo, email, Telegram — gửi tay hoặc theo lịch." },
    ],
  },
  {
    key: "setup",
    label: "Thiết lập",
    items: [
      { path: "/settings", label: "Cài đặt & kết nối", icon: Settings, tabs: true, desc: "Thông tin khách và kết nối Meta, Google Ads, KiotViet; lịch cập nhật và tự động hóa tối ưu." },
      { path: "/notify", label: "Thông báo & báo cáo", icon: Bell, tabs: true, desc: "Bot báo lead mới vào nhóm Zalo / Telegram của khách, và lịch tự gửi báo cáo cho khách." },
      { path: "/knowledge", label: "Kho tri thức", icon: BookOpen, count: "docs", desc: "Tài liệu của khách (menu, bảng giá, hợp đồng, kế hoạch…) để Claude đọc khi phân tích và soạn quảng cáo." },
    ],
  },
];

const ALL = CLIENT_SECTIONS.flatMap((g) => g.items);

/** Section currently open, by the path after /clients/<id> (e.g. "/drafts/abc" → Drafts). */
export function sectionFor(rel: string): Section | undefined {
  const r = rel === "/" ? "" : rel;
  if (r === "/lead-notify") return ALL.find((s) => s.path === "/notify"); // old path, redirects to /notify
  return ALL.find((s) => (s.path === "" ? r === "" : r === s.path || r.startsWith(`${s.path}/`)));
}

/** Catalogue key of a section: "" → overview, "/page-posts" → pagePosts. */
function sectionKey(s: Pick<Section, "path">) {
  const p = s.path.replace(/^\//, "");
  return p ? p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) : "overview";
}

/** Section with label / description in the current UI language. */
export function localizeSection<S extends Section | undefined>(s: S, t: T): S {
  if (!s) return s;
  const k = sectionKey(s);
  return { ...s, label: t(`nav.sections.${k}.label` as MessageKey), desc: t(`nav.sections.${k}.desc` as MessageKey) };
}

/** All menu groups in the current UI language. */
export function localizedSections(t: T): SectionGroup[] {
  return CLIENT_SECTIONS.map((g) => ({ ...g, label: t(`nav.groups.${g.key}` as MessageKey), items: g.items.map((s) => localizeSection(s, t)) }));
}
