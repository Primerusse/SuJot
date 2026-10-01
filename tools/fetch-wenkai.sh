#!/usr/bin/env bash
# 下载「霞鹜文楷」（LXGW WenKai，SIL OFL 1.1，可商用）的分片 webfont。
# 分片是按 unicode-range 切的：浏览器只会下载真正用到的那几片，所以选了这个字体
# 也不会一次性拖 5MB，而是跟着正文里出现的字按需加载。
set -euo pipefail
BASE="https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0"
OUT="/opt/data/repos/sujot/static/vendor/fonts/wenkai"
mkdir -p "$OUT/files"
cd "$OUT"

have_files=0
for w in regular bold; do
  css="lxgwwenkai-${w}.css"
  [ -f "$css" ] || curl -fsSL "$BASE/lxgwwenkai-${w}.css" -o "$css"
done

# 汇总成一个文件，路径改成服务器上的绝对路径
cat lxgwwenkai-regular.css lxgwwenkai-bold.css \
  | sed "s#url('\./files/#url('/vendor/fonts/wenkai/files/#g" > wenkai.css
rm -f lxgwwenkai-regular.css lxgwwenkai-bold.css

# 只下需要的分片（和 CSS 里引用的一致）
grep -o "/vendor/fonts/wenkai/files/[a-zA-Z0-9.-]*\.woff2" wenkai.css | sort -u > /tmp/wk-list.txt
n=$(wc -l < /tmp/wk-list.txt)
echo "需要 $n 个分片"
while read -r p; do
  f="$OUT/files/$(basename "$p")"
  [ -s "$f" ] || curl -fsSL "$BASE/files/$(basename "$p")" -o "$f"
done < /tmp/wk-list.txt
echo "分片就位：$(ls "$OUT/files" | wc -l) 个，共 $(du -sh "$OUT" | cut -f1)"
