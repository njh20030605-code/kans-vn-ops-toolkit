# -*- coding: utf-8 -*-
"""
KANS 主播排名生成器 —— 桌面界面（品牌版）
三语界面（简体中文 / English / Tiếng Việt）、KANS 品牌红、指定日期弹出日历。
"""

import calendar as _cal
import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from datetime import datetime
from tkinter import ttk

import report_core as core

# ---------------- 品牌配色 ----------------
BG = "#F5F6F8"
CARD = "#FFFFFF"
BRAND = "#C8161E"      # KANS 红
BRAND_DK = "#A11017"
INK = "#1F2937"
MUTE = "#6B7280"
LINE = "#E5E7EB"
SOFT = "#FBEBEC"       # 淡红底

# ---------------- 三语文案 ----------------
TR = {
    "简体中文": {
        "win": "KANS 主播排名生成器",
        "product": "主播排名生成器",
        "subtitle": "合并各直播间 · 自动生成 前一天 / 当月 主播排名",
        "ui_lang": "界面语言",
        "rate": "固定汇率  1 元人民币 = {rate:,} 越南盾",
        "outputs": "输出一个 Excel · 三个工作表：简体中文(元) / English(VND) / Tiếng Việt(VND)",
        "date_group": "统计日期",
        "auto": "前一天（推荐 · 当天数据不统计）",
        "manual": "指定日期",
        "pick": "📅 选择日期",
        "gen": "生 成 报 表",
        "gening": "生成中 …",
        "open": "打开报表文件夹",
        "ready": "准备就绪，点击「生成报表」。",
        "fetching": "正在读取并合并各直播间数据 …",
        "rooms": "合并直播间：{r}",
        "daily": "当日 {d}：{n} 场，{k} 位主播",
        "monthly": "当月 {ym}：{n} 场，{k} 位主播",
        "saved": "✅ 已生成：\n{p}",
        "err_date": "请先选择日期。",
        "err_empty": "没读到数据，请检查表是否可访问。",
        "err_notabs": "没找到当月的直播间 tab，请检查表结构。",
        "err_nopast": "今天之前没有可统计的成交数据。",
        "err_net": "读取失败，请检查网络（谷歌需可访问）后重试。",
        "err": "出错：{m}",
        "wk": ["一", "二", "三", "四", "五", "六", "日"],
        "today": "今天",
        "cal_title": "选择日期",
    },
    "English": {
        "win": "KANS Host Ranking Generator",
        "product": "Host Ranking Generator",
        "subtitle": "Merge all live rooms · previous-day / monthly rankings",
        "ui_lang": "Language",
        "rate": "Fixed rate  1 CNY = {rate:,} VND",
        "outputs": "One Excel · 3 sheets: 简体中文(CNY) / English(VND) / Tiếng Việt(VND)",
        "date_group": "Date",
        "auto": "Previous day (recommended · today excluded)",
        "manual": "Specific date",
        "pick": "📅 Pick a date",
        "gen": "G E N E R A T E",
        "gening": "Generating …",
        "open": "Open report folder",
        "ready": "Ready. Click “Generate”.",
        "fetching": "Reading and merging all live rooms …",
        "rooms": "Rooms merged: {r}",
        "daily": "Day {d}: {n} sessions, {k} hosts",
        "monthly": "Month {ym}: {n} sessions, {k} hosts",
        "saved": "✅ Saved:\n{p}",
        "err_date": "Please pick a date first.",
        "err_empty": "No data read; check sheet access.",
        "err_notabs": "No live-room tab found for this month.",
        "err_nopast": "No completed sales data before today.",
        "err_net": "Fetch failed; check network (Google must be reachable).",
        "err": "Error: {m}",
        "wk": ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
        "today": "Today",
        "cal_title": "Select date",
    },
    "Tiếng Việt": {
        "win": "Trình tạo xếp hạng Host KANS",
        "product": "Trình tạo xếp hạng Host",
        "subtitle": "Gộp các phòng live · xếp hạng ngày hôm trước / theo tháng",
        "ui_lang": "Ngôn ngữ",
        "rate": "Tỷ giá cố định  1 CNY = {rate:,} VND",
        "outputs": "Một Excel · 3 sheet: 简体中文(CNY) / English(VND) / Tiếng Việt(VND)",
        "date_group": "Ngày thống kê",
        "auto": "Ngày hôm trước (khuyên dùng · bỏ qua hôm nay)",
        "manual": "Chọn ngày cụ thể",
        "pick": "📅 Chọn ngày",
        "gen": "T Ạ O   B Á O   C Á O",
        "gening": "Đang tạo …",
        "open": "Mở thư mục báo cáo",
        "ready": "Sẵn sàng. Nhấn «Tạo báo cáo».",
        "fetching": "Đang đọc và gộp các phòng live …",
        "rooms": "Đã gộp phòng: {r}",
        "daily": "Ngày {d}: {n} buổi, {k} host",
        "monthly": "Tháng {ym}: {n} buổi, {k} host",
        "saved": "✅ Đã lưu:\n{p}",
        "err_date": "Vui lòng chọn ngày trước.",
        "err_empty": "Không đọc được dữ liệu; kiểm tra quyền truy cập bảng.",
        "err_notabs": "Không tìm thấy tab phòng live cho tháng này.",
        "err_nopast": "Chưa có dữ liệu doanh số trước hôm nay.",
        "err_net": "Tải thất bại; kiểm tra mạng (cần vào được Google).",
        "err": "Lỗi: {m}",
        "wk": ["T2", "T3", "T4", "T5", "T6", "T7", "CN"],
        "today": "Hôm nay",
        "cal_title": "Chọn ngày",
    },
}


class CalendarPopup(tk.Toplevel):
    """纯 tkinter 弹出日历，选中后回填日期。"""

    def __init__(self, app, initial=None):
        super().__init__(app.root)
        self.app = app
        self.title(app.t("cal_title"))
        self.resizable(False, False)
        self.configure(bg=CARD)
        self.transient(app.root)

        base = datetime.now()
        if initial:
            try:
                base = datetime.strptime(initial, "%Y-%m-%d")
            except ValueError:
                pass
        self.year, self.month = base.year, base.month

        head = tk.Frame(self, bg=BRAND)
        head.pack(fill="x")
        tk.Button(head, text="‹", command=self._prev, bd=0, bg=BRAND, fg="white",
                  activebackground=BRAND_DK, activeforeground="white",
                  font=("Helvetica", 16, "bold"), width=3, cursor="hand2").pack(side="left")
        self.lbl = tk.Label(head, text="", bg=BRAND, fg="white",
                            font=("Helvetica", 13, "bold"))
        self.lbl.pack(side="left", expand=True)
        tk.Button(head, text="›", command=self._next, bd=0, bg=BRAND, fg="white",
                  activebackground=BRAND_DK, activeforeground="white",
                  font=("Helvetica", 16, "bold"), width=3, cursor="hand2").pack(side="right")

        self.grid = tk.Frame(self, bg=CARD)
        self.grid.pack(padx=8, pady=(6, 4))

        foot = tk.Frame(self, bg=CARD)
        foot.pack(fill="x", padx=8, pady=(0, 8))
        tk.Button(foot, text=app.t("today"), command=self._today, bd=0,
                  bg=SOFT, fg=BRAND, activebackground="#F6D8DA",
                  font=("Helvetica", 11), cursor="hand2").pack(fill="x")

        self._draw()
        self.update_idletasks()
        x = app.date_entry.winfo_rootx()
        y = app.date_entry.winfo_rooty() + app.date_entry.winfo_height() + 4
        self.geometry(f"+{x}+{y}")
        self.grab_set()
        self.bind("<Escape>", lambda e: self.destroy())

    def _draw(self):
        for w in self.grid.winfo_children():
            w.destroy()
        self.lbl.config(text=f"{self.year} - {self.month:02d}")
        for i, name in enumerate(self.app.tr()["wk"]):
            fg = BRAND if i >= 5 else MUTE
            tk.Label(self.grid, text=name, bg=CARD, fg=fg,
                     font=("Helvetica", 10, "bold"), width=4).grid(row=0, column=i, pady=(0, 2))
        today = datetime.now().date()
        weeks = _cal.Calendar(firstweekday=0).monthdayscalendar(self.year, self.month)
        for r, week in enumerate(weeks, start=1):
            for c, day in enumerate(week):
                if day == 0:
                    continue
                is_today = (today.year == self.year and today.month == self.month
                            and today.day == day)
                b = tk.Button(self.grid, text=str(day), width=4, bd=0,
                              bg=SOFT if is_today else CARD,
                              fg=BRAND if is_today else INK,
                              activebackground=BRAND, activeforeground="white",
                              font=("Helvetica", 11, "bold" if is_today else "normal"),
                              cursor="hand2", command=lambda d=day: self._pick(d))
                b.grid(row=r, column=c, padx=1, pady=1)

    def _prev(self):
        self.month -= 1
        if self.month == 0:
            self.month, self.year = 12, self.year - 1
        self._draw()

    def _next(self):
        self.month += 1
        if self.month == 13:
            self.month, self.year = 1, self.year + 1
        self._draw()

    def _today(self):
        n = datetime.now()
        self._set(n.year, n.month, n.day)

    def _pick(self, day):
        self._set(self.year, self.month, day)

    def _set(self, y, m, d):
        self.app.set_manual_date(f"{y:04d}-{m:02d}-{d:02d}")
        self.destroy()


class App:
    def __init__(self, root):
        self.root = root
        self.lang = "简体中文"
        self.q = queue.Queue()
        self.last_path = None
        self._build()
        self._apply_lang()
        self.root.after(100, self._pump)

    def tr(self):
        return TR[self.lang]

    def t(self, key, **kw):
        return TR[self.lang][key].format(**kw)

    # ---------- 构建界面 ----------
    def _build(self):
        self.root.configure(bg=BG)
        self.root.geometry("620x640")
        self.root.minsize(600, 600)

        style = ttk.Style()
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("TFrame", background=BG)
        style.configure("Card.TFrame", background=CARD)
        style.configure("TLabel", background=CARD, foreground=INK, font=("Helvetica", 12))
        style.configure("Mute.TLabel", background=CARD, foreground=MUTE, font=("Helvetica", 11))
        style.configure("Sub.TLabel", background=BG, foreground=MUTE, font=("Helvetica", 11))
        style.configure("Prod.TLabel", background=BG, foreground=INK, font=("Helvetica", 17, "bold"))
        style.configure("TRadiobutton", background=CARD, foreground=INK, font=("Helvetica", 12))
        style.map("TRadiobutton", background=[("active", CARD)])
        style.configure("Accent.TButton", font=("Helvetica", 15, "bold"), padding=12,
                        borderwidth=0)
        style.map("Accent.TButton",
                  background=[("!disabled", BRAND), ("disabled", "#E3A6A9"), ("active", BRAND_DK)],
                  foreground=[("!disabled", "white"), ("disabled", "white")])
        style.configure("Ghost.TButton", font=("Helvetica", 11), padding=7)
        style.configure("Pick.TButton", font=("Helvetica", 11), padding=4)

        outer = ttk.Frame(self.root, style="TFrame")
        outer.pack(fill="both", expand=True, padx=22, pady=18)

        # ===== 品牌头部 =====
        head = ttk.Frame(outer, style="TFrame")
        head.pack(fill="x")

        left = ttk.Frame(head, style="TFrame")
        left.pack(side="left", anchor="w")
        wm = ttk.Frame(left, style="TFrame")
        wm.pack(anchor="w")
        tk.Label(wm, text="KANS", bg=BG, fg=BRAND,
                 font=("Arial Black", 34, "bold")).pack(side="left")
        tk.Label(wm, text="®", bg=BG, fg=BRAND, font=("Arial", 12)).pack(side="left", anchor="n")
        self.lbl_prod = ttk.Label(left, text="", style="Prod.TLabel")
        self.lbl_prod.pack(anchor="w", pady=(2, 0))
        self.lbl_sub = ttk.Label(left, text="", style="Sub.TLabel")
        self.lbl_sub.pack(anchor="w", pady=(1, 0))

        langbox = ttk.Frame(head, style="TFrame")
        langbox.pack(side="right", anchor="ne")
        self.lbl_lang = ttk.Label(langbox, text="", style="Sub.TLabel")
        self.lbl_lang.pack(anchor="e")
        self.lang_var = tk.StringVar(value=self.lang)
        self.lang_combo = ttk.Combobox(langbox, textvariable=self.lang_var, width=12,
                                       state="readonly", values=list(TR.keys()))
        self.lang_combo.pack(anchor="e", pady=(3, 0))
        self.lang_combo.bind("<<ComboboxSelected>>", self._on_lang)

        tk.Frame(outer, bg=BRAND, height=3).pack(fill="x", pady=(12, 0))

        # ===== 卡片 =====
        card = ttk.Frame(outer, style="Card.TFrame")
        card.pack(fill="both", expand=True, pady=(14, 0))
        pad = ttk.Frame(card, style="Card.TFrame")
        pad.pack(fill="both", expand=True, padx=20, pady=18)

        self.lbl_rate = ttk.Label(pad, text="", style="Mute.TLabel")
        self.lbl_rate.pack(anchor="w")
        self.lbl_outputs = ttk.Label(pad, text="", style="Mute.TLabel")
        self.lbl_outputs.pack(anchor="w", pady=(3, 12))

        self.lbl_date = ttk.Label(pad, text="", font=("Helvetica", 12, "bold"))
        self.lbl_date.pack(anchor="w", pady=(2, 6))
        self.mode = tk.StringVar(value="auto")
        self.rb_auto = ttk.Radiobutton(pad, text="", variable=self.mode, value="auto",
                                       command=self._toggle_date)
        self.rb_auto.pack(anchor="w")

        mrow = ttk.Frame(pad, style="Card.TFrame")
        mrow.pack(anchor="w", fill="x", pady=(2, 0))
        self.rb_manual = ttk.Radiobutton(mrow, text="", variable=self.mode, value="manual",
                                         command=self._toggle_date)
        self.rb_manual.pack(side="left")
        self.date_var = tk.StringVar(value="")
        self.date_entry = tk.Entry(mrow, textvariable=self.date_var, width=13,
                                   font=("Helvetica", 13), justify="center",
                                   state="readonly", readonlybackground="white",
                                   relief="solid", bd=1)
        self.date_entry.pack(side="left", padx=(8, 6), ipady=3)
        self.btn_pick = ttk.Button(mrow, text="", style="Pick.TButton",
                                   command=self._open_calendar)
        self.btn_pick.pack(side="left")

        self.btn_gen = ttk.Button(pad, text="", style="Accent.TButton",
                                  command=self._on_generate)
        self.btn_gen.pack(fill="x", pady=(18, 10))

        self.status = tk.Text(pad, height=7, wrap="word", relief="flat",
                              bg="#F3F5F9", fg=INK, font=("Helvetica", 11),
                              padx=12, pady=10)
        self.status.pack(fill="both", expand=True)
        self.status.configure(state="disabled")

        self.btn_open = ttk.Button(pad, text="", style="Ghost.TButton",
                                   command=self._open_folder, state="disabled")
        self.btn_open.pack(fill="x", pady=(10, 0))

        self._toggle_date()

    # ---------- 语言 ----------
    def _apply_lang(self):
        self.root.title(self.t("win"))
        self.lbl_prod.config(text=self.t("product"))
        self.lbl_sub.config(text=self.t("subtitle"))
        self.lbl_lang.config(text=self.t("ui_lang"))
        self.lbl_rate.config(text=self.t("rate", rate=core.VND_PER_RMB))
        self.lbl_outputs.config(text=self.t("outputs"))
        self.lbl_date.config(text=self.t("date_group"))
        self.rb_auto.config(text=self.t("auto"))
        self.rb_manual.config(text=self.t("manual"))
        self.btn_pick.config(text=self.t("pick"))
        self.btn_gen.config(text=self.t("gen"))
        self.btn_open.config(text=self.t("open"))
        if not self.last_path:
            self._set_status(self.t("ready"))

    def _on_lang(self, _=None):
        self.lang = self.lang_var.get()
        self._apply_lang()

    # ---------- 日期 ----------
    def _toggle_date(self):
        # 「选择日期」按钮始终可用；点它会自动切到「指定日期」
        self.btn_pick.configure(state="normal")

    def _open_calendar(self):
        self.mode.set("manual")
        self._toggle_date()
        CalendarPopup(self, self.date_var.get().strip() or None)

    def set_manual_date(self, date_str):
        self.date_var.set(date_str)
        self.mode.set("manual")
        self._toggle_date()

    # ---------- 状态 ----------
    def _set_status(self, text):
        self.status.configure(state="normal")
        self.status.delete("1.0", "end")
        self.status.insert("1.0", text)
        self.status.configure(state="disabled")

    # ---------- 生成 ----------
    def _on_generate(self):
        target = None
        if self.mode.get() == "manual":
            target = self.date_var.get().strip()
            if not target:
                self._set_status("⚠ " + self.t("err_date"))
                return
        self.btn_gen.configure(state="disabled", text=self.t("gening"))
        self.btn_open.configure(state="disabled")
        self._set_status(self.t("fetching"))
        threading.Thread(target=self._worker, args=(target,), daemon=True).start()

    def _worker(self, target):
        try:
            res = core.generate_report(target_date_str=target,
                                       progress=lambda m: self.q.put(("log", m)))
            self.q.put(("done", res))
        except RuntimeError as e:
            self.q.put(("err_code", str(e)))
        except Exception as e:  # noqa
            self.q.put(("err_code", "NET:" + str(e)))

    def _pump(self):
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "done":
                    self._on_done(payload)
                elif kind == "err_code":
                    self._on_err(payload)
        except queue.Empty:
            pass
        self.root.after(100, self._pump)

    def _on_done(self, res):
        d = res["day_date"]
        lines = [
            self.t("rooms", r=" + ".join(res.get("rooms", []))),
            "",
            self.t("daily", d=d.strftime("%Y-%m-%d"), n=res["day_count"], k=res["n_day"]),
            self.t("monthly", ym=d.strftime("%Y-%m"), n=res["month_count"], k=res["n_month"]),
            "",
            self.t("saved", p=res["out_path"]),
        ]
        self._set_status("\n".join(lines))
        self.last_path = res["out_path"]
        self.btn_gen.configure(state="normal", text=self.t("gen"))
        self.btn_open.configure(state="normal")

    def _on_err(self, code):
        mapping = {
            "EMPTY": self.t("err_empty"),
            "NO_TABS": self.t("err_notabs"),
            "NO_PAST_DATA": self.t("err_nopast"),
        }
        if code in mapping:
            msg = mapping[code]
        elif code.startswith("NET:"):
            msg = self.t("err_net")
        else:
            msg = self.t("err", m=code)
        self._set_status("❌ " + msg)
        self.btn_gen.configure(state="normal", text=self.t("gen"))

    def _open_folder(self):
        if not self.last_path:
            return
        folder = os.path.dirname(self.last_path)
        if sys.platform == "darwin":
            subprocess.run(["open", folder])
        elif sys.platform.startswith("win"):
            os.startfile(folder)  # noqa
        else:
            subprocess.run(["xdg-open", folder])


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
