#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生产自检 v2：临时笔记全流程（含清理上一次的残留）"""
import hmac, hashlib, time, json, urllib.request, urllib.error, os, sys

BASE = os.environ.get("SUJIAN_BASE", "/srv/sujian")
sec = open(os.path.join(BASE, ".secret")).read().strip().encode()
USER = list(json.load(open(os.path.join(BASE, "users.json"), encoding="utf-8")).keys())[0]
pl = "%s|%d" % (USER, int(time.time()) + 86400)
tok = pl + "." + hmac.new(sec, pl.encode(), hashlib.sha256).hexdigest()[:32]
URL = "http://127.0.0.1:8013"

def call(path, data=None):
    req = urllib.request.Request(URL + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Cookie": "sujian=" + tok, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, e.read().decode()[:200]

ok = fail = 0
def chk(name, cond, extra=""):
    global ok, fail
    if cond: ok += 1; print("  ✔ %s %s" % (name, extra))
    else: fail += 1; print("  ✘ %s %s" % (name, extra))

def trash_purge_all():
    s, r = call("/api/trash")
    for it in (r.get("items") or []):
        call("/api/purge", {"name": it["name"]})

print("== 清理上次残留（新笔记.md）==")
s, r = call("/api/delete", {"path": "新笔记.md"})
# 上一次跑到一半留下的才需要清；本来就没有 = 干净，不是失败
gone = (s == 200) or (isinstance(r, dict) and "找不到" in str(r.get("error", "")))
chk("删除残留", gone, "本来就没有，跳过" if gone and s != 200 else str(r)[:80])

print("== 完整流程 ==")
s, r = call("/api/create", {"dir": "", "title": "自检临时笔记"})
created = r.get("path") if isinstance(r, dict) else None
chk("创建", s == 200 and created, created or str(r)[:80])

s, r = call("/api/rename", {"path": created, "title": "自检临时笔记改名", "renameFile": True})
renamed = r.get("path") if isinstance(r, dict) else None
chk("改名", s == 200 and renamed, renamed or str(r)[:80])

s, r = call("/api/delete", {"path": renamed})
chk("删除→回收站", s == 200, str(r)[:80])

s, r = call("/api/trash")
items = r.get("items") or []
mine = [it for it in items if "自检临时笔记改名" in it.get("orig", "")]
chk("回收站里有它", len(mine) >= 1, "回收站共 %d 项" % len(items))

if mine:
    s, r = call("/api/restore", {"name": mine[0]["name"]})
    chk("还原", s == 200, str(r)[:80])
    s, r = call("/api/delete", {"path": renamed})
    s, r = call("/api/trash")
    mine2 = [it for it in (r.get("items") or []) if "自检临时笔记改名" in it.get("orig", "")]
    if mine2:
        s, r = call("/api/purge", {"name": mine2[0]["name"]})
        chk("彻底删", s == 200, str(r)[:60])
    else:
        chk("彻底删", False, "回收站里找不到")
        trash_purge_all()
else:
    chk("还原", False, "跳过")
    chk("彻底删", False, "跳过")

print("== 收尾 ==")
trash_purge_all()   # 清空回收站（含上面所有残留）
s, r = call("/api/tree")
def count_docs(n):
    c = 0
    for it in (n or []):
        if it.get("type") == "doc": c += 1
        c += count_docs(it.get("children"))
    return c
tree = r.get("tree")
chk("笔记数回到 9", tree is not None and count_docs(tree) == 9, "实际 %s" % count_docs(tree))
s, r = call("/api/trash")
chk("回收站清空", len(r.get("items") or []) == 0)

print()
print("小结：通过 %d，失败 %d" % (ok, fail))
sys.exit(1 if fail else 0)
