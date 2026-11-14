// Sample data for trying out the system before connecting Meta. Run: npm run seed (DELETES existing data).
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

let seed = 42;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const jitter = (v: number, p = 0.15) => v * (1 + (rand() * 2 - 1) * p);

type AdSpec = { key: string; name: string; status?: string; spend: number; results: number; cpm: number; ctr: number; freq: number; revenue?: number; text: string; headline: string };
type AdSetSpec = { name: string; status?: string; budget: number | null; targeting: object; ads: AdSpec[] };
type CampaignSpec = { name: string; objective: string; resultType: string; status?: string; budget: number | null; adSets: AdSetSpec[] };
type Turn = [who: "c" | "p", text: string, gapMin: number];
type ConvSpec = { name: string; ad: string | null; hoursAgo: number; turns: Turn[] };
type ClientSpec = {
  key: string;
  name: string;
  industry: string;
  brief: string;
  primaryResult: string;
  targetCpr: number;
  targetRoas?: number;
  maxDailyBudget: number;
  campaigns: CampaignSpec[];
  trend: (dayIndex: number) => number; // daily CPR multiplier, dayIndex 0 = 29 days ago
  conversations: ConvSpec[];
};

function metricsOf(a: { spend: number; results: number; cpm: number; ctr: number; freq: number; revenue?: number }) {
  const impressions = Math.round((a.spend / a.cpm) * 1000);
  return {
    spend: a.spend,
    impressions,
    reach: Math.round(impressions / a.freq),
    clicks: Math.round(impressions * (a.ctr / 100)),
    results: a.results,
    revenue: a.revenue ?? 0,
  };
}

const HCM = { geo_locations: { cities: [{ name: "Hồ Chí Minh" }] } };
const HN = { geo_locations: { cities: [{ name: "Hà Nội" }] } };

const CLIENTS: ClientSpec[] = [
  {
    key: "spa",
    name: "Spa Hoa Mai",
    industry: "Spa & thẩm mỹ",
    primaryResult: "messages",
    targetCpr: 60000,
    maxDailyBudget: 1500000,
    brief: `Spa tại Quận 3, TP.HCM. Mở cửa 9h-20h hằng ngày.
Dịch vụ chính:
- Triệt lông Diode Laser: nách 10 buổi 990k, bắp chân 10 buổi 2.990k, mép 10 buổi 690k. Cam kết hoàn tiền nếu không giảm 70% sau 5 buổi.
- Trị mụn chuẩn y khoa: liệu trình 6 buổi 2.400k, có bác sĩ da liễu khám miễn phí.
- Chăm sóc da cơ bản 199k/buổi.
Khuyến mãi tháng này: tặng 1 buổi chăm sóc da cho khách mua gói triệt.
Khách chủ yếu nữ 20-40 tuổi, dân văn phòng. Tone: thân thiện, xưng "em", gọi khách là "chị".
Có chỗ gửi xe máy miễn phí, ô tô gửi bãi gần đó.`,
    trend: (d) => (d < 18 ? 0.9 : 0.9 + (d - 18) * 0.045),
    campaigns: [
      {
        name: "TN - Triệt lông - T9",
        objective: "OUTCOME_ENGAGEMENT",
        resultType: "messages",
        budget: null,
        adSets: [
          {
            name: "Nữ 22-35 HCM - Làm đẹp",
            budget: 400000,
            targeting: { ...HCM, age_min: 22, age_max: 35, genders: [2], interests: ["Beauty salons", "Hair removal"] },
            ads: [
              { key: "spa_review", name: "Video review khách triệt nách", spend: 1920000, results: 44, cpm: 52000, ctr: 1.6, freq: 1.9, text: "Chị em đã thử triệt lông 5 buổi mà vẫn mọc lại? 🙅‍♀️ Xem chị Vy chia sẻ sau 6 buổi Diode Laser tại Hoa Mai...", headline: "Triệt nách 10 buổi chỉ 990k" },
              { key: "spa_ba", name: "Ảnh before-after triệt chân", spend: 890000, results: 14, cpm: 48000, ctr: 1.1, freq: 2.1, text: "Da chân mịn không còn viêm nang lông sau liệu trình 10 buổi. Cam kết hoàn tiền nếu không hiệu quả.", headline: "Triệt bắp chân - hoàn tiền nếu không hiệu quả" },
            ],
          },
          {
            name: "Broad nữ 20-40 HCM",
            budget: 300000,
            targeting: { ...HCM, age_min: 20, age_max: 40, genders: [2] },
            ads: [
              { key: "spa_review2", name: "Video review khách (bản broad)", spend: 1280000, results: 26, cpm: 41000, ctr: 1.4, freq: 1.7, text: "Chị em đã thử triệt lông 5 buổi mà vẫn mọc lại? 🙅‍♀️ Xem chị Vy chia sẻ sau 6 buổi Diode Laser tại Hoa Mai...", headline: "Triệt nách 10 buổi chỉ 990k" },
              { key: "spa_price", name: "Carousel bảng giá triệt lông", spend: 820000, results: 12, cpm: 39000, ctr: 0.9, freq: 1.8, text: "Bảng giá triệt lông trọn gói tại Hoa Mai 👇 Nách 990k - Mép 690k - Bắp chân 2.990k", headline: "Bảng giá triệt lông 2026" },
            ],
          },
        ],
      },
      {
        name: "TN - Trị mụn - T9",
        objective: "OUTCOME_ENGAGEMENT",
        resultType: "messages",
        budget: null,
        adSets: [
          {
            name: "Nữ 18-30 - Da mụn",
            budget: 350000,
            targeting: { ...HCM, age_min: 18, age_max: 30, genders: [2], interests: ["Acne", "Skin care"] },
            ads: [
              { key: "spa_acne_old", name: "Ảnh mụn trước-sau (cũ)", spend: 1910000, results: 14, cpm: 68000, ctr: 0.55, freq: 4.3, text: "Mụn viêm, mụn ẩn lâu năm? Liệu trình trị mụn chuẩn y khoa 6 buổi tại Hoa Mai.", headline: "Trị mụn dứt điểm" },
              { key: "spa_acne_doc", name: "Video bác sĩ tư vấn trị mụn", spend: 560000, results: 8, cpm: 55000, ctr: 1.2, freq: 1.6, text: "Bác sĩ da liễu Hoa Mai giải thích vì sao nặn mụn tại nhà khiến mụn nặng hơn. Khám da miễn phí khi đặt lịch trong tuần này.", headline: "Khám da miễn phí cùng bác sĩ" },
            ],
          },
        ],
      },
      {
        name: "Traffic - Website khuyến mãi",
        objective: "OUTCOME_TRAFFIC",
        resultType: "link_clicks",
        budget: null,
        adSets: [
          {
            name: "Broad HCM 18-45",
            budget: 200000,
            targeting: { ...HCM, age_min: 18, age_max: 45 },
            ads: [{ key: "spa_traffic", name: "Banner khuyến mãi tháng 9", spend: 1400000, results: 1850, cpm: 22000, ctr: 2.9, freq: 2.6, text: "Ưu đãi tháng 9 - xem ngay trên website!", headline: "Ưu đãi đến 50%" }],
          },
        ],
      },
      {
        name: "TN - Chăm sóc da - T8",
        objective: "OUTCOME_ENGAGEMENT",
        resultType: "messages",
        status: "PAUSED",
        budget: null,
        adSets: [
          {
            name: "Nữ 25-40 HCM",
            status: "PAUSED",
            budget: 200000,
            targeting: { ...HCM, age_min: 25, age_max: 40, genders: [2] },
            ads: [{ key: "spa_care", name: "Ảnh chăm sóc da 199k", status: "PAUSED", spend: 0, results: 0, cpm: 50000, ctr: 1, freq: 1, text: "Chăm sóc da cơ bản chỉ 199k.", headline: "Chăm sóc da 199k" }],
          },
        ],
      },
    ],
    conversations: [
      { name: "Nguyễn Thu Trang", ad: "spa_review", hoursAgo: 2, turns: [["c", "Chị muốn hỏi gói triệt nách 990k là 10 buổi luôn hả em", 0], ["p", "Dạ đúng rồi chị, 10 buổi Diode Laser, cam kết hoàn tiền nếu sau 5 buổi không giảm 70% ạ", 6], ["c", "Vậy thứ 7 này chị qua làm buổi đầu được không? Chị sđt 0903 123 456", 3]] },
      { name: "Lê Minh Anh", ad: "spa_review", hoursAgo: 5, turns: [["c", "Triệt có đau không em? Da chị nhạy cảm", 0], ["p", "Dạ công nghệ Diode có làm lạnh nên chỉ hơi châm chích nhẹ thôi chị ạ. Da nhạy cảm vẫn làm được, bên em test thử trước", 12], ["c", "Ok để chị sắp xếp lịch rồi báo em nha", 20]] },
      { name: "Phạm Hồng Nhung", ad: "spa_review2", hoursAgo: 8, turns: [["c", "Giá triệt nách bao nhiêu vậy shop", 0], ["p", "Dạ 990k cho 10 buổi chị nhé, tháng này tặng thêm 1 buổi chăm sóc da ạ", 95], ["c", "Bên Q.10 có chỗ 690k à", 4], ["c", "Có bớt không em", 1]] },
      { name: "Trần Bảo Ngọc", ad: "spa_price", hoursAgo: 10, turns: [["c", "Giá", 0], ["p", "Dạ chị quan tâm dịch vụ nào ạ? Bên em có triệt nách 990k, mép 690k, bắp chân 2.990k", 140]] },
      { name: "Hoàng Yến", ad: "spa_price", hoursAgo: 14, turns: [["c", "Ib giá triệt chân giúp mình", 0], ["p", "Dạ triệt bắp chân 10 buổi 2.990k chị ạ", 180], ["c", "Mắc quá", 30]] },
      { name: "Đỗ Thị Hạnh", ad: "spa_acne_old", hoursAgo: 3, turns: [["c", "giá trị mụn", 0]] },
      { name: "Bé Na", ad: "spa_acne_old", hoursAgo: 6, turns: [["c", "e 15 tuổi bị mụn nhiều làm dc ko ạ", 0], ["p", "Dạ em cần có ba mẹ đi cùng nha em", 200], ["c", "dạ thôi ạ", 5]] },
      { name: "Tuấn Kiệt", ad: "spa_acne_old", hoursAgo: 9, turns: [["c", "Nam trị mụn được không", 0], ["p", "Dạ được anh ạ", 160]] },
      { name: "Vũ Lan", ad: "spa_acne_old", hoursAgo: 20, turns: [["c", "Giá?", 0], ["p", "Dạ liệu trình 6 buổi 2.400k chị ạ", 150]] },
      { name: "Mai Phương", ad: "spa_acne_doc", hoursAgo: 4, turns: [["c", "Chị bị mụn ẩn vùng cằm 2 năm rồi, đi 2 chỗ không hết. Bác sĩ khám miễn phí là sao em", 0], ["p", "Dạ chị đặt lịch là được bác sĩ da liễu soi da và tư vấn phác đồ miễn phí ạ, không bắt buộc làm", 8], ["c", "Chiều mai 5h chị qua được không", 2], ["p", "Dạ được chị, chị cho em xin tên và SĐT để giữ lịch nhé", 3], ["c", "Phương - 0987 654 321", 1]] },
      { name: "Ngô Quỳnh", ad: "spa_acne_doc", hoursAgo: 30, turns: [["c", "Trị mụn có tái lại không em", 0], ["p", "Dạ nếu chị chăm sóc đúng theo hướng dẫn thì hạn chế tái rất nhiều ạ", 45], ["c", "Có trả góp không", 10]] },
      { name: "Kim Chi", ad: null, hoursAgo: 26, turns: [["c", "Spa có chỗ gửi ô tô không ạ", 0], ["p", "Dạ bên em có bãi gửi ô tô cách 50m chị nha", 20], ["c", "Ok cảm ơn em, mai chị qua làm chăm sóc da", 5]] },
      { name: "Thanh Tâm", ad: "spa_review", hoursAgo: 40, turns: [["c", "Chị làm xong buổi 3 rồi mà thấy lông vẫn mọc, vậy có bình thường không", 0], ["p", "Dạ buổi 3 lông vẫn mọc nhưng sẽ mảnh và thưa hơn chị ạ, từ buổi 5 sẽ thấy rõ", 25], ["c", "Ok em, hy vọng vậy", 3]] },
      { name: "Diệu Linh", ad: "spa_ba", hoursAgo: 12, turns: [["c", "Triệt chân có cần cạo trước không", 0], ["p", "Dạ chị cạo trước 1 ngày giúp em nhé", 30], ["c", "Vậy book giúp chị chủ nhật 10h", 2]] },
      { name: "Hữu Phước", ad: "spa_price", hoursAgo: 16, turns: [["c", "Tuyển nhân viên không ạ", 0]] },
    ],
  },
  {
    key: "furn",
    name: "Nội thất Gỗ Việt",
    industry: "Nội thất gỗ",
    primaryResult: "leads",
    targetCpr: 150000,
    maxDailyBudget: 3000000,
    brief: `Xưởng nội thất gỗ tự nhiên tại Hà Nội (xưởng ở Thạch Thất, showroom Cầu Giấy).
Sản phẩm: sofa gỗ sồi/óc chó (18-45tr), tủ bếp gỗ sồi/acrylic theo mét dài (8-12tr/m), bàn ăn, giường.
USP: làm tại xưởng không qua trung gian, bảo hành 5 năm, khảo sát và thiết kế 3D miễn phí nội thành Hà Nội, trả góp 0% qua thẻ tín dụng.
Khách: vợ chồng 28-50 tuổi mới nhận nhà chung cư/nhà phố tại Hà Nội.
Tone: lịch sự, chuyên nghiệp, xưng "em", gọi "anh/chị".`,
    trend: () => 1,
    campaigns: [
      {
        name: "Lead - Sofa gỗ - Form",
        objective: "OUTCOME_LEADS",
        resultType: "leads",
        budget: 800000,
        adSets: [
          {
            name: "Nhà mới 28-45 HN",
            budget: null,
            targeting: { ...HN, age_min: 28, age_max: 45, interests: ["Interior design", "Furniture", "Home improvement"] },
            ads: [
              { key: "f_factory", name: "Video xưởng sản xuất sofa", spend: 1760000, results: 15, cpm: 61000, ctr: 1.3, freq: 1.8, text: "Tận mắt xem 1 chiếc sofa gỗ óc chó được làm thế nào tại xưởng Gỗ Việt 🪵 Không qua trung gian - giá tận xưởng - bảo hành 5 năm.", headline: "Sofa gỗ tận xưởng, BH 5 năm" },
              { key: "f_living", name: "Ảnh sofa phòng khách", spend: 1340000, results: 9, cpm: 58000, ctr: 1.0, freq: 1.9, text: "Phòng khách ấm cúng hơn với sofa gỗ sồi tự nhiên. Nhận thiết kế 3D miễn phí.", headline: "Thiết kế 3D miễn phí" },
            ],
          },
          {
            name: "Lookalike khách cũ 1%",
            budget: null,
            targeting: { ...HN, age_min: 25, age_max: 55, custom_audiences: ["LAL 1% - Khách đã mua"] },
            ads: [
              { key: "f_carousel", name: "Carousel mẫu sofa", spend: 1450000, results: 7, cpm: 74000, ctr: 0.8, freq: 2.6, text: "10 mẫu sofa bán chạy nhất 2026 tại Gỗ Việt 👉", headline: "Top 10 mẫu sofa" },
              { key: "f_sale", name: "Ảnh khuyến mãi 20%", spend: 1050000, results: 5, cpm: 70000, ctr: 0.7, freq: 2.4, text: "Giảm 20% sofa gỗ trong tháng 9!", headline: "Giảm 20% tháng 9" },
            ],
          },
        ],
      },
      {
        name: "TN - Tủ bếp - Messenger",
        objective: "OUTCOME_ENGAGEMENT",
        resultType: "messages",
        budget: null,
        adSets: [
          {
            name: "Broad 30-50 HN",
            budget: 500000,
            targeting: { ...HN, age_min: 30, age_max: 50 },
            ads: [
              { key: "f_kitchen_video", name: "Video thi công tủ bếp", spend: 2150000, results: 29, cpm: 45000, ctr: 1.5, freq: 1.7, text: "Quy trình lắp tủ bếp gỗ sồi trong 1 ngày tại căn hộ Vinhomes Smart City. Khảo sát tận nhà miễn phí nội thành HN.", headline: "Khảo sát tủ bếp miễn phí" },
              { key: "f_kitchen_img", name: "Ảnh tủ bếp acrylic", spend: 1150000, results: 12, cpm: 47000, ctr: 1.1, freq: 1.8, text: "Tủ bếp acrylic bóng gương chống ẩm - từ 8tr/mét dài.", headline: "Tủ bếp từ 8tr/m" },
            ],
          },
        ],
      },
    ],
    conversations: [
      { name: "Nguyễn Văn Hùng", ad: "f_kitchen_video", hoursAgo: 3, turns: [["c", "Bếp nhà anh chữ L, 2m4 x 1m8, làm gỗ sồi thì khoảng bao nhiêu em", 0], ["p", "Dạ anh ơi bên em tính theo mét dài, gỗ sồi khoảng 10-12tr/m tùy phụ kiện. Anh cho em xin địa chỉ để bên em qua khảo sát miễn phí nhé", 240], ["c", "Nhà anh ở Mỹ Đình, cuối tuần qua được không", 10]] },
      { name: "Trần Thị Mai", ad: "f_kitchen_video", hoursAgo: 6, turns: [["c", "Tủ bếp bảo hành bao lâu vậy shop", 0], ["p", "Dạ bảo hành 5 năm chị ạ", 300], ["c", "Gỗ sồi có bị mối mọt không? Nhà chị tầng 1 hơi ẩm", 5]] },
      { name: "Lê Quang", ad: "f_kitchen_img", hoursAgo: 9, turns: [["c", "So với gỗ công nghiệp An Cường thì sao em", 0]] },
      { name: "Phạm Thu Hà", ad: "f_kitchen_video", hoursAgo: 20, turns: [["c", "Chị cần làm tủ bếp + tủ quần áo cho căn 3PN, bên em có làm trọn gói không", 0], ["p", "Dạ có chị ạ, bên em nhận trọn gói nội thất. Chị cho em xin SĐT để kiến trúc sư gọi tư vấn nhé", 180], ["c", "0912 345 678, chị tên Hà, nhận nhà tháng 11", 15], ["p", "Dạ em cảm ơn chị, KTS bên em sẽ gọi trong hôm nay ạ", 5]] },
      { name: "Hoàng Nam", ad: "f_factory", hoursAgo: 12, turns: [["c", "Xưởng ở đâu anh qua xem được không", 0], ["p", "Dạ xưởng ở Thạch Thất, showroom ở Cầu Giấy anh ạ", 60], ["c", "Sofa óc chó bộ 3m giá tầm nào", 3]] },
      { name: "Đặng Hương", ad: "f_sale", hoursAgo: 30, turns: [["c", "Giảm 20% áp dụng cho mẫu nào", 0], ["p", "Dạ áp dụng các mẫu sofa gỗ sồi chị ạ", 400], ["c", "Thôi để chị tham khảo thêm", 60]] },
      { name: "Bùi Tiến", ad: "f_carousel", hoursAgo: 28, turns: [["c", "Có trả góp không", 0], ["p", "Dạ có trả góp 0% qua thẻ tín dụng anh ạ", 350]] },
      { name: "Vũ Thảo", ad: "f_kitchen_img", hoursAgo: 15, turns: [["c", "Làm ở Bắc Ninh có được không em", 0], ["p", "Dạ được chị, ngoại thành có phí vận chuyển nhỏ ạ", 200], ["c", "Ok, gửi chị catalogue mẫu acrylic với", 8]] },
      { name: "Minh Đức", ad: "f_living", hoursAgo: 48, turns: [["c", "Thiết kế 3D mất phí không", 0], ["p", "Dạ miễn phí anh ạ, anh gửi em mặt bằng căn hộ nhé", 30], ["c", "[ảnh mặt bằng]", 20], ["p", "Dạ em nhận rồi, 2 ngày em gửi bản 3D anh xem ạ", 10]] },
      { name: "Thùy Dung", ad: "f_kitchen_video", hoursAgo: 2, turns: [["c", "Hôm qua bạn khảo sát nói 11tr/m, có bớt được không nếu chị làm thêm tủ lavabo", 0]] },
    ],
  },
  {
    key: "fashion",
    name: "Thời trang Linh Chi",
    industry: "Thời trang nữ online",
    primaryResult: "purchases",
    targetCpr: 120000,
    targetRoas: 3,
    maxDailyBudget: 2500000,
    brief: `Shop thời trang nữ online (website linhchi.vn + Messenger), giao toàn quốc, COD, đổi size trong 7 ngày.
Sản phẩm: váy công sở 350-550k, đầm dự tiệc 650-1.200k, áo sơ mi lụa 290-390k. BST Thu 2026 mới ra.
Size S-XL, có bảng size chi tiết. Freeship đơn từ 500k.
Khách: nữ 22-38, văn phòng, TP lớn. Tone: trẻ trung, xưng "Chi" hoặc "shop", gọi "nàng".`,
    trend: (d) => 1 + Math.sin(d / 4) * 0.08,
    campaigns: [
      {
        name: "Sales - BST Thu 2026 - Website",
        objective: "OUTCOME_SALES",
        resultType: "purchases",
        budget: 1200000,
        adSets: [
          {
            name: "Advantage+ nữ 20-35",
            budget: null,
            targeting: { geo_locations: { countries: ["VN"] }, age_min: 20, age_max: 35, genders: [2], advantage_audience: 1 },
            ads: [
              { key: "fa_lookbook", name: "Video lookbook BST Thu", spend: 3400000, results: 25, revenue: 13100000, cpm: 58000, ctr: 1.4, freq: 1.6, text: "Mùa thu này nàng chọn phong cách nào? 🍂 BST Thu 2026 - chất lụa mát, form tôn dáng.", headline: "BST Thu 2026 đã lên kệ" },
              { key: "fa_mix", name: "Ảnh mix đồ công sở", spend: 2200000, results: 13, revenue: 6700000, cpm: 55000, ctr: 1.0, freq: 1.7, text: "5 cách mix váy công sở cho tuần làm việc thanh lịch.", headline: "Váy công sở từ 350k" },
            ],
          },
          {
            name: "Retarget xem SP 30 ngày",
            budget: null,
            targeting: { geo_locations: { countries: ["VN"] }, custom_audiences: ["ViewContent 30d"], exclusions: ["Purchase 30d"] },
            ads: [{ key: "fa_dpa", name: "Carousel sản phẩm đã xem", spend: 1750000, results: 21, revenue: 9050000, cpm: 95000, ctr: 2.1, freq: 3.4, text: "Nàng còn nhớ em này chứ? 😍 Freeship cho đơn từ 500k hôm nay.", headline: "Freeship đơn từ 500k" }],
          },
        ],
      },
      {
        name: "TN - Đầm dự tiệc",
        objective: "OUTCOME_ENGAGEMENT",
        resultType: "messages",
        budget: null,
        adSets: [
          {
            name: "Nữ 25-40 HCM HN",
            budget: 400000,
            targeting: { geo_locations: { cities: [{ name: "Hồ Chí Minh" }, { name: "Hà Nội" }] }, age_min: 25, age_max: 40, genders: [2] },
            ads: [
              { key: "fa_party", name: "Video đầm dạ hội", spend: 1500000, results: 34, cpm: 49000, ctr: 1.5, freq: 1.8, text: "Tiệc cưới cuối năm đã có đầm chưa nàng? ✨ Đầm dự tiệc thiết kế, may sẵn size S-XL.", headline: "Đầm dự tiệc từ 650k" },
              { key: "fa_sale50", name: "Ảnh sale 50% đầm", spend: 1300000, results: 38, cpm: 36000, ctr: 2.2, freq: 2.0, text: "SALE 50% đầm dự tiệc - chỉ 3 ngày!!!", headline: "Sale 50% chỉ 3 ngày" },
            ],
          },
        ],
      },
    ],
    conversations: [
      { name: "Ngọc Hân", ad: "fa_party", hoursAgo: 2, turns: [["c", "Đầm đỏ trong video còn size M không shop, mình cao 1m60 nặng 50kg", 0], ["p", "Dạ còn nàng ơi, 1m60 50kg mặc M vừa đẹp ạ", 15], ["c", "Ok lấy mình 1 cái, giao về Q.7 nha. Sđt 0938 111 222", 3]] },
      { name: "Thu Uyên", ad: "fa_party", hoursAgo: 5, turns: [["c", "Chất liệu gì vậy shop, có bị nhăn không", 0], ["p", "Dạ chất lụa tơ Hàn ít nhăn nàng ạ", 20], ["c", "Có ảnh thật không shop", 2]] },
      { name: "Kiều Oanh", ad: "fa_sale50", hoursAgo: 4, turns: [["c", "Còn không", 0], ["p", "Dạ còn nàng, nàng lấy mẫu nào ạ", 50], ["c", "Mẫu 1", 60]] },
      { name: "Hồng Vân", ad: "fa_sale50", hoursAgo: 7, turns: [["c", "Giá sau giảm bao nhiêu", 0], ["p", "Dạ còn 325k-600k tùy mẫu ạ", 90], ["c", "Shopee có mẫu giống vậy 199k", 5]] },
      { name: "Bảo Trâm", ad: "fa_sale50", hoursAgo: 9, turns: [["c", "size", 0]] },
      { name: "Lan Hương", ad: "fa_sale50", hoursAgo: 11, turns: [["c", "Có ship COD không", 0], ["p", "Dạ có COD toàn quốc ạ", 120]] },
      { name: "Minh Thư", ad: "fa_sale50", hoursAgo: 13, turns: [["c", "Xem mẫu", 0], ["p", "Dạ nàng xem mẫu ở link này nha: linhchi.vn/dam-du-tiec", 110]] },
      { name: "Phương Thảo", ad: "fa_party", hoursAgo: 18, turns: [["c", "Mặc không vừa có đổi được không shop", 0], ["p", "Dạ đổi size trong 7 ngày nàng nhé", 25], ["c", "Vậy lấy mình đầm xanh size S, đầm đỏ size S luôn", 4], ["p", "Dạ nàng cho shop xin địa chỉ và SĐT ạ", 3]] },
      { name: "Diễm My", ad: null, hoursAgo: 22, turns: [["c", "Đơn hôm qua của mình khi nào giao vậy shop, mình cần mặc thứ 7", 0], ["p", "Dạ đơn nàng đang giao, dự kiến thứ 5 tới ạ", 180], ["c", "Ok cảm ơn shop", 10]] },
      { name: "Thanh Hằng", ad: "fa_dpa", hoursAgo: 26, turns: [["c", "Áo sơ mi lụa trắng còn size L không, đặt trên web báo hết", 0]] },
      { name: "Quỳnh Như", ad: "fa_lookbook", hoursAgo: 8, turns: [["c", "Mình 1m55 55kg mặc váy midi có bị lùn không shop", 0], ["p", "Dạ nàng chọn mẫu midi cạp cao + giày 5cm là tôn dáng lắm ạ, shop gửi nàng 2 mẫu gợi ý nhé", 12], ["c", "Gửi mình xem với", 2]] },
      { name: "Anh Thư", ad: "fa_sale50", hoursAgo: 15, turns: [["c", "Chất vải có mỏng không, ảnh nhìn hơi mỏng", 0], ["p", "Dạ vải có lót trong nàng ạ", 140], ["c", "Thôi để mình suy nghĩ", 30]] },
    ],
  },
];

async function main() {
  console.log("Deleting existing data...");
  await db.activity.deleteMany();
  await db.client.deleteMany();

  // Sample clients belong to the root workspace (created here if the app has not been set up yet).
  const workspace = (await db.workspace.findFirst({ where: { platform: true }, orderBy: { createdAt: "asc" } })) ?? (await db.workspace.create({ data: { name: "Sample workspace", platform: true } }));
  const today = new Date();
  for (const spec of CLIENTS) {
    const client = await db.client.create({
      data: {
        name: spec.name,
        workspaceId: workspace.id,
        industry: spec.industry,
        brief: spec.brief,
        primaryResult: spec.primaryResult,
        targetCpr: spec.targetCpr,
        targetRoas: spec.targetRoas ?? null,
        maxDailyBudget: spec.maxDailyBudget,
        maxBudgetChangePct: 30,
        dataSource: "mock",
        lastSyncedAt: today,
      },
    });
    const adIds = new Map<string, string>();
    let ci = 0;
    let adSetCounter = 0;
    for (const c of spec.campaigns) {
      ci++;
      const campaignId = `${spec.key}_c${ci}`;
      const adSetsM = c.adSets.map((s) => {
        const ads = s.ads.map((a) => ({ a, m: metricsOf(a) }));
        const sum = ads.reduce(
          (acc, { m }) => ({
            spend: acc.spend + m.spend,
            impressions: acc.impressions + m.impressions,
            reach: acc.reach + m.reach,
            clicks: acc.clicks + m.clicks,
            results: acc.results + m.results,
            revenue: acc.revenue + m.revenue,
          }),
          { spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0, revenue: 0 },
        );
        // Ad set reach is lower than the sum of its ads' reach because viewers overlap.
        return { s, ads, sum: { ...sum, reach: Math.round(sum.reach * 0.85) } };
      });
      const cSum = adSetsM.reduce(
        (acc, { sum }) => ({
          spend: acc.spend + sum.spend,
          impressions: acc.impressions + sum.impressions,
          reach: acc.reach + Math.round(sum.reach * 0.9),
          clicks: acc.clicks + sum.clicks,
          results: acc.results + sum.results,
          revenue: acc.revenue + sum.revenue,
        }),
        { spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0, revenue: 0 },
      );
      await db.campaign.create({
        data: {
          id: campaignId,
          clientId: client.id,
          name: c.name,
          objective: c.objective,
          status: c.status ?? "ACTIVE",
          dailyBudget: c.budget,
          resultType: c.resultType,
          createdTime: new Date(today.getTime() - 20 * 86400000),
          ...cSum,
        },
      });
      for (const { s, ads, sum } of adSetsM) {
        adSetCounter++;
        const adSetId = `${spec.key}_s${adSetCounter}`;
        await db.adSet.create({
          data: {
            id: adSetId,
            clientId: client.id,
            campaignId,
            name: s.name,
            status: s.status ?? "ACTIVE",
            dailyBudget: s.budget,
            optimizationGoal: { messages: "CONVERSATIONS", leads: "LEAD_GENERATION", purchases: "OFFSITE_CONVERSIONS", link_clicks: "LINK_CLICKS" }[c.resultType] ?? "",
            targeting: JSON.stringify(s.targeting),
            ...sum,
          },
        });
        for (const { a, m } of ads) {
          const adId = `${spec.key}_ad_${a.key}`;
          adIds.set(a.key, adId);
          await db.ad.create({
            data: { id: adId, clientId: client.id, campaignId, adSetId, name: a.name, status: a.status ?? "ACTIVE", primaryText: a.text, headline: a.headline, ...m },
          });
        }
      }
    }

    // Daily figures for the main result (30 days), roughly matching the 7-day total.
    const primary = spec.campaigns.filter((c) => c.resultType === spec.primaryResult && c.status !== "PAUSED");
    const all = spec.campaigns.flatMap((c) => c.adSets.flatMap((s) => s.ads));
    const weekSpend = all.reduce((a, x) => a + x.spend, 0);
    const primaryAds = primary.flatMap((c) => c.adSets.flatMap((s) => s.ads));
    const weekResults = primaryAds.reduce((a, x) => a + x.results, 0);
    const weekRevenue = all.reduce((a, x) => a + (x.revenue ?? 0), 0);
    const baseCpr = weekSpend / Math.max(1, weekResults);
    for (let d = 0; d < 30; d++) {
      const date = new Date(today.getTime() - (29 - d) * 86400000).toISOString().slice(0, 10);
      const spend = Math.round(jitter(weekSpend / 7, 0.12));
      const cpr = baseCpr * spec.trend(d) * jitter(1, 0.1) / spec.trend(26);
      const results = Math.max(0, Math.round(spend / cpr));
      const impressions = Math.round(spend / 55);
      await db.dailyMetric.create({
        data: {
          clientId: client.id,
          date,
          spend,
          impressions,
          clicks: Math.round(impressions * 0.013),
          results,
          revenue: weekRevenue ? Math.round(jitter(weekRevenue / 7, 0.2)) : 0,
        },
      });
    }

    let ti = 0;
    for (const conv of spec.conversations) {
      ti++;
      const convId = `${spec.key}_t${ti}`;
      let t = today.getTime() - conv.hoursAgo * 3600000;
      const msgs = conv.turns.map(([who, text, gap], i) => {
        t += gap * 60000;
        return { id: `${convId}_m${i}`, fromCustomer: who === "c", text, createdTime: new Date(t) };
      });
      await db.conversation.create({
        data: {
          id: convId,
          clientId: client.id,
          customerName: conv.name,
          updatedTime: msgs.at(-1)!.createdTime,
          sourceAdId: conv.ad ? adIds.get(conv.ad) ?? null : null,
          messages: { create: msgs },
        },
      });
    }
    // Sample optimisation suggestions waiting for approval, each tagged with the playbook rule that produced it.
    const sets = await db.adSet.findMany({ where: { clientId: client.id, status: "ACTIVE", dailyBudget: { gt: 0 } }, include: { campaign: true }, orderBy: { spend: "desc" } });
    const fatigued = await db.ad.findFirst({ where: { clientId: client.id, status: "ACTIVE" }, orderBy: { impressions: "desc" }, include: { adSet: { include: { campaign: true } } } });
    const cpr = spec.targetCpr;
    const recs = [
      sets[0] && {
        rule: "adset_winner", actionType: "update_budget", priority: "high", targetLevel: "adset", set: sets[0],
        newDailyBudget: Math.round(((sets[0].dailyBudget ?? 0) * 1.25) / 1000) * 1000,
        title: `Tăng ngân sách nhóm "${sets[0].name}" thêm 25%`,
        rationale: `Nhóm rẻ hơn mục tiêu với độ chắc trên 80% và đã tiêu hết 90% ngân sách trước 18h hai ngày liền. Tăng 25%, giữ trần ngân sách của khách.`,
      },
      sets.at(-1) && sets.length > 1 && {
        rule: "adset_expensive", actionType: "pause", priority: "medium", targetLevel: "adset", set: sets.at(-1)!,
        title: `Tắt nhóm "${sets.at(-1)!.name}": đắt hơn mục tiêu trên 40%`,
        rationale: `Đã chi hơn 2 lần CPR mục tiêu (${cpr.toLocaleString("vi-VN")}đ) và chi phí mỗi kết quả cao hơn mục tiêu trên 40%, độ chắc 90%. Chiến dịch vẫn còn nhóm khác đang chạy.`,
      },
      fatigued && {
        rule: "ad_fatigue", actionType: "manual", priority: "medium", targetLevel: "ad", set: fatigued.adSet, ad: fatigued,
        title: `Quảng cáo "${fatigued.name}" có dấu hiệu mỏi`,
        rationale: `Tần suất 7 ngày trên 3, CTR 3 ngày giảm hơn 20% trong khi CPM gần như không đổi. Nên thay nội dung mới, giữ nguyên tệp.`,
      },
    ].filter(Boolean) as { rule: string; actionType: string; priority: string; targetLevel: string; set: (typeof sets)[number]; ad?: { id: string; name: string }; newDailyBudget?: number; title: string; rationale: string }[];
    for (const r of recs) {
      await db.recommendation.create({
        data: {
          clientId: client.id, kind: "optimize", status: "pending", rule: r.rule, title: r.title, rationale: r.rationale, priority: r.priority,
          actionType: r.actionType, targetLevel: r.targetLevel, targetId: r.ad?.id ?? r.set.id, targetName: r.ad?.name ?? r.set.name,
          newDailyBudget: r.newDailyBudget ?? null, campaignId: r.set.campaignId, campaignName: r.set.campaign.name,
        },
      });
    }
    await db.activity.create({ data: { clientId: client.id, kind: "sync", message: "Tạo dữ liệu mẫu" } });
    console.log(`✓ ${spec.name}: ${spec.campaigns.length} chiến dịch, ${spec.conversations.length} hội thoại`);
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
