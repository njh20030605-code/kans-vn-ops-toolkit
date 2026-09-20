# 跨境后台汇率换算插件 · TikTok Shop / Shopee 东南亚六国

> 作者：**Jasper Yang** · v2.0 · Chrome / Edge（Manifest V3）

把 TikTok Shop 与 Shopee 卖家后台里的本地货币金额，按**实时汇率**就地换算成人民币（¥）或美元（$）显示。
按域名自动识别市场；识别不出的页面（如 ads.tiktok.com）按弹窗里选的市场来。

<p align="center">
  <img src="demo/demo-before.png" width="49%" alt="换算前"> <img src="demo/demo-after.png" width="49%" alt="换算后">
</p>

## 支持的市场

| 市场 | 货币 | 认得的写法 | TikTok 后台 | Shopee 后台 |
|---|---|---|---|---|
| 越南 | VND | `62.142.512đ` `897,7Trđ` `3,9Tỷ` `đ22.653,20K` `1.234.567 VND` | seller-vn.tiktok.com | shopee.vn |
| 泰国 | THB | `฿1,234.50` `45,000 THB` | seller-th.tiktok.com | shopee.co.th |
| 印尼 | IDR | `Rp1.250.000` `Rp1,2jt` `Rp450rb` | seller-id.tiktok.com | shopee.co.id |
| 马来西亚 | MYR | `RM1,234.50` | seller-my.tiktok.com | shopee.com.my |
| 菲律宾 | PHP | `₱12,345` | seller-ph.tiktok.com | shopee.ph |
| 新加坡 | SGD | `S$1,234.56` | seller-sg.tiktok.com | shopee.sg |

英文缩写 K / M / B 六个市场通用。数字解析会自动判断逗号和点哪个是小数点，越南 / 印尼的「点千分位、逗号小数」和其它市场的「逗号千分位、点小数」都不会算错。

## 安装

1. 下载本目录（或 Release 里的 zip），放到一个固定位置。
2. 浏览器地址栏打开 `chrome://extensions`（Edge 是 `edge://extensions`），开右上角「开发者模式」。
3. 「加载已解压的扩展程序」→ 选中本目录。
4. 刷新卖家后台页面。

## 用法

点浏览器右上角插件图标：

- **市场**：在 TikTok / Shopee 各国卖家后台里自动识别并锁定；其它页面（广告后台、跨境店）手动选。
- **换算成**：人民币 或 美元。
- **当前汇率**：显示「1 ¥ ≈ 多少本地货币」和更新时间，可手动刷新。
- **开关**：关闭后刷新页面即恢复原始金额。

## 不会误伤

- 观看数、曝光、点击、订单数、百分比等不换算。
- 无货币符号的裸数字，只有在卡片标签是钱（GMV / Cost / Revenue / AOV …）且大于该市场的 `bareMin` 时才换算。
- 每个市场有金额上限 `maxLocal`，位数超过 13 位一律跳过，避免异常放大。

## 加一个新国家

只改 [`markets.js`](markets.js)，加一段：

```js
XX: {
  name: "国家名", currency: "货币代码", symbols: ["符号", "货币代码"],
  symbolPos: { tiktok: "prefix" | "suffix", shopee: "prefix" | "suffix" },
  mult: { 本地缩写: 倍数 },          // 没有就留 {}
  maxLocal: 1e10, bareMin: 1e4,
  tiktok: ["seller-xx.tiktok.com"], shopee: ["shopee.xx"],
},
```

再把 Shopee 域名加进 `manifest.json` 的 `host_permissions` 与 `content_scripts.matches`（TikTok 的 `*.tiktok.com` 已覆盖）。
`background.js` 的 `FALLBACK` 补一个兜底汇率。跑一遍测试即可。

## 结构与测试

```
markets.js     市场表（货币 / 符号 / 缩写 / 域名）
fx-core.js     纯函数：数字解析、金额识别、换算格式化（可在 Node 测试）
content.js     找 DOM、监听页面变化，调用 fx-core 就地替换
background.js  以目标货币为基准一次拉全所有市场汇率（open.er-api.com，6 小时刷新，失败用缓存 / 兜底）
popup.*        弹窗：选市场、选目标货币、看汇率、开关
demo/          演示页（换算前后截图就是它）
test/          node --test test/
```

```bash
node --test test/
```

## 说明

汇率来源 `open.er-api.com`（免费、无需 key）。这是把「显示」换成目标货币方便看，不改变平台实际结算货币，汇率为参考值。
