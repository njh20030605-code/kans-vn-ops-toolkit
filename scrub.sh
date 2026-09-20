#!/bin/bash
# 公开仓库脱敏：sync-from-desktop.sh 每次同步后自动调用。
# 去掉公司内部内容（知识库正文、培训手册）、同事姓名、Google 表 ID、群/人 ID、广告计划 ID。
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
sd() { sed -i '' "$@"; }

# 1. 知识库只留说明与示例，业务口径正文不进公开仓库
find "$R/feishu-api/kb" -type f ! -name README.md ! -name example.md -delete
cat > "$R/feishu-api/kb/example.md" <<'EOF'
# 示例：口径文件长什么样

> 真实的口径文件（KPI、阈值、禁区、在跑项目）只放在本机 `~/Desktop/feishu-api/kb/`，不进公开仓库。

## 汇率
- ₫3,860 ≈ ¥1；USD × 6.8 = RMB

## 低效素材
- 当天归一化成本 ≥ ¥70 且 ROI < 2 记为低效；成本 ≥ ¥200 且 ROI < 1 为红色预警
EOF

# 2. 培训手册生成脚本含公司 SOP 正文，整目录不公开
rm -rf "$R/feishu-api/intern-manual"

# 3. 同事姓名 → 角色
(grep -rIl -E 'Ryan|Pham' "$R/feishu-api" || true) | while read -r f; do sd -e 's/Ryan/InternA/g' -e 's/Pham/InternB/g' -e 's/ryan/InternA/g' "$f"; done
sd 's/杨佳林(Jasper)/Jasper Yang/g; s/杨佳林/Jasper/g' "$R/feishu-api/bot.js"

# 4. 飞书人 ID / 群 ID 清空（本机配置里有，公开副本不带）
[ -f "$R/feishu-api/creative-exclusion/config.json" ] && sd -E 's/"intern_open_id": "ou_[0-9a-f]+"/"intern_open_id": ""/' "$R/feishu-api/creative-exclusion/config.json"
sd -E "s/const OWNER_OPEN_ID = 'ou_[0-9a-f]+'/const OWNER_OPEN_ID = process.env.FEISHU_OWNER_OPEN_ID || ''/" "$R/feishu-api/bot.js"
for c in roi-monitor roi-monitor-win; do
  sd -E 's/"chatId": "oc_[0-9a-f]+"/"chatId": ""/; s/"rootFolderId": "[A-Za-z0-9_-]+"/"rootFolderId": ""/' "$R/$c/config.json"
  # 广告计划 ID → 示例文件
  if [ -f "$R/$c/campaigns.json" ]; then
    python3 - "$R/$c" <<'PY'
import json,sys,os
d=sys.argv[1]; rows=json.load(open(os.path.join(d,'campaigns.json'),encoding='utf-8'))
ex=[]
for i,r in enumerate(rows[:3]):
    e={"name":f"示例-商品广告-{i+1}" if r.get('type')!='live' else "示例-直播GMVMax","campaign_id":"填 TikTok 后台的推广系列ID","product_id":"填商品ID"}
    if r.get('type')=='live': e={"name":"示例-直播GMVMax","campaign_id":"填推广系列ID","type":"live"}
    ex.append(e)
json.dump(ex,open(os.path.join(d,'campaigns.example.json'),'w',encoding='utf-8'),ensure_ascii=False,indent=2)
os.remove(os.path.join(d,'campaigns.json'))
PY
  fi
done
(grep -rIl --exclude=scrub.sh 'njh20030605@gmail.com' "$R" || true) | while read -r f; do sd 's/njh20030605@gmail.com/<你的 Google 账号邮箱>/g' "$f"; done
# 代码里的默认群 ID / 文档里的示例群 ID 也清掉
(grep -rIl --exclude=scrub.sh --exclude-dir=.git -E 'oc_[0-9a-f]{20,}' "$R" || true) | while read -r f; do sd -E 's/oc_[0-9a-f]{20,}/oc_填你的飞书群ID/g' "$f"; done

# 5. Google 表 ID（知道链接即可读的主播 GMV 表）→ 环境变量
sd -E 's/"workbook_id": "[A-Za-z0-9_-]{20,}",/"workbook_id": "",/' "$R/host-ranking/report_core.py"

# 6. 插件 README 的内部使用声明
sd 's/ · 仅供内部使用，勿外传 \/ 勿用于盈利 · Beta 测试版//' "$R/vnd-cny-extension/README.md"

# 8. 本机配置不进仓库，只留 *.example.json 模板
rm -f "$R/feishu-api/settings.json" "$R/feishu-api/kans-board/config.json" "$R/feishu-api/intern-workflow/config.json"
if [ -f "$R/feishu-api/creative-exclusion/config.json" ]; then
  mv "$R/feishu-api/creative-exclusion/config.json" "$R/feishu-api/creative-exclusion/config.example.json"
  sd -E 's/"app_token": "[A-Za-z0-9]+"/"app_token": "填多维表格appToken"/; s#"base_url": "https://[^"]+"#"base_url": "https://你的域名.feishu.cn/base/appToken"#; s/"table": "tbl[A-Za-z0-9]+"/"table": "tbl填表ID"/' "$R/feishu-api/creative-exclusion/config.example.json"
fi
rm -f "$R/host-ranking/config.json"

# 7. 自检：不该出现的东西
if grep -rIn -E 'Ryan|Pham|杨佳林|ou_[0-9a-f]{20,}|oc_[0-9a-f]{20,}|1u_5ZKG9|njh20030605@' "$R" --exclude-dir=.git --exclude=scrub.sh; then
  echo "❌ 脱敏未完成，见上"; exit 1
fi
echo "✅ scrub ok"
