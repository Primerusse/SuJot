#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""速笺 index.html 结构体检。

为什么需要它：普通的「标签开闭配平」检查**抓不到**这次的真 bug——多写一个
`</div>` 会提前关掉外层容器，标签总数仍然配平，但整个布局被挪位（statusbar
从 .content-col 里掉到 .content 里，跟正文并排，把正文压掉一半宽度）。

本脚本做两件事：
  A. 用带栈的解析器把真实嵌套关系打印出来，逐个关键容器核对子元素归属；
  B. 断言关键元素的「祖先链」必须符合预期。
"""
import re, sys, os

# 默认体检仓库里的 static/index.html；也可以直接给路径：python3 dom-check.py <index.html>
H = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "index.html")

VOID = {"img", "input", "br", "hr", "meta", "link", "source", "col", "area",
        "base", "embed", "param", "track", "wbr"}

TAG = re.compile(r"<(/?)([a-zA-Z][\w-]*)((?:\"[^\"]*\"|'[^']*'|[^>\"'])*?)(/?)>")


def tokenize(html):
    """去掉注释/CDATA 后，逐个吐出 (kind, tag, attrs, selfclose)。"""
    html = re.sub(r"<!--.*?-->", "", html, flags=re.S)
    out = []
    for m in TAG.finditer(html):
        closing, tag, attrs, selfc = m.groups()
        tag = tag.lower()
        if tag in VOID or selfc:
            continue
        out.append((closing, tag, attrs, selfc))
    return out


def class_of(attrs):
    m = re.search(r'class="([^"]*)"', attrs)
    return m.group(1) if m else ""


def id_of(attrs):
    m = re.search(r'id="([^"]*)"', attrs)
    return m.group(1) if m else ""


def parse(html):
    """返回栈轨迹：每条 (depth, tag, cls, id)。栈存 (tag, cls, id)。"""
    stack = []
    trace = []
    for closing, tag, attrs, _ in tokenize(html):
        if not closing:
            stack.append((tag, class_of(attrs), id_of(attrs)))
            trace.append((len(stack), "+", tag, class_of(attrs), id_of(attrs)))
        else:
            if not stack:
                trace.append((0, "!!", tag, "多余闭合（栈空）", ""))
                continue
            if stack[-1][0] != tag:
                trace.append((len(stack), "??", tag, "与栈顶 %s 不符" % stack[-1][0], ""))
                stack.pop()
            else:
                stack.pop()
                trace.append((len(stack), "-", tag, "", ""))
    return trace, stack


ok = fail = 0
def chk(name, cond, extra=""):
    global ok, fail
    if cond: ok += 1; print("  ✔ %s %s" % (name, extra))
    else:    fail += 1; print("  ✘ %s %s" % (name, extra))


def main():
    html = open(H, encoding="utf-8").read()
    trace, leftover = parse(html)

    print("== A. 嵌套轨迹（只列关键容器附近）==")
    for depth, kind, tag, cls, eid in trace:
        if cls in ("content", "content-col", "statusbar", "outline-panel",
                   "split", "sidebar", "toolbar") or eid in ("split", "preview", "gutter", "editor"):
            label = "%s%s%s" % (tag,
                                "." + cls if cls else "",
                                "#" + eid if eid else "")
            print("     %s%s %s" % ("  " * depth, kind, label))

    print()
    print("== B. 关键归属断言 ==")
    real = [t for t in leftover if t[0] not in ("html", "body")]
    chk("无未闭合标签（html/body 除外）", not real, "残留: %s" % (real[:3] if real else "无"))

    # statusbar 必须在 .content-col 内，而不是 .content 里与正文并排
    m_status = re.search(r'<div class="statusbar">', html)
    chk("statusbar 存在", m_status is not None)
    if m_status:
        before = html[:m_status.start()]
        # 数 content-col 与 content 的开闭差
        n_col = len(re.findall(r'<div class="content-col">', before)) - len(
            re.findall(r'</div>', before))  # 仅示意，下面用栈精确定位
        # 用栈精确定位 statusbar 的直接父级
        stack = []
        parent = None
        for m in TAG.finditer(re.sub(r"<!--.*?-->", "", html, flags=re.S)):
            t = m.group(2).lower()
            if t in VOID or m.group(4):
                continue
            if not m.group(1):
                if 'class="statusbar"' in m.group(3):
                    parent = stack[-1] if stack else None
                    break
                stack.append((t, class_of(m.group(3))))
            else:
                if stack and stack[-1][0] == t:
                    stack.pop()
        chk("statusbar 的父级是 .content-col",
            parent is not None and parent[1] == "content-col",
            "实际父级: %s" % (parent[1] if parent else "未知"))

    # 反向断言：.content 直接子元素里不能出现 .statusbar（出现即并排，是本 bug 的特征）
    stack2 = []
    content_kids = []
    in_content = False
    for m2 in TAG.finditer(re.sub(r"<!--.*?-->", "", html, flags=re.S)):
        t2 = m2.group(2).lower()
        if t2 in VOID or m2.group(4):
            continue
        if not m2.group(1):
            c2 = class_of(m2.group(3))
            if c2 == "content":
                in_content = True
                continue
            if in_content and len(stack2) == 1:
                content_kids.append(c2 or t2)
            stack2.append((t2, c2))
        else:
            if stack2 and stack2[-1][0] == t2:
                stack2.pop()
                if in_content and not stack2:
                    in_content = False
    chk(".content 直接子元素里没有 statusbar",
        "statusbar" not in content_kids, "实际子元素: %s" % content_kids)

    # 大纲栏与正文栏平级（.body 的子元素），靠 .body 的 gap 分隔。
    # 一旦被塞回 .content 里，两栏又会贴死（用户明确要求像文件栏那样分离）
    in_main = re.search(r"<main class=\"content\">(?:(?!</main>).)*outline-panel", html, re.S)
    chk("outline-panel 不在 .content 里", in_main is None)
    chk("outline-panel 紧跟 </main> 之后（.body 的子元素）",
        re.search(r"</main>(?:\s*<!--.*?-->)?\s*\n\s*<aside class=\"outline-panel\"", html, re.S) is not None)

    # content-col 里应该正好是 toolbar + split + statusbar 三个子元素
    seg = re.search(r'<div class="content-col">(.*?)\n\s*</div>\s*\n\s*<div class="statusbar">', html, re.S)
    chk("content-col 内在 statusbar 之前有内容", seg is not None)

    # JS 里 $('#xxx') 引用的每个 id 都必须在 index.html 里真的存在。
    # 否则 $() 返回 null，一旦在 boot() 里被取属性就会静默中断整个启动
    # （第七轮删掉 #uname 时踩过：树不加载、页面看似「空」但无报错）
    js = ""
    jsp = os.path.join(os.path.dirname(os.path.abspath(H)), "app.js")
    if os.path.exists(jsp):
        js = open(jsp, encoding="utf-8").read()
        have = set(re.findall(r'id="([^"]+)"', html))
        want = sorted(set(re.findall(r"""\$\(\s*['"]#([A-Za-z][\w-]*)['"]\s*\)""", js))
                      | set(re.findall(r"""getElementById\(\s*['"]([A-Za-z][\w-]*)['"]""", js)))
        miss = [i for i in want if i not in have]
        # font-cjk-link 是运行时才插进去的 <link>（选中文楷时才有），不在 index.html 里
        RUNTIME_IDS = {"font-cjk-link"}
        miss = [i for i in miss if i not in RUNTIME_IDS]
        chk("JS 引用的 id 在 HTML 里都存在", not miss, "缺失: %s" % ", ".join(miss))

    # 逐标签配平：这类「少一个 </div>」会让浏览器把后面整段结构吃掉 → 页面打不开
    for t in ("div", "button", "span", "section", "aside", "nav",
              "label", "form", "p", "table", "tbody", "tr"):
        o = len(re.findall(r"<%s[\s>]" % t, html))
        c = len(re.findall(r"</%s>" % t, html))
        chk("<%s> 配平" % t, o == c, "开 %d 闭 %d" % (o, c))

    print()
    print("小结：通过 %d，失败 %d" % (ok, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
