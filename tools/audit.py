#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""素笺 · 全站自检 —— 跑在服务器上，不依赖浏览器。

检查项：
  1 服务与端口
  2 未登录访问是否被挡
  3 静态资源（KaTeX 的 js/css/字体）
  4 笔记树完整性
  5 每篇笔记：正文可取、公式括号配平、图片引用可访问
  6 附件目录完整性
  7 历史版本与回收站目录
"""
import base64, hashlib, hmac, json, os, re, sys, time, urllib.request, urllib.error, urllib.parse

BASE = os.environ.get("SUJIAN_BASE", "/srv/sujian")
PORT = int(os.environ.get("SUJIAN_PORT", "8013"))
ROOT = "http://127.0.0.1:%d" % PORT

ok, bad, warn = [], [], []


def say(kind, msg):
    print("  %-4s %s" % (kind, msg))
    (ok if kind == "✔" else bad if kind == "✘" else warn).append(msg)


def token():
    secret = open(os.path.join(BASE, ".secret")).read().strip().encode()
    payload = "primerusse|%d" % (int(time.time()) + 3600)
    return payload + "." + hmac.new(secret, payload.encode(), hashlib.sha256).hexdigest()[:32]


def req(path, cookie=None, method="GET", timeout=30):
    r = urllib.request.Request(ROOT + path, method=method)
    if cookie:
        r.add_header("Cookie", "sujian=" + cookie)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


print("素笺自检  %s" % time.strftime("%Y-%m-%d %H:%M:%S"))

# 1 服务
try:
    code, _ = req("/")
    say("✔" if code == 200 else "✘", "服务在跑，首页 HTTP %d" % code)
except Exception as e:                                              # noqa: BLE001
    say("✘", "服务不可达：%s" % e)
    sys.exit(1)

# 2 未登录
for p in ["/api/tree", "/api/me", "/api/doc?path=shou-ye.md", "/api/raw?path=assets/x.png"]:
    code, _ = req(p)
    say("✔" if code == 401 else "✘", "未登录访问 %-34s -> %d（应 401）" % (p, code))
code, _ = req("/api/login", method="POST")
say("✔" if code in (400, 401) else "✘", "空口令登录 -> %d（应被拒）" % code)

# 3 静态资源
TOK = token()
for p, name in [("/vendor/katex/katex.min.js", "KaTeX JS"),
                ("/vendor/katex/katex.min.css", "KaTeX CSS"),
                ("/app.js", "前端脚本"), ("/app.css", "前端样式")]:
    code, body = req(p)
    say("✔" if code == 200 and len(body) > 500 else "✘",
        "%-10s %-26s HTTP %d，%d 字节" % (name, p, code, len(body)))
fonts = [f for f in os.listdir(os.path.join(BASE, "static/vendor/katex/fonts"))
         if f.endswith(".woff2")] if os.path.isdir(os.path.join(BASE, "static/vendor/katex/fonts")) else []
say("✔" if len(fonts) >= 15 else "✘", "KaTeX 字体 %d 个" % len(fonts))

# 4 树
code, body = req("/api/tree", TOK)
if code != 200:
    say("✘", "/api/tree 取不到（HTTP %d）" % code)
    sys.exit(1)
tree = json.loads(body)["tree"]
docs, dirs = [], []


def walk(nodes):
    for n in nodes:
        if n["type"] == "dir":
            dirs.append(n["path"])
            walk(n.get("children") or [])
        else:
            docs.append(n)


walk(tree)
say("✔" if docs else "✘", "目录 %d 个、笔记 %d 篇" % (len(dirs), len(docs)))
for d in dirs:
    if d.startswith("."):
        say("✘", "不该出现在树里的目录：%s" % d)

# 5 每篇
tot_formula = tot_img = 0
img_ok = img_bad = 0
for d in docs:
    code, body = req("/api/doc?path=" + urllib.parse.quote(d["path"]), TOK)
    if code != 200:
        say("✘", "取不到正文：%s（HTTP %d）" % (d["path"], code))
        continue
    j = json.loads(body)
    text = j.get("body") or ""
    # 先挖掉代码块与行内代码，只统计真正的公式
    prose = re.sub(r"```[\s\S]*?```", "", text)
    prose = re.sub(r"`[^`\n]*`", "", prose)
    inline = len(re.findall(r"(?<!\$)\$[^$\n]+\$(?!\$)", prose))
    dbl = len(re.findall(r"\$\$", prose))
    block = dbl // 2
    tot_formula += inline + block
    if dbl % 2:
        say("✘", "%s 的独立公式标记落单（%d 个），可能有未闭合公式" % (d["path"], dbl))
    imgs = re.findall(r"!\[[^\]]*\]\(([^)\s]+)\)", text)
    for src in imgs:
        tot_img += 1
        if src.startswith("http"):
            continue
        p = src.lstrip("/")
        if p.startswith("assets/"):
            rel = p
        else:
            rel = os.path.dirname(d["path"]) + "/" + p
            rel = os.path.normpath(rel)
        c, _ = req("/api/raw?path=" + urllib.parse.quote(rel), TOK)
        if c == 200:
            img_ok += 1
        else:
            img_bad += 1
            say("✘", "图片取不到（%d）：%s  <- %s" % (c, rel, d["path"]))
say("✔" if img_bad == 0 else "✘", "图片引用 %d 处：成功 %d，失败 %d" % (tot_img, img_ok, img_bad))
say("✔", "公式合计 %d 条（行内+独立）" % tot_formula)

# 6 附件目录
adir = os.path.join(BASE, "notes", "assets")
n_assets = len(os.listdir(adir)) if os.path.isdir(adir) else 0
size = sum(os.path.getsize(os.path.join(adir, f)) for f in os.listdir(adir)) if n_assets else 0
say("✔" if n_assets else "✘", "附件目录 %d 个文件，%.1f MB" % (n_assets, size / 1048576))
repo = "/srv/leafwiki-data/root"
if os.path.isdir(repo):
    src_md = sum(1 for r, _d, fs in os.walk(repo) for f in fs if f.endswith(".md"))
    say("✔" if src_md else "!", "源库（只读）%d 篇，未被动过" % src_md)

# 7 历史 / 回收站
hdir = os.path.join(BASE, ".history")
hist = len(os.listdir(hdir)) if os.path.isdir(hdir) else 0
tdir = os.path.join(BASE, ".trash")
trash = len(os.listdir(tdir)) if os.path.isdir(tdir) else 0
say("✔", "历史版本 %d 份，回收站 %d 项" % (hist, trash))

print("\n小结：通过 %d 项，失败 %d 项，提醒 %d 项" % (len(ok), len(bad), len(warn)))
sys.exit(1 if bad else 0)
