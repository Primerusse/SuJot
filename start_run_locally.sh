#!/usr/bin/env bash
# 启动速笺（前台跑，Ctrl+C 停）。用系统的 python3；没配 SUJIAN_BASE 时数据落 ./data。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

pick_python() {
  local c
  for c in python3 python; do
    command -v "$c" >/dev/null 2>&1 && { printf '%s' "$c"; return 0; }
  done
  return 1
}

PY="$(pick_python)" || {
  echo "✗ 没找到 Python。先装 Python 3.8+："
  echo "    Debian/Ubuntu  sudo apt install python3"
  echo "    macOS          brew install python3（或到 python.org 下安装包）"
  exit 1
}
export SUJIAN_BASE="${SUJIAN_BASE:-$ROOT/data}"
mkdir -p "$SUJIAN_BASE"

echo "速笺启动中：$PY"
echo "数据目录：$SUJIAN_BASE"
echo "浏览器打开  http://127.0.0.1:${SUJIAN_PORT:-8013}   （Ctrl+C 停）"
exec "$PY" server.py
