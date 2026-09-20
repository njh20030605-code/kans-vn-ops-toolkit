// node --test test/   —— 纯函数测试，不需要浏览器
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { MARKETS, TARGETS, detectMarket, detectPlatform } = require(path.join(__dirname, "..", "markets.js"));
const { createConverter, parseNumberLocale } = require(path.join(__dirname, "..", "fx-core.js"));

const CNY = TARGETS.CNY;
const mk = (code, platform, rate) => createConverter({ market: MARKETS[code], platform, rate, target: CNY });

test("本地化数字解析：点/逗号自动判别", () => {
  assert.equal(parseNumberLocale("22.653,20"), 22653.2);
  assert.equal(parseNumberLocale("1,234.5"), 1234.5);
  assert.equal(parseNumberLocale("89.684.715"), 89684715);
  assert.equal(parseNumberLocale("897,7"), 897.7);
  assert.equal(parseNumberLocale("8.7"), 8.7);
  assert.equal(parseNumberLocale("1,250,000"), 1250000);
});

test("越南 TikTok：后缀 đ、Tr/Tỷ 缩写", () => {
  const c = mk("VN", "tiktok", 3891);
  assert.equal(c.convertText("GMV 62.142.512đ"), "GMV ¥15,971");
  assert.equal(c.convertText("897,7Trđ"), "¥230,712");
  assert.equal(c.convertText("3,9Tđ"), "¥1,002,313");
  assert.equal(c.convertText("1.234.567 VND"), "¥317");
});

test("越南 Shopee：前缀 đ、逗号小数 + K", () => {
  const c = mk("VN", "shopee", 3891);
  assert.equal(c.convertText("đ89.684.715"), "¥23,049");
  assert.equal(c.convertText("đ22.653,20K"), "¥5,822");
});

test("泰国：฿ 前后缀都认，逗号千分位", () => {
  const c = mk("TH", "shopee", 4.5);
  assert.equal(c.convertText("฿1,234.50"), "¥274");
  assert.equal(c.extractAmount("฿ 9,000"), 9000);
  const t = mk("TH", "tiktok", 4.5);
  assert.equal(t.convertText("450 THB"), "¥100");
});

test("印尼：Rp 前缀、点千分位、jt/rb 缩写", () => {
  const c = mk("ID", "tiktok", 2250);
  assert.equal(c.convertText("Rp1.250.000"), "¥556");
  assert.equal(c.convertText("Rp1,2jt"), "¥533");
  assert.equal(c.convertText("Rp 450rb"), "¥200");
});

test("马来 / 菲律宾 / 新加坡：前缀符号", () => {
  assert.equal(mk("MY", "tiktok", 0.6).convertText("RM1,234.50"), "¥2,058");
  assert.equal(mk("PH", "tiktok", 8).convertText("₱12,345"), "¥1,543");
  assert.equal(mk("SG", "tiktok", 0.18).convertText("S$1,234.56"), "¥6,859");
});

test("换算成美元", () => {
  const c = createConverter({ market: MARKETS.VN, platform: "tiktok", rate: 26500, target: TARGETS.USD });
  assert.equal(c.convertText("2.650.000đ"), "$100");
});

test("不误伤：无符号计数、已换算文本、超上限", () => {
  const c = mk("VN", "tiktok", 3891);
  assert.equal(c.convertText("118.24K views"), "118.24K views");
  assert.equal(c.convertText("¥1,000"), "¥1,000");
  assert.ok(c.alreadyConverted("¥1,000"));
  assert.ok(isNaN(c.extractAmount("99.999.999.999.999đ")));   // 位数 > 13
  assert.equal(c.looksLikeMoney("118.24K"), true);            // 带倍数缩写才算候选
  assert.equal(c.looksLikeMoney("1.234"), false);             // 裸小数不到 bareMin
  assert.equal(c.looksLikeMoney("19,652,460"), true);         // ≥ 1e6 裸数字（卡片 GMV）
});

test("元素级判定：整块就是金额", () => {
  const c = mk("VN", "tiktok", 3891);
  assert.ok(c.isCurAmount("62.142.512đ"));
  assert.ok(!c.isCurAmount("62.142.512 orders"));
  const s = mk("VN", "shopee", 3891);
  assert.ok(s.isCurAmount("đ89.684.715"));
});

test("域名识别市场与平台", () => {
  assert.equal(detectMarket("seller-vn.tiktok.com"), "VN");
  assert.equal(detectMarket("banhang.shopee.vn"), "VN");
  assert.equal(detectMarket("seller-th.tiktok.com"), "TH");
  assert.equal(detectMarket("seller.shopee.co.id"), "ID");
  assert.equal(detectMarket("seller-my.tiktok.com"), "MY");
  assert.equal(detectMarket("seller.shopee.ph"), "PH");
  assert.equal(detectMarket("seller.shopee.sg"), "SG");
  assert.equal(detectMarket("ads.tiktok.com"), null);
  assert.equal(detectPlatform("banhang.shopee.vn"), "shopee");
  assert.equal(detectPlatform("seller-vn.tiktok.com"), "tiktok");
});
