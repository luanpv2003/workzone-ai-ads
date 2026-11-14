import { ai } from "./vi/ai";
import { campaigns } from "./vi/campaigns";
import { workflow } from "./vi/workflow";
import { notify } from "./vi/notify";
import { customers } from "./vi/customers";
import { targeting } from "./vi/targeting";
import { settings } from "./vi/settings";
import { system } from "./vi/system";
import { core } from "./vi/core";
import { playbook } from "./vi/playbook";

// Vietnamese: the source catalogue. Add a key here first, then the same key in en.ts.
export const vi = {
  ai, campaigns, workflow, notify, customers, targeting, settings, system, core, playbook,
  common: {
    language: "Ngôn ngữ",
  },
  nav: {
    groups: {
      overview: "Tổng quan",
      customers: "Khách nhắn tin",
      ads: "Quảng cáo",
      results: "Kết quả & báo cáo",
      setup: "Thiết lập",
    },
    sections: {
      overview: { label: "Tổng quan", desc: "Số liệu 7 ngày, việc cần làm và tiến độ quy trình của khách này." },
      audits: { label: "Phân tích AI", desc: "Claude kiểm tra tài khoản, tin nhắn và nội dung quảng cáo; chấm điểm sức khỏe, chỉ ra điểm mạnh và vấn đề." },
      workflow: { label: "Sơ đồ hoạt động", desc: "Hệ thống đang tự làm gì cho khách này và theo lịch nào." },
      messages: { label: "Tin nhắn", desc: "Hội thoại khách nhắn vào Page. AI chấm điểm và đánh dấu khách nóng cần trả lời." },
      leads: { label: "Danh sách khách", desc: "Khách từ Form lead và Tin nhắn ở cùng một chỗ. Sale đánh giá ngay ở bảng, hoặc trên Google Sheet (đồng bộ 2 chiều)." },
      nurture: { label: "Chăm sóc lại", desc: "Tự gửi tin Messenger nhắc khách đã nhắn mà chưa chốt (trong 24 giờ)." },
      recommendations: { label: "Đề xuất chờ duyệt", desc: "Thay đổi Claude đề xuất (ngân sách, tắt/bật…). Xem, sửa rồi bấm Duyệt thì mới áp dụng lên Meta." },
      create: { label: "Tạo chiến dịch", desc: "Nhờ Claude lên camp từ dữ liệu khách (kèm yêu cầu của bạn nếu có), hoặc tự tạo từng bước." },
      drafts: { label: "Bản nháp", desc: "Chiến dịch đã soạn, chỉ lưu trong hệ thống. Bấm Đăng để tạo chiến dịch thật trên Meta ở trạng thái Tạm dừng." },
      audience: { label: "Chân dung & targeting", desc: "Khách mua là ai và nên nhắm tới ai: AI dựng từ tin nhắn, ID targeting tra thật trên Meta." },
      audiences: { label: "Tệp đối tượng", desc: "Tệp người đã nhắn tin / tương tác Page và tệp tương tự (Lookalike) để chạy quảng cáo." },
      pagePosts: { label: "Fanpage", desc: "Bài viết và bình luận gần đây trên Page: chọn bài tốt để chạy quảng cáo." },
      content: { label: "Duyệt nội dung", desc: "Gửi mẫu nội dung quảng cáo cho khách xem và duyệt trước khi chạy." },
      campaigns: { label: "Báo cáo & đánh giá", desc: "Hiệu quả từng chiến dịch, nhóm và mẫu quảng cáo theo khoảng ngày." },
      googleAds: { label: "Google Ads", desc: "Số liệu Google Ads, đề xuất tối ưu chờ duyệt và sửa tay: chiến dịch, từ khóa, cụm từ tìm kiếm." },
      sales: { label: "Bán hàng (KiotViet)", desc: "Doanh thu, hóa đơn và khách mua tại cửa hàng, đọc từ KiotViet." },
      lift: { label: "Đo theo mã hàng", desc: "So số bán từng mã hàng trên KiotViet trước và trong khi chạy quảng cáo." },
      clientReports: { label: "Gửi báo cáo cho khách", desc: "Báo cáo dễ hiểu gửi khách qua Zalo, email, Telegram: gửi tay hoặc theo lịch." },
      settings: { label: "Cài đặt & kết nối", desc: "Thông tin khách và kết nối Meta, Google Ads, KiotViet; lịch cập nhật và tự động hóa tối ưu." },
      notify: { label: "Thông báo & báo cáo", desc: "Bot báo lead mới vào nhóm Zalo / Telegram của khách, và lịch tự gửi báo cáo cho khách." },
      knowledge: { label: "Kho tri thức", desc: "Tài liệu của khách (menu, bảng giá, hợp đồng, kế hoạch…) để Claude đọc khi phân tích và soạn quảng cáo." },
    },
  },
};
