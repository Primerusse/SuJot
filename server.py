#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
速笺 / Sujian —— 极简本地笔记服务（纯标准库）

设计原则
  · 一条进程、一个数据目录、零依赖（不用数据库、不用 Node）
  · 笔记就是磁盘上的 Markdown 文件，所见即所得：随时能用别的编辑器打开
  · 只绑 127.0.0.1，对外由 nginx 反代 + HTTPS；单密码登录，签名 Cookie
  · 每次保存都留历史版本（.history/），删笔记先进回收站（.trash/）
"""
import base64
import glob
import gzip
import hashlib
import hmac
import html
import json
import mimetypes
import os
import re
import secrets
import shutil
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── 配置 ────────────────────────────────────────────────────────────────
# 项目级参数集中放 _config.json（就在本文件旁边，随仓库分发）。
# 优先级：环境变量 > _config.json > 代码里的默认值。
# 这个文件可以整个删掉，删了就全走默认值；它不是运行数据，改它不碰你的笔记。
CONFIGFILE = os.environ.get("SUJIAN_CONFIG") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "_config.json")


def _strip_json_comments(text):
    """把 JSON 里的 // 注释去掉（字符串里的 // 不动，比如 http://）。

    这样 _config.json 可以写得像配置文件，而不是一坨引号数组。"""
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j < 0 else j            # 保留换行，行号不乱
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _load_config(path=None):
    path = path or CONFIGFILE
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.loads(_strip_json_comments(f.read()))
    except FileNotFoundError:
        return {}
    except Exception as e:
        print("警告：配置文件 %s 读不了（%s），本次全部用默认值" % (path, e), flush=True)
        return {}
    if not isinstance(raw, dict):
        print("警告：配置文件 %s 的顶层必须是对象，已忽略" % path, flush=True)
        return {}
    return {k: v for k, v in raw.items() if not str(k).startswith("_")}


CFG = _load_config()


def _cfg(key, default=None):
    """取 _config.json 里的值；空字符串算「没设」。"""
    v = CFG.get(key, default)
    return default if v in (None, "") else v


def _env_cfg(envname, key, default=None):
    """环境变量优先，其次 _config.json，最后默认值。"""
    v = os.environ.get(envname)
    if v not in (None, ""):
        return v
    return _cfg(key, default)


def _pick_base():
    """数据目录（笔记、历史、回收站、账号都在这里）。

    优先环境变量 SUJIAN_BASE，其次 _config.json 的 data_dir；都没设时：
    服务器上按约定用 /srv/sujian，本地（Windows / macOS / 非 root）退回
    server.py 旁边的 data/ —— 这样克隆下来直接 `python server.py` 就能跑，
    不必先配环境变量。
    """
    env = _env_cfg("SUJIAN_BASE", "data_dir")
    if env:
        return env
    if os.name != "nt" and os.path.isdir("/srv") and os.access("/srv", os.W_OK):
        return "/srv/sujian"
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


BASE = _pick_base()
NOTES = os.path.join(BASE, "notes")
# 前端静态文件：优先 SUJIAN_STATIC / _config.json 的 static_dir，其次数据目录下的 static/，
# 最后退回 server.py 同级的 static/ —— 这样「克隆下来直接 python3 server.py」也能跑，
# 不必先把静态目录拷进 SUJIAN_BASE（README 的快速开始就是按这个来的）。
def _pick_static():
    env = _env_cfg("SUJIAN_STATIC", "static_dir")
    if env:
        return env
    near_base = os.path.join(BASE, "static")
    if os.path.isdir(near_base):
        return near_base
    near_code = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
    if os.path.isdir(near_code):
        return near_code
    return near_base


STATIC = _pick_static()
HISTORY = os.path.join(BASE, ".history")
TRASH = os.path.join(BASE, ".trash")
USERSFILE = os.path.join(BASE, "users.json")
SITEFILE = os.path.join(BASE, "site.json")
PASSFILE = _env_cfg("SUJIAN_PASSFILE", "pass_file") or "/etc/sujian/pass"
SECRETFILE = os.path.join(BASE, ".secret")
SEEDDIR = _env_cfg("SUJIAN_SEED", "seed_dir") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "assets")
HOST = str(_env_cfg("SUJIAN_HOST", "host", "127.0.0.1"))
PORT = int(_env_cfg("SUJIAN_PORT", "port", 8013))
COOKIE = str(_cfg("cookie_name", "sujian"))
SESSION_DAYS = int(_env_cfg("SUJIAN_SESSION_DAYS", "session_days", 30))
MAX_BODY = int(float(_env_cfg("SUJIAN_MAX_BODY_MB", "max_body_mb", 8)) * 1024 * 1024)
KEEP_HISTORY = int(_env_cfg("SUJIAN_KEEP_HISTORY", "keep_history", 30))
GZIP_MIN = int(_cfg("gzip_min_bytes", 1024))            # 超过这个字节数的文本类才 gzip
CACHE_DAYS = int(_cfg("cache_days", 365))               # 带 ?v= 的静态件缓存天数
OPEN_BROWSER = bool(_cfg("open_browser", True))         # 本机启动时顺手开浏览器

# 登录 / 注册的失败次数与锁定时长（分钟级暴力破解防护）
LOGIN_ATTEMPTS = int(_cfg("login_attempts", 5))
LOGIN_LOCK = int(_cfg("login_lock_seconds", 30))
# 三类文件的上限：头像 / 站点图标 / 正文插图
AVATAR_MAX = int(float(_cfg("avatar_max_mb", 2)) * 1048576)
LOGO_MAX = int(float(_cfg("logo_max_mb", 4)) * 1048576)
UPLOAD_MAX = int(float(_cfg("upload_max_mb", 12)) * 1048576)
# 一篇笔记的历史列表最多列多少条（历史文件本身按 keep_history 清理）
HISTORY_LIST_MAX = int(_cfg("history_list_max", 30))

def _read_version():
    """版本号只认 VERSION 文件（没有就退回内置默认），避免多处各写一个。"""
    for p in (os.path.join(BASE, "VERSION"), os.path.join(os.path.dirname(os.path.abspath(__file__)), "VERSION")):
        try:
            with open(p, "r", encoding="utf-8") as f:
                v = f.read().strip().splitlines()[0].strip()
            if v:
                return v
        except Exception:
            continue
    return "0.1.0"

APP_VERSION = _read_version()

for d in (NOTES, HISTORY, TRASH):
    os.makedirs(d, exist_ok=True)


def _read(path, default=""):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return default


def _secret():
    s = _read(SECRETFILE)
    if not s:
        s = secrets.token_hex(32)
        with open(SECRETFILE, "w", encoding="utf-8") as f:
            f.write(s)
        os.chmod(SECRETFILE, 0o600)
    return s.encode()


SECRET = _secret()
LEGACY_PASSWORD = os.environ.get("SUJIAN_PASSWORD") or _read(PASSFILE)


# ── 账号 ────────────────────────────────────────────────────────────────
def _hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(8)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt), 120_000)
    return salt, dk.hex()


SITE_KEYS = ("brand", "tabTitle", "logoText")

def load_site():
    try:
        with open(SITEFILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        d = d if isinstance(d, dict) else {}
    except Exception:
        d = {}
    # _config.json 里的 site 只作「初值」：site.json 里已经有的一律以 site.json 为准
    defaults = CFG.get("site")
    if isinstance(defaults, dict):
        for k, v in defaults.items():
            if k not in d and isinstance(v, str):
                d[k] = v
    return d

def save_site(d):
    tmp = SITEFILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, SITEFILE)

def _walk_size(root):
    """数一数目录里有多少文件、共多少字节（目录不存在就返回 0）"""
    n = b = 0
    for dp, _dn, fn in os.walk(root):
        for f in fn:
            n += 1
            try:
                b += os.path.getsize(os.path.join(dp, f))
            except OSError:
                pass
    return n, b

def compute_stats():
    """设置 → 数据 的存储概览（只读）"""
    docs = glob.glob(os.path.join(NOTES, "**", "*.md"), recursive=True)
    nb = 0
    for f in docs:
        try:
            nb += os.path.getsize(f)
        except OSError:
            pass
    folders = sum(1 for dp, _dn, _fn in os.walk(NOTES) if dp != NOTES)
    assets, abytes = _walk_size(os.path.join(NOTES, "assets"))
    hist, hbytes = _walk_size(HISTORY)
    trash, tbytes = _walk_size(TRASH)
    return {"notes": len(docs), "folders": folders, "notesBytes": nb,
            "assets": assets, "assetsBytes": abytes,
            "history": hist, "historyBytes": hbytes,
            "trash": trash, "trashBytes": tbytes, "version": APP_VERSION}

def load_users():
    try:
        with open(USERSFILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_users(users):
    tmp = USERSFILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(users, f, ensure_ascii=False, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, USERSFILE)


def add_user(username, password, display="", must_change=False):
    users = load_users()
    salt, h = _hash_pw(password)
    users[username] = {"salt": salt, "hash": h, "display": display or username,
                       "created": time.strftime("%Y-%m-%d %H:%M:%S")}
    if must_change:
        users[username]["must_change"] = True
    save_users(users)
    return users[username]


def check_user(username, password):
    u = load_users().get(username)
    if not u:
        return None
    _salt, h = _hash_pw(password, u.get("salt"))
    if hmac.compare_digest(h, u.get("hash", "")):
        return u
    return None


DEFAULT_USER = str(_cfg("default_user", "admin"))
DEFAULT_PW = "admin"


def bootstrap_users():
    """首次启动建立管理员账号。

    默认 admin / admin，并打上 must_change：登录后必须先把昵称和密码改掉，
    之后才算真正可用（写入接口在此之前一律 403）。
    老部署如果还留着明文口令文件（/etc/sujian/pass 或 SUJIAN_PASSWORD），
    就沿用它当密码、且不强制改——这样升级不会把人锁在门外。
    明文口令文件只是兼容，不是必需品；新部署不必创建它。
    """
    if load_users():
        return
    legacy = (LEGACY_PASSWORD or "").strip()
    if legacy:
        add_user(DEFAULT_USER, legacy, DEFAULT_USER, must_change=False)
        print("已建立初始账号 %s（密码沿用 %s 里的旧密码；建议尽快改掉并删除该文件）"
              % (DEFAULT_USER, PASSFILE), flush=True)
    else:
        add_user(DEFAULT_USER, DEFAULT_PW, DEFAULT_USER, must_change=True)
        print("已建立初始账号 %s —— 初始口令与账号名相同，首次登录后必须修改昵称和密码"
              % DEFAULT_USER, flush=True)


def seed_notes():
    """首次部署：笔记库还是空的时候，把 assets/ 里的样板笔记铺进去。

    样板笔记就放在仓库根的 assets/ 下：`*.md` 落到笔记根目录，
    `images/` 里的配图落到 `<NOTES>/assets/`（笔记正文里写的是
    `/assets/xxx.png`，落盘位置必须与之一致，否则首屏图会裂）。

    只在「一篇 .md 都没有」时动手，任何已有内容都不会被覆盖或删除。
    """
    try:
        if not os.path.isdir(SEEDDIR) or not os.path.isdir(NOTES):
            return 0
        for _dp, _dn, _fn in os.walk(NOTES):
            if any(f.endswith(".md") for f in _fn):
                return 0
        n = 0
        for dp, _dn, fns in os.walk(SEEDDIR):
            rel = os.path.relpath(dp, SEEDDIR)
            if rel == ".":
                dst = NOTES
            elif rel == "images":
                dst = os.path.join(NOTES, "assets")
            else:
                dst = os.path.join(NOTES, rel)
            os.makedirs(dst, exist_ok=True)
            for f in fns:
                if f.startswith("."):
                    continue
                shutil.copy2(os.path.join(dp, f), os.path.join(dst, f))
                if f.endswith(".md"):
                    n += 1
        if n:
            print("已铺入 %d 篇样板笔记（来自 %s）" % (n, SEEDDIR), flush=True)
        return n
    except Exception as e:                      # 播种失败不能挡住服务启动
        print("样板笔记没铺上：%s" % e, flush=True)
        return 0


bootstrap_users()

_LOCK = threading.Lock()
_ATTEMPTS = {}          # ip -> [次数, 解禁时间]
_LOGS = []              # 最近的登录记录（用户名/时间/结果），最多留 200 条


# ── 工具 ────────────────────────────────────────────────────────────────
FM_RE = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?", re.S)


def split_front(text):
    """拆出 YAML 头与正文；头原样保留（改标题时只动一行）"""
    m = FM_RE.match(text or "")
    if not m:
        return "", text or ""
    return m.group(0), (text or "")[m.end():]


def parse_title(front, body, fallback):
    m = re.search(r"^title:\s*(.+?)\s*$", front or "", re.M)
    if m:
        return m.group(1).strip().strip('"\'')
    m = re.search(r"^#\s+(.+?)\s*$", body or "", re.M)
    if m:
        return m.group(1).strip()
    return fallback


def safe_path(rel):
    """把请求路径收敛到 NOTES 之内，越界抛错"""
    rel = urllib.parse.unquote(rel or "").replace("\\", "/").lstrip("/")
    p = os.path.realpath(os.path.join(NOTES, rel))
    if p != NOTES and not p.startswith(NOTES + os.sep):
        raise ValueError("越界路径")
    return p


def rel_of(path):
    return os.path.relpath(path, NOTES).replace(os.sep, "/")


ORDERFILE = os.path.join(BASE, "order.json")


def load_order():
    """用户拖拽出来的顺序：{"相对目录": ["名字1", "名字2", ...]}"""
    try:
        with open(ORDERFILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_order(d):
    tmp = ORDERFILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, ORDERFILE)


def order_key(order, rel_dir, name):
    """自定义顺序里的序号；没有就按自然序排在后面"""
    seq = order.get(rel_dir) or []
    try:
        return (0, seq.index(name))
    except ValueError:
        return (1, natural(name))


SKIP_DIRS = {".history", ".trash", ".git", ".", "assets", "attachments"}
SKIP_FILES = {"index.md", "index.txt"}      # LeafWiki 留下的目录元数据页


def natural(name):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def build_tree(root=NOTES, order=None):
    entries = []
    if order is None:
        order = load_order()
    rel_dir = "" if root == NOTES else rel_of(root)
    try:
        names = sorted(os.listdir(root), key=lambda n: order_key(order, rel_dir, n))
    except OSError:
        return entries
    dirs, files = [], []
    for n in names:
        if n.startswith(".") or n in SKIP_DIRS or n in SKIP_FILES:
            continue
        full = os.path.join(root, n)
        if os.path.isdir(full):
            kids = build_tree(full, order)
            dirs.append({"name": n, "path": rel_of(full), "type": "dir",
                         "count": count_notes(full), "children": kids})
        elif n.lower().endswith((".md", ".markdown", ".txt")):
            files.append({"name": n, "path": rel_of(full), "type": "doc",
                          "title": title_of(full),
                          "size": os.path.getsize(full),
                          "mtime": int(os.path.getmtime(full))})
    return dirs + files


def count_notes(d):
    n = 0
    for _root, _dirs, files in os.walk(d):
        n += sum(1 for f in files if f.lower().endswith((".md", ".markdown", ".txt")))
    return n


_TITLE_CACHE = {}


def title_of(path):
    try:
        st = os.stat(path)
        key = (path, st.st_mtime, st.st_size)
        if key in _TITLE_CACHE:
            return _TITLE_CACHE[key]
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            head = f.read(4000)
        front, body = split_front(head)
        t = parse_title(front, body, os.path.splitext(os.path.basename(path))[0])
        _TITLE_CACHE.clear()          # 缓存不设上限也没关系，条目少
        _TITLE_CACHE[key] = t
        return t
    except OSError:
        return os.path.splitext(os.path.basename(path))[0]


def backup(path):
    """保存前留一份历史版本"""
    if not os.path.exists(path):
        return
    rel = rel_of(path)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    dest = os.path.join(HISTORY, rel.replace("/", "__") + "." + stamp + ".md")
    try:
        shutil.copy2(path, dest)
        same = sorted(f for f in os.listdir(HISTORY) if f.startswith(rel.replace("/", "__") + "."))
        for old in same[:-KEEP_HISTORY]:
            os.remove(os.path.join(HISTORY, old))
    except OSError:
        pass


def _mac(wire):
    return hmac.new(SECRET, wire.encode(), hashlib.sha256).hexdigest()[:32]


def sign(payload):
    """签名。HTTP 头只能是 ASCII，而用户名允许中文，所以载荷在传输时做百分号编码；
       MAC 算在编码后的形式上，verify() 再还原（老的纯 ASCII 令牌照样验得过）。"""
    wire = urllib.parse.quote(payload, safe="")
    return wire + "." + _mac(wire)


def verify(token):
    if not token or "." not in token:
        return None
    wire, _, mac = token.rpartition(".")
    if not hmac.compare_digest(_mac(wire), mac):
        return None
    payload = urllib.parse.unquote(wire)
    user, _, exp = payload.rpartition("|")
    if not user:
        return None
    try:
        return user if int(exp) > time.time() else None
    except ValueError:
        return None


def search(query, limit=60, field="both"):
    q = (query or "").strip()
    if not q:
        return []
    terms = [t for t in re.split(r"\s+", q) if t][:5]
    low = [t.lower() for t in terms]
    out = []
    for root, _dirs, files in os.walk(NOTES):
        for fn in files:
            if not fn.lower().endswith((".md", ".markdown", ".txt")):
                continue
            full = os.path.join(root, fn)
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except OSError:
                continue
            front, body = split_front(text)
            hay = body.lower()
            score = 0
            hits = []
            title = title_of(full).lower()
            for i, t in enumerate(low):
                if field in ("both", "title") and t in title:
                    score += 12
                if field in ("both", "body"):
                    c = hay.count(t)
                    if c:
                        score += min(c, 20)
                # 范围不匹配的字直接判不中
                if field == "title" and t not in title:
                    score = -10 ** 6
                    break
                if field == "body" and t not in hay:
                    score = -10 ** 6
                    break
                if field == "both" and t not in hay and t not in title:
                    score = -10 ** 6
                    break
            if score <= 0:
                continue
            for t in low:
                if field == "title":
                    break
                for m in re.finditer(re.escape(t), hay):
                    s = max(0, m.start() - 60)
                    frag = body[s:m.start() + 120].replace("\n", " ")
                    hits.append(frag)
                    break
            out.append({"path": rel_of(full), "title": title_of(full),
                        "score": score, "snippet": hits[:3], "mtime": int(os.path.getmtime(full))})
    out.sort(key=lambda x: (-x["score"], -x["mtime"]))
    return out[:limit]


def plain(text):
    t = re.sub(r"```.*?```", " ", text, flags=re.S)
    t = re.sub(r"\$[^$]*\$", " ", t)
    t = re.sub(r"[#>*`_\-\[\]()!|~]", " ", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


# ── 请求处理 ────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version = "Sujian/1.0"
    protocol_version = "HTTP/1.1"

    # —— 基础 ——
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200, extra=None):
        self._send(code, obj, "application/json; charset=utf-8", extra)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("请求体过大")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _cookies(self):
        raw = self.headers.get("Cookie") or ""
        out = {}
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                out[k.strip()] = v.strip()
        return out

    def _authed(self):
        self.user = verify(self._cookies().get(COOKIE, ""))
        return self.user

    # —— 路由 ——
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p, qs = u.path, urllib.parse.parse_qs(u.query)
        if p.startswith("/api/"):
            if not self._authed():
                return self._json({"error": "未登录"}, 401)
            return self._api_get(p, qs)
        return self._static(p, u.query)

    def do_HEAD(self):
        return self.do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/login":
            return self._login()
        if u.path == "/api/register":
            return self._register()
        if u.path == "/api/setup-state":
            return self._json({"needs_setup": not load_users()}, 200)
        if not self._authed():
            return self._json({"error": "未登录"}, 401)
        try:
            data = self._read_body()
        except ValueError as e:
            return self._json({"error": str(e)}, 413)
        return self._api_post(u.path, data)

    def do_PUT(self):
        return self.do_POST()

    def do_DELETE(self):
        return self.do_POST()

    # —— 登录 ——
    def _login(self):
        ip = self.client_address[0]
        cnt, until = _ATTEMPTS.get(ip, [0, 0])
        if cnt >= LOGIN_ATTEMPTS and time.time() < until:
            return self._json({"error": "尝试过多，请 %d 秒后再试" % int(until - time.time())}, 429)
        data = self._read_body()
        name = str(data.get("username") or "").strip() or "primerusse"
        pw = str(data.get("password") or "")
        remember = bool(data.get("remember", True))
        u = check_user(name, pw) if pw else None
        if u:
            _ATTEMPTS.pop(ip, None)
            days = 30 if remember else 1
            tok = sign("%s|%d" % (name, int(time.time()) + days * 86400))
            _LOGS.append((time.strftime("%Y-%m-%d %H:%M:%S"), name, ip, "登录成功"))
            return self._json({"ok": True, "user": name, "display": name}, 200, {
                "Set-Cookie": "%s=%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Lax"
                              % (COOKIE, tok, days * 86400)})
        _ATTEMPTS[ip] = [cnt + 1, time.time() + LOGIN_LOCK]
        _LOGS.append((time.strftime("%Y-%m-%d %H:%M:%S"), name, ip, "密码不对"))
        time.sleep(0.6)
        return self._json({"error": "用户名或密码不对"}, 401)

    # —— 用户头像 ——
    def _api_avatar(self, data):
        b64 = str(data.get("data") or "")
        if "," in b64[:80] and b64[:40].lower().startswith("data:"):
            b64 = b64.split(",", 1)[1]
        try:
            blob = base64.b64decode(b64, validate=False)
        except Exception:
            return self._json({"error": "图片数据不合法"}, 400)
        if not blob:
            return self._json({"error": "空文件"}, 400)
        if len(blob) > LOGO_MAX:
            return self._json({"error": "头像太大了（上限 4MB）"}, 413)
        ext = ".png"
        if blob[:3] == b"\xff\xd8\xff": ext = ".jpg"
        elif blob[:4] == b"RIFF" and blob[8:12] == b"WEBP": ext = ".webp"
        elif blob[:4] == b"<svg" or blob[:5].lstrip()[:5] == b"<?xml":
            if b"<svg" in blob[:400]: ext = ".svg"
        for old in glob.glob(os.path.join(BASE, ".avatar.*")):
            try: os.remove(old)
            except OSError: pass
        with open(os.path.join(BASE, ".avatar" + ext), "wb") as f:
            f.write(blob)
        return self._json({"ok": True, "url": "/api/avatar?v=" + str(int(time.time()))})

    def _api_logo(self, data):
        b64 = str(data.get("data") or "")
        if "," in b64[:80] and b64[:40].lower().startswith("data:"):
            b64 = b64.split(",", 1)[1]
        try:
            blob = base64.b64decode(b64, validate=False)
        except Exception:
            return self._json({"error": "图片数据不合法"}, 400)
        if not blob:
            return self._json({"error": "空文件"}, 400)
        if len(blob) > AVATAR_MAX:
            return self._json({"error": "Logo 太大了（上限 2MB）"}, 413)
        ext = ".png"
        if blob[:3] == b"\xff\xd8\xff": ext = ".jpg"
        elif blob[:4] == b"RIFF" and blob[8:12] == b"WEBP": ext = ".webp"
        elif b"<svg" in blob[:400]: ext = ".svg"
        for old in glob.glob(os.path.join(BASE, ".logo.*")):
            try: os.remove(old)
            except OSError: pass
        with open(os.path.join(BASE, ".logo" + ext), "wb") as f:
            f.write(blob)
        return self._json({"ok": True, "url": "/api/logo?v=" + str(int(time.time()))})

    # —— 首次部署：注册管理员 ——
    def _register(self):
        """只在「一个用户都没有」时开放；注册完就永久关闭。
        这是给项目刚部署时用的，不是访客自助注册入口。"""
        if load_users():
            return self._json({"error": "已经初始化过了，注册入口已关闭"}, 403)
        ip = self.client_address[0]
        cnt, until = _ATTEMPTS.get("reg:" + ip, [0, 0])
        if cnt >= LOGIN_ATTEMPTS and time.time() < until:
            return self._json({"error": "尝试过多，请 %d 秒后再试" % int(until - time.time())}, 429)
        try:
            data = self._read_body()
        except ValueError as e:
            return self._json({"error": str(e)}, 413)
        name = str(data.get("username") or "").strip()
        pw = str(data.get("password") or "")
        pw2 = str(data.get("password2") or "")
        disp = name                      # 显示名就是用户名，不再单独设置
        if not re.match(r"^[\w.\-]{2,32}$", name):
            _ATTEMPTS["reg:" + ip] = [cnt + 1, time.time() + LOGIN_LOCK]
            return self._json({"error": "用户名要 2-32 位，中英文数字或 _ . -，不能有空格"}, 400)
        if len(pw) < 8:
            _ATTEMPTS["reg:" + ip] = [cnt + 1, time.time() + LOGIN_LOCK]
            return self._json({"error": "密码至少 8 位"}, 400)
        if pw != pw2:
            return self._json({"error": "两次输入的密码不一致"}, 400)
        if load_users():          # 并发下再确认一次
            return self._json({"error": "已经初始化过了"}, 403)
        add_user(name, pw, disp)
        _LOGS.append((time.strftime("%Y-%m-%d %H:%M:%S"), name, ip, "注册管理员"))
        # 注册完直接给登录态，省得再输一次
        tok = sign("%s|%d" % (name, int(time.time()) + 30 * 86400))
        return self._json({"ok": True, "user": name, "display": disp}, 200, {
            "Set-Cookie": "%s=%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Lax"
                          % (COOKIE, tok, 30 * 86400)})

    # 首次登录必须先改用户名+密码：没改完之前，笔记相关的写接口一律拒绝
    WRITE_PATHS = ("/api/save", "/api/create", "/api/rename", "/api/delete", "/api/restore",
                   "/api/purge", "/api/trash/empty", "/api/move", "/api/reorder",
                   "/api/mkdir", "/api/upload")

    def _must_change(self):
        return bool((load_users().get(self.user) or {}).get("must_change"))

    # —— GET 接口 ——
    def _api_get(self, p, qs):
        if p == "/api/logo":
            for f in sorted(glob.glob(os.path.join(BASE, ".logo.*"))):
                ext = os.path.splitext(f)[1].lower()
                ctype = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                         ".webp": "image/webp", ".svg": "image/svg+xml"}.get(ext, "image/png")
                try:
                    with open(f, "rb") as fh: blob = fh.read()
                except OSError:
                    continue
                return self._send(200, blob, ctype, {"Cache-Control": "public, max-age=600"})
            # 没自定义就返回内置的
            for nm, ct in (("sujot-logo.png", "image/png"),):
                pth = os.path.join(STATIC, nm)
                if os.path.exists(pth):
                    with open(pth, "rb") as fh:
                        return self._send(200, fh.read(), ct, {"Cache-Control": "public, max-age=600"})
            return self._json({"error": "没有 logo"}, 404)
        if p == "/api/avatar":
            for f in sorted(glob.glob(os.path.join(BASE, ".avatar.*"))):
                ext = os.path.splitext(f)[1].lower()
                ctype = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                         ".webp": "image/webp", ".svg": "image/svg+xml"}.get(ext, "image/png")
                try:
                    with open(f, "rb") as fh: blob = fh.read()
                except OSError:
                    continue
                return self._send(200, blob, ctype, {"Cache-Control": "private, max-age=3600"})
            return self._json({"error": "还没设置头像"}, 404)
        if p == "/api/site":
            site = dict(load_site())
            site["version"] = APP_VERSION          # 只读下发，不写回 site.json
            return self._json({"site": site})
        if p == "/api/stats":
            return self._json(compute_stats())
        if p == "/api/me":
            u = load_users().get(self.user) or {}
            return self._json({"authenticated": True, "user": self.user,
                               "display": self.user,
                               "must_change": bool(u.get("must_change")),
                               "notes": rel_of(NOTES)})
        if p == "/api/tree":
            return self._json({"tree": build_tree()})
        if p == "/api/doc":
            rel = (qs.get("path") or [""])[0]
            try:
                full = safe_path(rel)
            except ValueError:
                return self._json({"error": "非法路径"}, 400)
            if not os.path.isfile(full):
                return self._json({"error": "找不到该笔记"}, 404)
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            front, body = split_front(text)
            st = os.stat(full)
            return self._json({"path": rel_of(full), "title": title_of(full),
                               "front": front, "body": body,
                               "mtime": int(st.st_mtime), "size": st.st_size,
                               "words": len(re.sub(r"\s", "", plain(body)))})
        if p == "/api/search":
            field = (qs.get("field") or ["both"])[0]
            if field not in ("both", "title", "body"):
                field = "both"
            return self._json({"results": search((qs.get("q") or [""])[0], field=field)})
        if p == "/api/raw":
            rel = (qs.get("path") or [""])[0]
            try:
                full = safe_path(rel)
            except ValueError:
                return self._json({"error": "非法路径"}, 400)
            if not os.path.isfile(full):
                return self._json({"error": "找不到文件"}, 404)
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            with open(full, "rb") as f:
                blob = f.read()
            return self._send(200, blob, ctype, {"Cache-Control": "private, max-age=3600"})
        if p == "/api/trash":
            items = []
            for fn in sorted(os.listdir(TRASH), reverse=True):
                full = os.path.join(TRASH, fn)
                st = os.stat(full)
                orig = (fn.split("__", 1)[-1] if "__" in fn else fn).replace("|", "/")
                items.append({"name": fn, "orig": orig,
                              "size": st.st_size, "mtime": int(st.st_mtime),
                              "is_dir": os.path.isdir(full)})
            return self._json({"items": items})
        if p == "/api/history":
            rel = (qs.get("path") or [""])[0]
            key = rel.replace("/", "__") + "."
            items = []
            for fn in sorted(os.listdir(HISTORY), reverse=True):
                if fn.startswith(key):
                    items.append({"name": fn, "stamp": fn.split(".")[-2],
                                  "size": os.path.getsize(os.path.join(HISTORY, fn))})
            return self._json({"items": items[:HISTORY_LIST_MAX]})
        return self._json({"error": "未知接口"}, 404)

    # —— 写接口 ——
    def _api_post(self, p, data):
        if p in self.WRITE_PATHS and self._must_change():
            return self._json({"error": "初始账号：请先在「用户设置」里改掉昵称和密码"}, 403)
        if p == "/api/logo":
            for f in sorted(glob.glob(os.path.join(BASE, ".logo.*"))):
                ext = os.path.splitext(f)[1].lower()
                ctype = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                         ".webp": "image/webp", ".svg": "image/svg+xml"}.get(ext, "image/png")
                try:
                    with open(f, "rb") as fh: blob = fh.read()
                except OSError:
                    continue
                return self._send(200, blob, ctype, {"Cache-Control": "public, max-age=600"})
            # 没自定义就返回内置的
            for nm, ct in (("sujot-logo.png", "image/png"),):
                pth = os.path.join(STATIC, nm)
                if os.path.exists(pth):
                    with open(pth, "rb") as fh:
                        return self._send(200, fh.read(), ct, {"Cache-Control": "public, max-age=600"})
            return self._json({"error": "没有 logo"}, 404)
        if p == "/api/avatar":
            return self._api_avatar(data)
        if p == "/api/upload-logo":
            return self._api_logo(data)
        if p == "/api/avatar/clear":
            for old in glob.glob(os.path.join(BASE, ".avatar.*")):
                try: os.remove(old)
                except OSError: pass
            return self._json({"ok": True})
        if p == "/api/upload":
            name = os.path.basename(str(data.get("name") or "图.png")).replace("/", "_")
            b64 = str(data.get("data") or "")
            if "," in b64[:80] and b64[:40].lower().startswith("data:"):
                b64 = b64.split(",", 1)[1]
            try:
                blob = base64.b64decode(b64, validate=False)
            except Exception:
                return self._json({"error": "图片数据不合法"}, 400)
            if not blob:
                return self._json({"error": "空文件"}, 400)
            if len(blob) > UPLOAD_MAX:
                return self._json({"error": "图片太大（上限 %dMB）" % (UPLOAD_MAX // 1048576)}, 413)
            ext = os.path.splitext(name)[1].lower() or ".png"
            if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"):
                ext = ".png"
            stem = re.sub(r"[^\w\u4e00-\u9fff.\-]", "_", os.path.splitext(name)[0])[:50] or "图"
            folder = os.path.join(NOTES, "assets")
            os.makedirs(folder, exist_ok=True)
            target = os.path.join(folder, stem + ext)
            n = 1
            while os.path.exists(target):
                target = os.path.join(folder, "%s-%d%s" % (stem, n, ext)); n += 1
            with open(target, "wb") as f:
                f.write(blob)
            rel = rel_of(target)
            return self._json({"ok": True, "path": rel, "name": os.path.basename(target),
                               "url": "/api/raw?path=" + urllib.parse.quote(rel),
                               "size": len(blob)})
        if p == "/api/username":
            new = str(data.get("username") or "").strip()
            if new == self.user:
                return self._json({"ok": True, "user": new, "display": new})
            if not re.match(r"^[\w.\-]{2,32}$", new):
                return self._json({"error": "用户名要 2-32 位，中英文数字或 _ . -，不能有空格"}, 400)
            if not check_user(self.user, str(data.get("old") or "")):
                return self._json({"error": "改用户名要填对当前密码"}, 403)
            old = self.user
            with _LOCK:
                users = load_users()
                if new in users:
                    return self._json({"error": "这个名字已经有人用了"}, 409)
                u = users.pop(old, None)
                if not u:
                    return self._json({"error": "账号不存在"}, 404)
                u["display"] = new            # 显示名跟着登录名走，旧数据也一并抹平
                users[new] = u
                save_users(users)
            self.user = new
            tok = sign("%s|%d" % (new, int(time.time()) + SESSION_DAYS * 86400))
            _LOGS.append((time.strftime("%Y-%m-%d %H:%M:%S"), "%s → %s" % (old, new),
                          self.client_address[0], "改用户名"))
            return self._json({"ok": True, "user": new, "display": new}, 200, {
                "Set-Cookie": "%s=%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Lax"
                              % (COOKIE, tok, SESSION_DAYS * 86400)})
        if p == "/api/password":
            old = str(data.get("old") or "")
            new = str(data.get("new") or "")
            if len(new) < 6:
                return self._json({"error": "新密码至少 6 位"}, 400)
            if not check_user(self.user, old):
                return self._json({"error": "原密码不对"}, 403)
            users = load_users()
            u = users.get(self.user) or {}
            if u.get("must_change") and self.user == DEFAULT_USER:
                return self._json({"error": "初始账号请先把用户名从 %s 改掉" % DEFAULT_USER}, 400)
            salt, h = _hash_pw(new)
            u.update({"salt": salt, "hash": h,
                      "changed": time.strftime("%Y-%m-%d %H:%M:%S")})
            u.pop("must_change", None)
            users[self.user] = u
            save_users(users)
            return self._json({"ok": True})
        if p == "/api/logout":
            return self._json({"ok": True}, 200,
                              {"Set-Cookie": "%s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" % COOKIE})
        if p == "/api/site":
            cur = load_site()
            for k in SITE_KEYS:
                if k in data and isinstance(data[k], str):
                    cur[k] = data[k][:300]
            save_site(cur)
            return self._json({"ok": True, "site": cur})
        if p == "/api/save":
            rel = str(data.get("path") or "")
            body = data.get("body")
            front = data.get("front")
            if body is None:
                return self._json({"error": "缺少正文"}, 400)
            try:
                full = safe_path(rel)
            except ValueError:
                return self._json({"error": "非法路径"}, 400)
            if not os.path.isfile(full):
                return self._json({"error": "笔记不存在"}, 404)
            with _LOCK:
                backup(full)
                old = ""
                try:
                    with open(full, "r", encoding="utf-8") as f:
                        old = f.read()
                except OSError:
                    pass
                old_front, _b = split_front(old)
                text = (front if front is not None else old_front) + (body if body.endswith("\n") else body + "\n")
                tmp = full + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write(text)
                os.replace(tmp, full)
            return self._json({"ok": True, "mtime": int(os.path.getmtime(full)),
                               "words": len(re.sub(r"\s", "", plain(body)))})
        if p == "/api/create":
            dirrel = str(data.get("dir") or "").strip("/")
            title = (str(data.get("title") or "新笔记")).strip() or "新笔记"
            name = re.sub(r'[\\/:*?"<>|]', "-", title)[:60] + ".md"
            try:
                folder = safe_path(dirrel)
            except ValueError:
                return self._json({"error": "非法目录"}, 400)
            os.makedirs(folder, exist_ok=True)
            full = os.path.join(folder, name)
            if os.path.exists(full):
                full = os.path.join(folder, "%s-%d.md" % (os.path.splitext(name)[0], int(time.time())))
            stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
            with open(full, "w", encoding="utf-8") as f:
                f.write("---\ntitle: %s\ncreated: %s\n---\n\n# %s\n\n" % (title, stamp, title))
            return self._json({"ok": True, "path": rel_of(full)})
        if p == "/api/rename":
            rel = str(data.get("path") or "")
            title = str(data.get("title") or "").strip()
            if not title:
                return self._json({"error": "标题不能为空"}, 400)
            try:
                full = safe_path(rel)
            except ValueError:
                return self._json({"error": "非法路径"}, 400)
            if os.path.isdir(full):
                # 文件夹改名：重命名目录本身，并把 order.json 里的旧路径一起换掉
                newname = re.sub(r'[\\/:*?"<>|]', "-", title).strip()[:60]
                if not newname:
                    return self._json({"error": "名字不能为空"}, 400)
                target = os.path.join(os.path.dirname(full), newname)
                if os.path.realpath(target) == os.path.realpath(full):
                    return self._json({"ok": True, "path": rel})
                if os.path.exists(target):
                    return self._json({"error": "已存在同名文件夹"}, 400)
                with _LOCK:
                    os.rename(full, target)
                newrel = rel_of(target)
                order = load_order()
                if order:
                    changed = False
                    parent = rel.rsplit("/", 1)[0] if "/" in rel else ""
                    oldname = os.path.basename(full)
                    for k in list(order.keys()):
                        nk = None
                        if k == rel:
                            nk = newrel
                        elif k.startswith(rel + "/"):
                            nk = newrel + k[len(rel):]
                        if nk is not None:
                            order[nk] = order.pop(k)
                            changed = True
                    seq = order.get(parent)
                    if seq and oldname in seq:
                        order[parent] = [newname if x == oldname else x for x in seq]
                        changed = True
                    if changed:
                        with _LOCK:
                            save_order(order)
                return self._json({"ok": True, "path": newrel})
            if not os.path.isfile(full):
                return self._json({"error": "找不到该笔记"}, 404)
            with _LOCK:
                with open(full, "r", encoding="utf-8") as f:
                    text = f.read()
                front, body = split_front(text)
                if re.search(r"^title:.*$", front, re.M):
                    front2 = re.sub(r"^title:.*$", "title: " + title, front, count=1, flags=re.M)
                else:
                    front2 = "---\ntitle: %s\n---\n" % title if front else "---\ntitle: %s\n---\n" % title
                if front and not front.endswith("\n"):
                    front2 = front2.rstrip("\n") + "\n"
                if not re.search(r"^#\s+", body, re.M):
                    body = "# %s\n%s" % (title, body)
                tmp = full + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write(front2 + body)
                os.replace(tmp, full)
            newrel = rel
            safe_name = re.sub(r'[\\/:*?"<>|]', "-", title)[:60] + ".md"
            if data.get("renameFile") and os.path.basename(full) != safe_name:
                target = os.path.join(os.path.dirname(full), safe_name)
                if not os.path.exists(target):
                    with _LOCK:
                        os.rename(full, target)
                    newrel = rel_of(target)
            return self._json({"ok": True, "path": newrel})
        if p == "/api/delete":
            rel = str(data.get("path") or "")
            try:
                full = safe_path(rel)
            except ValueError:
                return self._json({"error": "非法路径"}, 400)
            if not os.path.exists(full):
                return self._json({"error": "找不到该笔记"}, 404)
            mark = rel.strip("/").replace("/", "|") or os.path.basename(full)   # 用 | 记下原路径（文件名不允许 |），还原时回原位
            dest = os.path.join(TRASH, time.strftime("%Y%m%d-%H%M%S") + "__" + mark)
            with _LOCK:
                shutil.move(full, dest)
            return self._json({"ok": True, "moved": rel_of(dest) if dest.startswith(NOTES) else os.path.basename(dest)})
        if p == "/api/restore":
            name = os.path.basename(str(data.get("name") or ""))
            src = os.path.realpath(os.path.join(TRASH, name))
            if not src.startswith(TRASH + os.sep) or not os.path.exists(src):
                return self._json({"error": "找不到回收站里的这一项"}, 404)
            orig = (name.split("__", 1)[-1] if "__" in name else name).replace("|", "/")
            try:
                dest = safe_path(orig)
            except ValueError:
                return self._json({"error": "原路径不合法"}, 400)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if os.path.exists(dest):
                base, ext = os.path.splitext(dest)
                dest = base + "-恢复" + time.strftime("%H%M%S") + ext
            with _LOCK:
                shutil.move(src, dest)
            return self._json({"ok": True, "path": rel_of(dest),
                               "is_dir": os.path.isdir(dest)})
        if p == "/api/purge":
            name = os.path.basename(str(data.get("name") or ""))
            src = os.path.realpath(os.path.join(TRASH, name))
            if src.startswith(TRASH + os.sep) and os.path.exists(src):
                with _LOCK:
                    if os.path.isdir(src):
                        shutil.rmtree(src)
                    else:
                        os.remove(src)
            return self._json({"ok": True})
        if p == "/api/trash/empty":
            with _LOCK:
                for fn in os.listdir(TRASH):
                    p_ = os.path.join(TRASH, fn)
                    shutil.rmtree(p_) if os.path.isdir(p_) else os.remove(p_)
            return self._json({"ok": True})
        if p == "/api/move":
            src_rel = str(data.get("from") or "")
            dst_dir = str(data.get("dir") or "").strip("/")
            try:
                src = safe_path(src_rel)
                folder = safe_path(dst_dir) if dst_dir else NOTES
            except ValueError:
                return self._json({"error": "非法路径"}, 400)
            if not os.path.exists(src):
                return self._json({"error": "找不到源"}, 404)
            if os.path.realpath(src) == os.path.realpath(folder):
                return self._json({"error": "已经在那里了"}, 400)
            # 不能把目录挪进自己的子目录
            if os.path.isdir(src) and os.path.realpath(folder).startswith(os.path.realpath(src) + os.sep):
                return self._json({"error": "不能把文件夹挪进它自己里面"}, 400)
            os.makedirs(folder, exist_ok=True)
            with _LOCK:
                base = os.path.basename(src)
                dest = os.path.join(folder, base)
                if os.path.exists(dest):
                    stem, ext = os.path.splitext(base)
                    dest = os.path.join(folder, stem + "-" + time.strftime("%H%M%S") + ext)
                shutil.move(src, dest)
            return self._json({"ok": True, "path": rel_of(dest)})
        if p == "/api/reorder":
            rel_dir = str(data.get("dir") or "").strip("/")
            names = [str(x) for x in (data.get("names") or [])][:500]
            if not names:
                return self._json({"error": "没有要保存的顺序"}, 400)
            try:
                folder = safe_path(rel_dir) if rel_dir else NOTES
            except ValueError:
                return self._json({"error": "非法目录"}, 400)
            # 只接受确实存在的名字，别把目录写坏
            have = set(os.listdir(folder)) if os.path.isdir(folder) else set()
            names = [n for n in names if n in have]
            order = load_order()
            order[rel_of(folder) if folder != NOTES else ""] = names
            with _LOCK:
                save_order(order)
            return self._json({"ok": True, "count": len(names)})
        if p == "/api/mkdir":
            name = re.sub(r'[\\/:*?"<>|]', "-", str(data.get("name") or "新建文件夹")).strip()[:60]
            parent = str(data.get("dir") or "").strip("/")
            if not name:
                return self._json({"error": "名字不能为空"}, 400)
            try:
                base = safe_path(parent) if parent else NOTES
            except ValueError:
                return self._json({"error": "非法目录"}, 400)
            full = os.path.join(base, name)
            n = 1
            while os.path.exists(full):
                full = os.path.join(base, "%s-%d" % (name, n)); n += 1
            os.makedirs(full, exist_ok=True)
            return self._json({"ok": True, "name": os.path.basename(full),
                               "path": rel_of(full)})
        if p == "/api/history/read":
            name = os.path.basename(str(data.get("name") or ""))
            full = os.path.join(HISTORY, name)
            if not os.path.isfile(full):
                return self._json({"error": "找不到历史版本"}, 404)
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            front, body = split_front(text)
            return self._json({"front": front, "body": body, "name": name})
        return self._json({"error": "未知接口"}, 404)

    # —— 静态资源 ——
    def _static(self, p, query=""):
        if p in ("/", "/index.html", "/login", "/app"):
            return self._index()
        target = os.path.realpath(os.path.join(STATIC, p.lstrip("/")))
        if not target.startswith(STATIC):
            return self._send(403, "forbidden", "text/plain; charset=utf-8")
        if os.path.isfile(target):
            # 前端引用静态件都带 ?v=版本号（改了就换号），所以带 v 的可以当永久缓存
            return self._file(target, immutable=("v=" in query))
        return self._file(os.path.join(STATIC, "index.html"))

    def _index(self):
        """首页：把 HTML 里的 ?v=xxx 统一改写成当前版本号再发。

        前端资源都靠 ?v= 换号来失效，而号是写死在 HTML 里的 —— 发版忘了改，
        浏览器就会拿一年前的 app.js（用户看到的就是「改了没生效」）。这里让版本
        号说了算，发一次版全部自动失效。首页本身永远不带缓存。
        """
        path = os.path.join(STATIC, "index.html")
        if not os.path.isfile(path):
            return self._send(404, "not found", "text/plain; charset=utf-8")
        with open(path, "rb") as f:
            blob = f.read()
        blob = re.sub(rb"\?v=[0-9A-Za-z._-]+", b"?v=" + APP_VERSION.encode(), blob)
        return self._file(path, immutable=False, body=blob)

    def _file(self, path, immutable=False, body=None):
        if body is None and not os.path.isfile(path):
            return self._send(404, "not found", "text/plain; charset=utf-8")
        st = os.stat(path)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith(("javascript", "json")):
            ctype += "; charset=utf-8"
        if body is not None:                      # 动态生成的内容，按内容算 ETag
            etag = '"%s"' % hashlib.sha1(body).hexdigest()[:16]
            lastmod = None
        else:
            etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
            lastmod = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(st.st_mtime))
        if immutable or "/vendor/" in path or path.endswith((".woff2", ".woff", ".ttf",
                                                            ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico")):
            cache = "public, max-age=%d, immutable" % (CACHE_DAYS * 24 * 3600)
        else:
            cache = "no-cache"
        headers = {"ETag": etag, "Cache-Control": cache, "Vary": "Accept-Encoding"}
        if lastmod:
            headers["Last-Modified"] = lastmod
        # 命中就回 304：浏览器不必再下一遍（index.html / 没带 v 的静态件走这条）
        if self.headers.get("If-None-Match") == etag or (
                lastmod and not self.headers.get("If-None-Match")
                and self.headers.get("If-Modified-Since") == lastmod):
            return self._send(304, b"", ctype, headers)
        blob = body if body is not None else open(path, "rb").read()
        # 直接跑（不挂 nginx）时也能省流量：文本类超过 gzip_min_bytes 就 gzip
        if (len(blob) > GZIP_MIN and "gzip" in (self.headers.get("Accept-Encoding") or "")
                and (ctype.startswith("text/") or ctype.split(";")[0] in
                     ("application/javascript", "application/json", "image/svg+xml"))):
            blob = gzip.compress(blob, 6)
            headers["Content-Encoding"] = "gzip"
            # 注意：Content-Length 由 _send() 按最终内容长度统一发出，
            # 这里再设一次就会出现两个 Content-Length —— curl 不管，nginx 判为
            # 「upstream sent duplicate header line」直接回 502。别再补这一行。
        return self._send(200, blob, ctype, headers)


def _open_browser_later(url, delay=1.2):
    """本机双击/终端启动时，顺手把浏览器打开。

    只在「交互式终端」里做（stdout 是 tty）：systemd 这类没有终端的环境一律跳过，
    所以服务器上跑不会莫名其妙去开浏览器。想关掉：设 SUJIAN_NO_OPEN=1。
    """
    if os.environ.get("SUJIAN_NO_OPEN"):
        return
    if not OPEN_BROWSER:
        return
    try:
        if not sys.stdout.isatty():
            return
    except Exception:
        return

    def _go():
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass
    threading.Timer(delay, _go).start()


def _enable_ansi():
    """Windows 10+ 的控制台默认不认 ANSI 转义，手动打开；失败就退回纯文本。"""
    if os.name != "nt":
        return True
    try:
        import ctypes
        k = ctypes.windll.kernel32
        h = k.GetStdHandle(-11)                       # STD_OUTPUT_HANDLE
        mode = ctypes.c_uint32()
        if not k.GetConsoleMode(h, ctypes.byref(mode)):
            return False
        return bool(k.SetConsoleMode(h, mode.value | 0x0004))   # ENABLE_VIRTUAL_TERMINAL_PROCESSING
    except Exception:
        return False


def _link(url):
    """Windows Terminal 支持 OSC 8，能给一个真·可点击的超链接（普通点/Ctrl+点都行）。
    其它终端不认这个转义，会打出乱码，所以只在 WT 里用（WT 会设 WT_SESSION）。"""
    if os.environ.get("WT_SESSION"):
        return "\033]8;;%s\033\\%s\033]8;;\033\\" % (url, url)
    return url


def _startup_banner(url, notes_dir):
    """启动提示。终端里给一块好看的、地址独占行的提示（方便点击/复制）；
    没有终端（systemd / 重定向）就只打一行，日志干净。"""
    plain = "速笺已启动：%s  （笔记目录 %s）" % (url, notes_dir)
    try:
        tty = sys.stdout.isatty()
    except Exception:
        tty = False
    if not tty:
        return plain
    color = _enable_ansi()
    dim = "\033[2m" if color else ""
    cyan = "\033[36m" if color else ""
    green = "\033[1;32m" if color else ""
    off = "\033[0m" if color else ""
    line = "-" * 62
    rows = [
        "",
        "  %s速笺 SuJot%s  %s·%s  %s正在运行%s" % (green, off, dim, off, dim, off),
        "  %s%s%s" % (dim, line, off),
        "   打开     %s" % _link(url),
        "   笔记     %s" % notes_dir,
    ]
    rows += [
        "  %s%s%s" % (dim, line, off),
        "   关掉此窗口，立即停止服务",
        "",
    ]
    return "\n".join(rows)


def main():
    seed_notes()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    url = "http://127.0.0.1:%d/" % PORT
    print(_startup_banner(url, NOTES), flush=True)
    _open_browser_later(url)
    srv.serve_forever()


if __name__ == "__main__":
    main()
