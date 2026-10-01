#!/usr/bin/env bash
# 把静态件 + 后端推到服务器。
#
#   用法：deploy/deploy-to-server.sh <user@host> [远端目录]
#   示例：deploy/deploy-to-server.sh root@notes.example.com
#
# 静态件放 <远端目录>/static/，后端放 <远端目录>/。
# 踩过的坑，写在脚本里免得再踩：
#   ① scp 目标写成 <远端目录>/ 会把 index.html 丢到根上 —— 页面永远不更新，得进 static/
#   ② 字体、KaTeX 这类 vendor 目录要【整目录】带上，否则新版 CSS 引用的字体会在线上 404
set -euo pipefail

HOST=${1:?用法: deploy/deploy-to-server.sh <user@host> [远端目录]}
ROOT=${2:-/srv/sujian}

cd "$(dirname "$0")/.."          # 回到仓库根，下面的相对路径才成立

scp -q static/*.html static/*.js static/*.css static/*.png "$HOST:$ROOT/static/"
[ -d static/vendor ] && scp -q -r static/vendor "$HOST:$ROOT/static/"
[ -f server.py ]     && scp -q server.py "$HOST:$ROOT/"
[ -d assets ]        && scp -q -r assets "$HOST:$ROOT/"

ssh "$HOST" "grep -o 'app.[a-z]*?v=[0-9]*' $ROOT/static/index.html | tr '\n' ' '; echo; \
  ls -la $ROOT/static/sujot-favicon-32.png | awk '{print \$5, \$9}'; \
  [ -d $ROOT/static/vendor/fonts ] && ls $ROOT/static/vendor/fonts | wc -l | xargs -I{} echo '字体文件 {} 个'"

echo "已推送。只改了 static/ 的话刷新浏览器即可；改了 server.py 记得重启服务。"
