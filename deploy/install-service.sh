#!/usr/bin/env bash
# 速笺 SuJot —— 把服务装成 systemd 服务（开机自启、崩了自动拉起）
#
#   cd sujot && sudo deploy/install-service.sh
#
# 可选参数：
#   --port N     监听端口（默认 8013）
#   --base DIR   数据目录（默认 /srv/sujian）
#   --name NAME  systemd 服务名（默认 sujian）
#
# 只想在自己电脑上跑：用根目录的 ./start_run_locally.sh（Windows 双击 start_run_locally.cmd）。
# 本脚本不联网、不装第三方包：只用系统里装好的 Python 3（3.8+）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8013
BASE=""
NAME="sujian"

while [ $# -gt 0 ]; do
  case "$1" in
    --port)    PORT="$2"; shift 2 ;;
    --base)    BASE="$2"; shift 2 ;;
    --name)    NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }

# ── 1. 找一个能用的 Python（3.8+）─────────────────────────────────────────
pick_python() {
  local c
  for c in python3 python; do
    command -v "$c" >/dev/null 2>&1 && { printf '%s' "$c"; return 0; }
  done
  return 1
}

if ! PY="$(pick_python)"; then
  say "✗ 没找到 Python。速笺只依赖 Python 3.8+ 本身，先装一个："
  say "    Debian / Ubuntu   sudo apt install python3"
  say "    CentOS / RHEL     sudo yum install python3"
  exit 1
fi

VER="$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo 0.0)"
case "$VER" in
  3.8|3.9|3.1[0-9]) ;;
  *) say "✗ Python $VER 太旧（需要 3.8+）。装一个新的再跑这个脚本。"; exit 1 ;;
esac
say "✓ Python：$VER（$PY）"

# systemd 的 ExecStart 要绝对路径，裸名字在部分环境下解析不到
PYABS="$PY"
case "$PY" in
  /*) ;;
  *) PYABS="$(command -v "$PY" || printf '%s' "$PY")" ;;
esac

# ── 2. 数据目录 ─────────────────────────────────────────────────────────
[ -n "$BASE" ] || BASE="/srv/sujian"
mkdir -p "$BASE" 2>/dev/null || { say "✗ 建不了数据目录 $BASE（要 sudo？）"; exit 1; }
say "✓ 数据目录：$BASE"

# ── 3. 装 systemd 服务 ──────────────────────────────────────────────────
if [ "$(id -u)" != "0" ]; then
  say "✗ 需要 root：sudo deploy/install-service.sh"; exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  say "✗ 这台机器没有 systemd。直接运行 ./start_run_locally.sh（配合 nohup 或 tmux 常驻）也可以。"; exit 1
fi

UNIT="/etc/systemd/system/$NAME.service"

# PrivateTmp 会把 /tmp 隔离开，代码或数据目录放在 /tmp 下时服务会起不来（CHDIR 失败）
TMPPATH=0
for p in "$ROOT" "$BASE"; do
  case "$p" in /tmp/*|/var/tmp/*) TMPPATH=1 ;; esac
done
if [ "$TMPPATH" = 1 ]; then
  PRIVATETMP=""
  say "· 代码或数据目录在 /tmp 下，已关掉 PrivateTmp（否则服务找不到目录）"
else
  PRIVATETMP="PrivateTmp=true"
fi

cat > "$UNIT" <<UNITEOF
[Unit]
Description=速笺 SuJot 笔记服务
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT

# 数据目录（笔记 / 历史版本 / 回收站 / 账号 / 站点配置都在这里）
Environment=SUJIAN_BASE=$BASE
Environment=SUJIAN_PORT=$PORT

ExecStart=$PYABS $ROOT/server.py
Restart=always
RestartSec=2

NoNewPrivileges=true
$PRIVATETMP

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable --now "$NAME" >/dev/null 2>&1 || true
sleep 1
if systemctl is-active --quiet "$NAME"; then
  say "✓ 服务已启动：systemctl status $NAME"
else
  say "✗ 服务没起来，看日志：journalctl -u $NAME -n 30 --no-pager"
  exit 1
fi

say ""
say "接下来（外网访问）用 nginx 反代 + HTTPS，示例配置在 deploy/："
say "    cp deploy/nginx.conf.example /etc/nginx/sites-available/$NAME"
say "    sed -i 's/sujot.example.com/你的域名/g' /etc/nginx/sites-available/$NAME"
say "    ln -sf /etc/nginx/sites-available/$NAME /etc/nginx/sites-enabled/$NAME"
say "    nginx -t && systemctl reload nginx"
say "    apt install certbot python3-certbot-nginx && certbot --nginx -d 你的域名"
say ""
say "后端只监听 127.0.0.1:$PORT，别把它直接暴露到外网。"
