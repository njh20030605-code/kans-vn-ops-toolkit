#!/bin/bash
# 双击运行:修改命中阈值(ROI / 成本 / 汇率)。改完下一轮扫描自动生效,不用重启常驻程序。
cd "$(dirname "$0")"
echo "==== KANS 预警 · 修改阈值设置 ===="
node src/index.js set
echo ""
echo "完成。按任意键关闭窗口。"
read -n 1
