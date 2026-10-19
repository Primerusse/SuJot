/* 速笺 SuJot · 前端（原生 JS，无框架、无构建） */
(() => {
'use strict';

/* ══ 小工具 ═══════════════════════════════════════════════ */
const $ = (s, r = document) => r.querySelector(s);
/** 安全绑定：元素不存在时静默跳过，绝不因为一个按钮缺失就拖垮整个应用 */
const bindEl = (sel, ev, fn) => {
  const n = $(sel);
  if (n) { n.addEventListener(ev, fn); return; }
  (window.__missEl = window.__missEl || []).push(sel);
};
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const fmtTime = ts => {
  const d = new Date(ts * 1000), n = new Date(), p = x => String(x).padStart(2, '0');
  const hm = p(d.getHours()) + ':' + p(d.getMinutes());
  if (d.toDateString() === n.toDateString()) return '今天 ' + hm;
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
};

/* ══ 搜索范围 ═════════════════════════════════════════ */
const SCOPES = {
  both:  { label: '名称+内容', short: '全部', hint: '名称和正文都找' },
  title: { label: '只搜名称',  short: '名称',  hint: '只看标题，最快' },
  body:  { label: '只搜内容',  short: '内容',  hint: '只查正文' }
};
let SCOPE = localStorage.getItem('sj-scope') || 'both';
let APP_VER = '';   // 由 /api/site 下发（VERSION 文件）
if (!SCOPES[SCOPE]) SCOPE = 'both';

function applyScope(scope) {
  if (!SCOPES[scope]) scope = 'both';
  SCOPE = scope;
  localStorage.setItem('sj-scope', scope);
  const lbl = $('#scope-label'), menu = $('#scope-menu'), btn = $('#scope-btn');
  if (lbl) { lbl.textContent = SCOPES[scope].short; lbl.title = '搜索范围：' + SCOPES[scope].label; }
  if (el.filter) el.filter.placeholder = '搜索…';
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
  $$('#scope-menu button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.scope === scope)));
  if (el.filter && el.filter.value.trim()) doSearch(el.filter.value.trim());
}

function wireScope() {
  const wrap = $('#scope-wrap'), btn = $('#scope-btn'), menu = $('#scope-menu');
  if (!wrap || !btn || !menu) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  menu.addEventListener('click', e => {
    const b = e.target.closest('button[data-scope]');
    if (b) applyScope(b.dataset.scope);
  });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
  applyScope(SCOPE);
}

/** 按当前范围搜索：名称过滤在前（本地、快），内容搜索走后端全文 */
function doSearch(q) {
  /* 每次搜索都先把上一轮的命中全部清掉。
     不清的话旧命中会一直挂着：换一个八竿子打不着的词，树里那几篇还是高亮的，
     计数也会骗人（显示「1 篇有结果」其实这一轮一篇都没中）。 */
  S.byPath.forEach(n => { if (n.hit) n.hit = null; });
  renderTree();
  if (!q) { clearTimeout(_srchT); return; }        // 搜索框清空 → 计数由 renderTree 恢复成「共 N 篇」
  if (SCOPE === 'both' || SCOPE === 'body') {
    clearTimeout(_srchT);
    const mine = q;                                 // 回来时若已换成别的词，这次结果作废
    _srchT = setTimeout(async () => {
      if (el.filter.value.trim() !== mine) return;
      try {
        const r = await get('/api/search?q=' + encodeURIComponent(mine) + (SCOPE === 'body' ? '&field=body' : ''));
        if (el.filter.value.trim() !== mine) return;
        (r.results || []).forEach(x => {
          const n = S.byPath.get(x.path);
          if (n) n.hit = x.snippet || [];
        });
      } catch (e) { /* 搜索失败不打断浏览 */ }
      renderTree();
      const docs = Array.from(S.byPath.values()).filter(n => n.type === 'doc');
      el.statCount.textContent = mine + '：' + docs.filter(n => n.hit).length + ' 篇有结果 / 共 ' + docs.length + ' 篇';
    }, 260);
  }
}
let _srchT = null;

/* ══ 接口 ═══════════════════════════════════════════════ */
async function api(path, opts = {}) {
  const res = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts));
  if (res.status === 401) { showGate(); throw new Error('未登录'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error((data && data.error) || '请求失败'), { data, status: res.status });
  return data;
}
const get = p => api(p);
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
});

/* ══ Markdown → HTML（自写；KaTeX 负责公式）═══════════════ */
let KATEX_OK = typeof window.katex !== 'undefined';
let OUTLINE = [];              // 本次渲染收集到的标题 {id, level, text}
let slugSeq = {};              // 同名标题去重

/* 公式先占位，再由 queueKatex() 分批渲染——
   一篇 1400 条公式的大笔记如果同步渲染，主线程会卡住十几秒，手机上直接假死。*/
function mathHtml(raw) {
  const display = /^\$\$/.test(raw.trim());
  const tex = raw.trim().replace(/^\$\$?/, '').replace(/\$\$?$/, '').trim();
  if (!tex) return '';
  const tag = display ? 'div' : 'span';
  return '<' + tag + ' class="katex-slot' + (display ? ' disp' : '') + '" data-tex="' + esc(tex) +
         '" data-disp="' + (display ? '1' : '0') + '"></' + tag + '>';
}

let KT_TOKEN = 0, KT_TIMER = null;

/** 把单个占位渲染成真公式 */
function renderSlot(slot) {
  if (!slot || !slot.parentNode) return;
  const tex = slot.getAttribute('data-tex') || '';
  const disp = slot.getAttribute('data-disp') === '1';
  let out;
  try {
    out = KATEX_OK
      ? window.katex.renderToString(tex, { displayMode: disp, throwOnError: false, strict: false })
      : '<code>' + esc(tex) + '</code>';
  } catch (e) { out = '<code>' + esc(tex) + '</code>'; }
  const box = document.createElement('span');
  box.innerHTML = out;
  const node = box.firstElementChild || box;
  if (disp) {
    const wrap = document.createElement('div');
    wrap.className = 'katex-block';
    wrap.appendChild(node);
    slot.replaceWith(wrap);
  } else {
    slot.replaceWith(node);
  }
}

/** 分批渲染（每批最多占 12ms），保证滚动和打字不卡 */
function queueKatex() {
  KT_TOKEN++;
  const my = KT_TOKEN;
  if (KT_TIMER) { clearTimeout(KT_TIMER); KT_TIMER = null; }
  const slots = Array.prototype.slice.call(el.preview.querySelectorAll('.katex-slot'));
  if (!slots.length) return;
  let i = 0;
  const step = () => {
    if (my !== KT_TOKEN) return;                 // 已经重新渲染，放弃这一批
    const t0 = Date.now();
    while (i < slots.length && Date.now() - t0 < 12) renderSlot(slots[i++]);
    if (i < slots.length) KT_TIMER = setTimeout(step, 0);
    else KT_TIMER = null;
  };
  KT_TIMER = setTimeout(step, 0);
}

/** 立刻把剩下的公式全部渲完（打印/导出前用） */
function flushKatex() {
  KT_TOKEN++;
  if (KT_TIMER) { clearTimeout(KT_TIMER); KT_TIMER = null; }
  Array.prototype.slice.call(el.preview.querySelectorAll('.katex-slot')).forEach(renderSlot);
}

/* 笔记里历史遗留的原生 HTML（Word 导出的表格、旧站写下的 `<div align="center">`）——
   放行一个白名单子集，白名单之外的标签仍旧转义成纯文本，绝不放脚本/事件/外部 URL 进来。 */
const HTML_OK = {
  div: ['align'], p: ['align'], center: [], figure: [], section: [], details: [], summary: [],
  strong: [], b: [], em: [], i: [], u: [], s: [], del: [], mark: [], small: [], span: [],
  sup: [], sub: [], code: [], pre: [], br: [], hr: [], ul: [], ol: [], li: [],
  table: [], thead: [], tbody: [], tfoot: [], caption: [], tr: [],
  td: ['align', 'colspan', 'rowspan', 'width'], th: ['align', 'colspan', 'rowspan', 'width']
};
/* 只有这些块级标签才会被当成「整块 HTML」处理（其余保持行内） */
const HTML_BLOCK = /^<\s*(table|div|p|center|figure|section|details|blockquote)\b/i;
const HTML_BLOCK_TAG = /<\s*(\/?)\s*(table|div|p|center|figure|section|details|blockquote)\b[^>]*>/gi;

/** 单个标签 → 清洗后的标签；不在白名单里返回 null（调用方按纯文本转义） */
function rawTag(tag) {
  const m = String(tag).match(/^<\s*(\/?)\s*([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\s*(\/?)\s*>$/);
  if (!m) return null;
  const close = m[1], name = m[2].toLowerCase(), attrs = m[3] || '';
  if (!Object.prototype.hasOwnProperty.call(HTML_OK, name)) return null;
  const keep = [];
  const re = /([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let a;
  while ((a = re.exec(attrs))) {
    const nm = a[1].toLowerCase();
    const val = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '';
    if (HTML_OK[name].indexOf(nm) < 0) continue;
    if (/^on/i.test(nm)) continue;
    if (/^\s*(javascript|vbscript|data):/i.test(val)) continue;
    if (nm === 'align' && !/^(left|center|right|justify)$/i.test(val)) continue;
    if (nm === 'width' && !/^\d{1,3}(%|px)?$/.test(val)) continue;
    if ((nm === 'colspan' || nm === 'rowspan') && !/^\d{1,3}$/.test(val)) continue;
    keep.push(nm + '="' + esc(val) + '"');
  }
  const voidTag = /^(br|hr)$/.test(name);
  return '<' + close + name + (keep.length ? ' ' + keep.join(' ') : '') + (!close && voidTag ? ' /' : '') + '>';
}

/** 一整块 HTML：标签走白名单，标签之间的文字照旧走行内解析（加粗、公式、图片都在里面） */
function htmlBlock(src) {
  const re = /<\/?[a-zA-Z][^>]*>/g;
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > last) out += inline(src.slice(last, m.index));
    const t = rawTag(m[0]);
    out += t === null ? esc(m[0]) : t;
    last = re.lastIndex;
  }
  return out + inline(src.slice(last));
}

function inline(text) {
  const stash = [], keep = [], code = [];
  // 行内代码先摘出来：反引号里的 $...$、<div> 都该按字面显示（老写法是后摘，会把代码里的 $…$ 当公式渲染）
  let s = String(text).replace(/`([^`\n]+)`/g, (m, a) => {
    code.push('<code>' + esc(a) + '</code>'); return '\u0002' + (code.length - 1) + '\u0002';
  });
  s = s.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, m => {
    stash.push(m); return '\u0000' + (stash.length - 1) + '\u0000';
  });
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, m => {          // 白名单 HTML 先摘出来，免得被转义
    const t = rawTag(m);
    if (t === null) return m;
    keep.push(t); return '\u0001' + (keep.length - 1) + '\u0001';
  });
  s = esc(s);
  s = s.replace(/&amp;(#\d{2,6}|[a-zA-Z][a-zA-Z0-9]{1,9});/g, '&$1;');   // 笔记里写的 HTML 实体保留
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (m, alt, src) => '<img alt="' + alt + '" src="' + attrUrl(src) + '" loading="lazy">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (m, t, href) => '<a href="' + attrUrl(href) + '" target="_blank" rel="noopener">' + t + '</a>');
  s = s.replace(/(^|[\s（(])\*([^*\n]+?)\*(?=[\s）。，,.!?;:]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\u0002(\d+)\u0002/g, (m, i) => code[+i]);
  s = s.replace(/\u0001(\d+)\u0001/g, (m, i) => keep[+i]);
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => mathHtml(stash[+i]));
  return s;
}

const IMG_VER = new Map();      // 相对路径 → 保存后的 mtime，用来破图片缓存

function attrUrl(u) {
  if (/^(https?:|mailto:|data:|#)/i.test(u)) return esc(u);
  let path;
  try {
    if (/^\/assets\//i.test(u)) path = 'assets/' + decodeURI(u.replace(/^\/assets\//i, ''));
    else if (u.startsWith('/')) path = decodeURI(u.slice(1));
    else {
      const dir = S.current ? S.current.split('/').slice(0, -1).join('/') : '';
      path = (dir ? dir + '/' : '') + decodeURI(u.replace(/^\.\//, ''));
    }
  } catch (e) { path = u; }
  const v = IMG_VER.get(path);
  return esc('/api/raw?path=' + encodeURIComponent(path) + (v ? '&v=' + v : ''));
}

const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const isSepRow = s => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(s);
const splitRow = s => s.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

let MD_DEPTH = 0;              // md() 处理引用块时会递归，只有最外层才重置大纲

function md(src) {
  const top = MD_DEPTH === 0;
  if (top) { OUTLINE = []; slugSeq = {}; }
  MD_DEPTH++;
  try { return mdBody(src); } finally { MD_DEPTH--; }
}

function mdBody(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0, out = '';

  const renderList = (indent, ordered) => {
    let html = ordered ? '<ol>' : '<ul>', loose = false;
    for (;;) {
      const line = lines[i];
      if (line === undefined) break;
      const m = line.match(LIST_RE);
      if (!m) { if (line.trim() === '') { const nxt = lines[i + 1] || ''; if (LIST_RE.test(nxt) || nxt.trim() === '') { i++; loose = true; continue; } break; } break; }
      const ind = m[1].replace(/\t/g, '  ').length;
      if (ind < indent) break;
      if (ind > indent) { html += renderList(ind, /\d/.test(m[2])); continue; }
      if (/\d/.test(m[2]) !== ordered) break;
      let text = m[3];
      const task = /^\[([ xX])\]\s*/.test(text);
      const done = task && /^\[[xX]\]/.test(text);
      if (task) text = text.replace(/^\[[ xX]\]\s*/, '');
      i++;
      let tail = '';
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '' || LIST_RE.test(l) || /^\s*(#{1,6}\s|>|```|\$\$)/.test(l)) break;
        tail += ' ' + l.trim(); i++;
      }
      html += '<li' + (task ? ' class="task"' : '') + '>' +
        (task ? '<input type="checkbox" disabled' + (done ? ' checked' : '') + '>' : '') +
        inline(text + tail) + '</li>';
      if (loose) { /* 松散列表不特殊处理 */ }
    }
    return html + (ordered ? '</ol>' : '</ul>');
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // 代码围栏
    let m = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (m) {
      const fence = m[1][0], lang = m[2]; i++;
      const buf = [];
      while (i < lines.length && !new RegExp('^\\s*' + fence + '{3,}').test(lines[i])) buf.push(lines[i++]);
      i++;
      out += '<pre><code' + (lang ? ' class="lang-' + esc(lang) + '"' : '') + '>' + esc(buf.join('\n')) + '</code></pre>';
      continue;
    }

    // 独立公式块
    if (/^\s*\$\$/.test(line)) {
      const buf = [];
      let cur = line.replace(/^\s*\$\$/, '');
      if (/\$\$\s*$/.test(cur) && cur.trim()) { buf.push(cur.replace(/\$\$\s*$/, '')); i++; }
      else {
        buf.push(cur);
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (/\$\$\s*$/.test(l)) { buf.push(l.replace(/\$\$\s*$/, '')); i++; break; }
          buf.push(l); i++;
        }
      }
      out += '<p class="math-block">' + mathHtml('$$' + buf.join('\n') + '$$') + '</p>';
      continue;
    }

    // 标题
    m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) {
      const lv = m[1].length;
      const raw = m[2];
      const text = raw.replace(/\$[^$]*\$/g, ' ').trim();     // 锚点用去掉公式后的文字
      let slug = 'h-' + text.toLowerCase().replace(/[\s]+/g, '-').replace(/[^\w\u4e00-\u9fff\-.]/g, '').slice(0, 40);
      if (!slug || slug === 'h-') slug = 'h-sec';
      slugSeq[slug] = (slugSeq[slug] || 0) + 1;
      if (slugSeq[slug] > 1) slug += '-' + slugSeq[slug];
      OUTLINE.push({ id: slug, level: lv, text: text || raw, line: i });
      out += `<h${lv} id="${slug}">` + inline(raw) +
             `<a class="anchor" href="#${slug}" aria-label="锚点">#</a></h${lv}>`;
      i++; continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out += '<hr>'; i++; continue; }

    // 表格
    if (line.includes('|') && isSepRow(lines[i + 1] || '')) {
      const head = splitRow(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      out += '<table><thead><tr>' + head.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + head.map((_, k) => '<td>' + inline(r[k] || '') + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>';
      continue;
    }

    // 引用 / 卡片
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      const co = buf[0] && buf[0].match(/^\s*\[!(\w+)\]\s*(.*)$/);
      if (co) {
        let title = co[2].trim();
        const body = buf.slice(1);
        out += '<blockquote class="callout"><p class="co-line">' +
          (title ? '<span class="co-title">' + inline(title) + '</span>' : '') + '</p>' +
          (body.length ? md(body.join('\n')) : '') + '</blockquote>';
      } else {
        out += '<blockquote>' + md(buf.join('\n')) + '</blockquote>';
      }
      continue;
    }

    // 列表
    m = line.match(LIST_RE);
    if (m) { out += renderList(m[1].replace(/\t/g, '  ').length, /\d/.test(m[2])); continue; }

    // 注释
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !/-->/.test(lines[i])) i++;
      i++; continue;
    }

    // 整块 HTML（白名单）：按原样输出，不再包一层 <p>
    if (HTML_BLOCK.test(line)) {
      const buf = [];
      let depth = 0;
      do {
        const l = lines[i];
        buf.push(l);
        HTML_BLOCK_TAG.lastIndex = 0;
        let t;
        while ((t = HTML_BLOCK_TAG.exec(l))) depth += t[1] ? -1 : 1;
        i++;
      } while (i < lines.length && depth > 0);
      out += htmlBlock(buf.join('\n'));
      continue;
    }

    // 段落
    const buf = [];
    while (i < lines.length && lines[i].trim() &&
           !/^\s*(#{1,6}\s|>|```|~~~|\$\$)/.test(lines[i]) &&
           !LIST_RE.test(lines[i]) &&
           !(lines[i].includes('|') && isSepRow(lines[i + 1] || ''))) {
      buf.push(lines[i]); i++;
    }
    out += '<p>' + inline(buf.join('\n')) + '</p>';
  }
  return out;
}

/* ══ 应用状态 ═══════════════════════════════════════════ */
const S = {
  tree: [], byPath: new Map(), current: null, front: '', body: '',
  dirty: false, saving: false, view: 'split', ratio: 0.5, expanded: new Set(),
  hit: ''            // 当前搜索词，用于预览高亮
};

const el = {
  app: $('#app'), gate: $('#gate'), tree: $('#tree'), editor: $('#editor'), preview: $('#preview'),
  saveState: $('#save-state'), stPath: $('#st-path'), stWords: $('#st-words'),
  stSaved: $('#st-saved'), statCount: $('#stat-count'), split: $('#split'), gutter: $('#gutter'),
  filter: $('#filter'), toast: $('#toast'), sidebar: $('#sidebar'),
  body: $('#body'), rail: $('#rail'),
  searchOverlay: $('#search-overlay'), q: $('#q'), results: $('#results'),
  promptOverlay: $('#prompt-overlay'), promptInput: $('#prompt-input'),
  historyOverlay: $('#history-overlay'), histList: $('#hist-list'),
  userMenu: $('#user-menu'),
  avatar: $('#avatar'), menuHead: $('#menu-head'),
  btnUser: $('#btn-user'),
  outline: $('#outline-panel'),
  keysOverlay: $('#keys-overlay'),
  paneTrash: $('#pane-trash'), paneSet: $('#pane-set'),
  trashCards: $('#trash-cards')
};

/* 首次部署时是否需要注册管理员（后端 /api/setup-state 告知） */
let NEEDS_SETUP = false;

/* ══ 主题 / 视图偏好 ═══════════════════════════════════ */
function applyTheme() {
  const pref = resolveTheme(localStorage.getItem('sj-theme') || DEFAULTS.theme);
  document.documentElement.dataset.theme = pref;
  localStorage.setItem('sj-theme', pref);
}

function setView(v) {
  S.view = v;
  // 手机屏（<=860px）进分栏等于两边都挤成一条，自动落到预览（应用里叫 read）
  if (window.innerWidth <= 860 && v === 'split') {
    v = 'read';
  }
  if (v !== S.view) S.view = v;
  el.split.dataset.view = v;
  $$('#seg-view button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  localStorage.setItem('sj-view', v);
}

window.addEventListener('resize', () => {
  if (window.innerWidth <= 860 && S.view === 'split') setView('read');
});

/* ══ 树 ═════════════════════════════════════════════════ */
function flatten(nodes, depth = 0, acc = []) {
  nodes.forEach(n => { acc.push([n, depth]); if (n.type === 'dir' && n.children) flatten(n.children, depth + 1, acc); });
  return acc;
}

function renderTree() {
  const q = (el.filter.value || '').trim().toLowerCase();
  const items = [];
  const walk = (nodes, depth, parentDir) => nodes.forEach(n => {
    if (n.type === 'dir') {
      const kids = [];
      const collect = x => x.forEach(c => { kids.push(c); if (c.type === 'dir' && c.children) collect(c.children); });
      collect(n.children || []);
      const hit = !q || kids.some(k => k.type === 'doc' &&
                  ((k.title + k.path).toLowerCase().includes(q) || (k.hit && k.hit.length))) ||
                  n.name.toLowerCase().includes(q);
      if (hit) items.push({ n, depth, of: parentDir });
      if (hit && (S.expanded.has(n.path) || q)) walk(n.children || [], depth + 1, n.path);
    } else {
      const inName = !q || (n.title + n.path).toLowerCase().includes(q);
      const inBody = q && n.hit && n.hit.length;
      if (inName || inBody) items.push({ n, depth, of: parentDir });
    }
  });
  walk(S.tree, 0, '');

  el.tree.innerHTML = items.map(({ n, depth, of }) => {
    const pad = 6 + depth * 10;
    if (n.type === 'dir') {
      const open = S.expanded.has(n.path) || (q && true);
      return `<div class="node dir" data-dir="${esc(n.path)}" data-of="${esc(of)}" draggable="true" style="padding-left:${pad}px">
        <span class="chev${open ? ' open' : ''}"><svg viewBox="0 0 16 16" class="ico"><path d="M6 3l5 5-5 5"/></svg></span>
        <svg viewBox="0 0 16 16" class="ico"><path d="M2 4.5h4l1.2 1.5H14v6.5H2z"/></svg>
        <span class="nm">${esc(n.name)}</span><span class="cnt">${n.count || ''}</span></div>`;
    }
    const on = S.current === n.path ? ' on' : '';
    const hitCls = n.hit && n.hit.length ? ' hit' : '';
    const tip = n.hit && n.hit.length ? esc((n.hit[0] || '').slice(0, 60)) : esc(n.path);
    return `<div class="node doc${on}${hitCls}" data-doc="${esc(n.path)}" data-of="${esc(of)}" draggable="true" style="padding-left:${pad + 14}px" title="${tip}">
      <svg viewBox="0 0 16 16" class="ico"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>
      <span class="nm">${esc(n.title)}</span></div>`;
  }).join('') || (q
        ? '<div class="empty-hint">没有找到相符的笔记<em>换个词试试，或把范围放宽到「名称和内容都搜」</em></div>'
        : '<div class="empty-hint">这里还是一张白纸<em>按 <kbd>Ctrl</kbd>+<kbd>N</kbd>，或者点上面的 ＋，写下第一篇</em></div>');

  let total = 0;
  S.byPath.forEach(n => { if (n.type === 'doc') total++; });
  el.statCount.textContent = (q ? items.filter(x => x.n.type === 'doc').length + ' / ' : '') + total + ' 篇';
}

/* ══ 设置 ═══════════════════════════════════════════ */
const DEFAULTS = {
  theme: 'dark', width: 'normal', font: '15', lineno: true,
  wrap: true, mathscroll: true, lightbox: true, links: true,
  autosave: '2500', tab: '2', outline: true, side: '268',
  lineh: '1.78', editfont: '13.5', pasteupload: true,
  hl: 'classic', blurPct: 100, blur: 24,   // blurPct 是新口径（0–100%），blur 只留给老配置迁移
  brand: '速笺', tabTitle: '', logoText: '', logoUrl: ''
};
let CFG = Object.assign({}, DEFAULTS);

// 主题只有浅色 / 深色两种，不再有「跟随系统」：老配置里的 system 一律落成深色
function resolveTheme(t) { return t === 'light' ? 'light' : 'dark'; }

function loadCfg() {
  try { CFG = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('sj-cfg') || '{}')); }
  catch (e) { CFG = Object.assign({}, DEFAULTS); }
  // 老版本里 hl 是开关（true/false），迁移到方案名
  if (CFG.hl === true) CFG.hl = 'classic';
  else if (CFG.hl === false) CFG.hl = 'off';
  if (!HL_SCHEMES.includes(CFG.hl)) CFG.hl = 'classic';
}
const HL_SCHEMES = ['off', 'classic', 'vivid', 'soft'];
let _sitePushT = 0;
function pushSite() {                        // 站名/标签标题等同步到服务器（多设备一致）
  clearTimeout(_sitePushT);
  _sitePushT = setTimeout(() => {
    try {
      post('/api/site', { brand: CFG.brand || '', tabTitle: CFG.tabTitle || '', logoText: CFG.logoText || '' }).catch(() => {});
    } catch (e) {}
  }, 700);
}
function saveCfg() {
  localStorage.setItem('sj-cfg', JSON.stringify(CFG));
  applyCfg();
}

/** 把设置落到界面上 */
function applyCfg() {
  // 主题
  CFG.theme = resolveTheme(CFG.theme);
  localStorage.setItem('sj-theme', CFG.theme);
  applyTheme();
  // 正文宽度 / 字号
  const pv = el.preview;
  if (pv) {
    pv.classList.toggle('w-narrow', CFG.width === 'narrow');
    pv.classList.toggle('w-wide', CFG.width === 'wide');
  }
  document.documentElement.style.setProperty('--md-size', CFG.font + 'px');
  // 四块面板的毛玻璃强度（设置里那个滑块）
  // 磨砂强度：滑块是百分比，100% 对应 40px 模糊
  let pct = CFG.blurPct;
  if (pct == null) pct = CFG.blur == null ? 60 : Math.round(CFG.blur / 40 * 100);   // 老版本存的是 px
  pct = Math.max(0, Math.min(100, +pct || 0));
  CFG.blurPct = pct;
  const root = document.documentElement.style;
  root.setProperty('--pane-blur', (pct / 100 * 60).toFixed(1) + 'px');        // 100% = 60px 模糊
  root.setProperty('--pane-alpha', (1 - pct / 100 * 0.70).toFixed(3));        // 越磨砂越透：0% 全实心 → 100% 到 0.30
  root.setProperty('--glass-hl', (pct / 100 * 0.13).toFixed(3));            // 磨砂拉高时面板上沿有一道玻璃高光
  root.setProperty('--glass-sat', (150 + pct / 100 * 90).toFixed(0) + '%');  // 玻璃把背后颜色吸上来：深色下靠这个看出磨砂
  // 行高 / 正文字体 / 编辑器字号
  document.documentElement.style.setProperty('--line-h', CFG.lineh || '1.78');
  document.documentElement.style.setProperty('--font-edit', (CFG.editfont || '13.5') + 'px');
  // 行号
  const ln = $('#lineno');
  if (ln) ln.hidden = !CFG.lineno;
  const peLn = $('.pane-edit');
  if (peLn) peLn.classList.toggle('has-ln', !!CFG.lineno);
  // 语法着色
  const pe = $('.pane-edit');
  document.documentElement.dataset.hl = HL_SCHEMES.includes(CFG.hl) ? CFG.hl : 'classic';
  if (pe) pe.classList.toggle('hl', CFG.hl !== 'off');
  if (CFG.hl === 'off') { const hc = $('#hl-code'); if (hc) hc.innerHTML = ''; }
  // 折行
  if (el.editor) el.editor.style.whiteSpace = CFG.wrap ? 'pre-wrap' : 'pre';
  // 公式滚动
  document.documentElement.classList.toggle('no-mathscroll', !CFG.mathscroll);
  // 自动保存延时
  AUTOSAVE_MS = parseInt(CFG.autosave, 10) || 0;
  // Tab 宽度
  TAB_SPACES = parseInt(CFG.tab, 10) || 2;
  // 面板宽度：只有用户在设置里显式改过才写，避免把拖出来的宽度重置回默认
  if (SIDE_W_CFG) document.documentElement.style.setProperty('--side-w', CFG.side + 'px');
  applyBrand();
  // 大纲默认
  syncSettingsUI();
  if (el.editor) refreshLineno();
  if (el.editor) refreshHl();
}

let AUTOSAVE_MS = 2500, TAB_SPACES = 2;
// 设置里是否显式改过面板宽度（localStorage 记忆，重载后保持）
let SIDE_W_CFG = localStorage.getItem('sj-side-cfg') === '1';

/* ── 站名 / 标签页标题 / Logo ─────────────────────────── */
function applyBrand() {
  const name = CFG.brand || '速笺';
  $$('#brand-name').forEach(e => e.textContent = name);
  document.title = CFG.tabTitle ? CFG.tabTitle + ' · ' + name : name + ' SuJot';
  // Logo：图片优先，其次文字，最后用默认图。
  // 小尺寸要专用的位图（把字形放到 94% 再渲染），512 的原图直接缩到 26px 会发灰起毛刺
  const custom = !!CFG.logoUrl;
  const src = CFG.logoUrl || '/sujot-logo-52.png?v=5';
  const srcset = custom ? '' : '/sujot-logo-26.png?v=5 1x, /sujot-logo-52.png?v=5 2x, /sujot-logo-104.png?v=5 3x';
  const srcBig = CFG.logoUrl || '/sujot-logo.png?v=4';
  $$('#brand-logo').forEach(e => { e.src = src; e.srcset = srcset; e.hidden = false; });
  $$('.empty-logo').forEach(box => {
    let img = box.querySelector('img');
    if (!img) { box.innerHTML = '<img alt="">'; img = box.querySelector('img'); }
    img.src = srcBig; img.hidden = false;
  });
  const lp = $('#set-logo-preview'), li = $('#set-logo-img');
  if (li) { li.src = srcBig; li.hidden = false; const em = lp && lp.querySelector('em'); if (em) em.hidden = true; }
}

function wireBrand() {
  const b = $('#set-brand'), t = $('#set-tabtitle'), lt = $('#set-logo-text');
  if (b) b.addEventListener('input', () => { CFG.brand = b.value.trim() || '速笺'; saveCfg(); pushSite(); });
  if (t) t.addEventListener('input', () => { CFG.tabTitle = t.value.trim(); saveCfg(); pushSite(); });
  if (lt) lt.addEventListener('input', () => {
    CFG.logoText = lt.value.trim();
    CFG.logoUrl = '';                       // 填了文字就用文字 logo
    saveCfg(); pushSite();
  });
  const file = $('#set-logo-file');
  if (file) file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const r = await uploadAny('/api/upload-logo', f);
      CFG.logoUrl = r.url; CFG.logoText = ''; saveCfg();
      toast('Logo 已更新');
    } catch (e) { toast('上传失败：' + e.message); }
    file.value = '';
  });
  // 头像
  const af = $('#set-avatar-file');
  if (af) af.addEventListener('change', async () => {
    const f = af.files && af.files[0];
    if (!f) return;
    try {
      await post('/api/avatar', { data: await fileToB64(f) });
      refreshAvatar();
      toast('头像已更新');
    } catch (e) { toast('上传失败：' + e.message); }
    af.value = '';
  });
  bindEl('#set-avatar-clear', 'click', async () => {
    try { await post('/api/avatar/clear', {}); refreshAvatar(); toast('已恢复默认头像'); }
    catch (e) { toast('失败：' + e.message); }
  });
}

/** 读一个图片文件并转成 base64 data URL */
function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

/** 头像：优先用服务器上的图，没有就用用户名首字母 */
function refreshAvatar() {
  const first = (localStorage.getItem('sj-user') || 'U').slice(0, 1).toUpperCase();
  $$('#avatar').forEach(a => {
    a.textContent = first;
    const im = document.createElement('img');
    im.alt = '';
    im.onload = () => { a.textContent = ''; a.appendChild(im); };   // 有图才替换
    im.src = '/api/avatar?v=' + Date.now();
  });
}

function syncDevCard() {
  // 头像已换成图片（用户指定）；这里只兜底：图片挂了就退回首字母
  const a = document.querySelector('.dev-avatar');
  if (!a || a.tagName !== 'IMG') return;
  a.addEventListener('error', () => {
    const sp = document.createElement('span');
    sp.className = 'dev-avatar'; sp.textContent = 'P';
    a.replaceWith(sp);
  }, { once: true });
}

function syncSettingsUI() {
  const seg = (id, val) => $$('#' + id + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === String(val)));
  syncDevCard();
  seg('set-theme', CFG.theme); seg('set-font', CFG.font);
  seg('set-autosave', CFG.autosave); seg('set-tab', CFG.tab); seg('set-side', CFG.side);
  seg('set-lineh', CFG.lineh); seg('set-editfont', CFG.editfont);
  const chk = (id, v) => { const e = $('#' + id); if (e) e.checked = !!v; };
  seg('set-hl', CFG.hl);
  const sb = $('#set-blur'), sbv = $('#set-blur-v');
  const pctNow = CFG.blurPct == null ? 60 : CFG.blurPct;
  if (sb) sb.value = pctNow;
  if (sbv) sbv.textContent = pctNow + '%';
  chk('set-lineno', CFG.lineno); chk('set-wrap', CFG.wrap);
  chk('set-mathscroll', CFG.mathscroll); chk('set-lightbox', CFG.lightbox);
  chk('set-outline', CFG.outline);
  chk('set-pasteupload', CFG.pasteupload);
  const bi = $('#set-brand'), ti = $('#set-tabtitle'), lti = $('#set-logo-text');
  if (bi && document.activeElement !== bi) bi.value = CFG.brand || '';
  if (ti && document.activeElement !== ti) ti.value = CFG.tabTitle || '';
  if (lti && document.activeElement !== lti) lti.value = CFG.logoText || '';
  const ab = $('#set-about');
  if (ab) ab.textContent = '笔记 ' + S.byPath.size + ' 个节点 · 本机存储 · 无外部服务';
  const vv = $('#set-ver');
  if (vv) vv.textContent = 'v' + (APP_VER || '0.1.0');
}

function openSettings() { syncSettingsUI(); loadStats(); }

/** 设置搜索：跨分区找行；有词时把命中的分区全部摊开，清空后回到原来那个分区 */
function applySetSearch(q) {
  q = String(q || '').trim().toLowerCase();
  const onBtn = $('#set-nav .set-nav-btn.on');
  const active = (onBtn && onBtn.dataset.sec) || 'look';
  let total = 0;
  $$('#pane-set .set-sec').forEach(s => {
    let hit = 0;
    Array.from(s.querySelectorAll('.set-group')).forEach(g => {
      let gh = 0;
      Array.from(g.querySelectorAll('.set-row')).forEach(r => {
        const ok = !q || (r.textContent || '').toLowerCase().includes(q);
        r.hidden = q ? !ok : false;
        if (ok) gh++;
      });
      g.hidden = q ? gh === 0 : false;
      hit += gh;
    });
    if (q) { s.classList.toggle('search-on', hit > 0); s.classList.toggle('on', hit > 0); }
    else { s.classList.remove('search-on'); s.classList.toggle('on', s.dataset.sec === active); }
    total += q ? hit : 0;
  });
  const no = $('#set-nohit');
  if (no) no.hidden = !q || total > 0;
}

/** 点分区芯片：清掉搜索，回到正常单分区视图 */
function showSetSec(sec) {
  const si = $('#set-search');
  if (si && si.value) si.value = '';
  $$('#pane-set .set-row').forEach(r => r.hidden = false);
  $$('#pane-set .set-group').forEach(g => g.hidden = false);
  $$('#pane-set .set-sec').forEach(s => {
    s.classList.remove('search-on');
    s.classList.toggle('on', s.dataset.sec === sec);
  });
  const no = $('#set-nohit');
  if (no) no.hidden = true;
}

/* 存储概览（设置 → 数据）：只读，失败就静默留个横杠 */
function fmtSize(b) {
  if (!b && b !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
}
async function loadStats() {
  const put = (id, txt) => { const e = $('#' + id); if (e) e.textContent = txt; };
  try {
    const st = await api('/api/stats');
    put('data-notes', st.notes + ' 篇 · ' + fmtSize(st.notesBytes) + (st.folders ? ' · ' + st.folders + ' 个文件夹' : ''));
    put('data-assets', st.assets + ' 个 · ' + fmtSize(st.assetsBytes));
    put('data-history', st.history + ' 份 · ' + fmtSize(st.historyBytes));
    put('data-trash', st.trash + ' 项 · ' + fmtSize(st.trashBytes));
  } catch (e) {
    ['data-notes', 'data-assets', 'data-history', 'data-trash'].forEach(id => put(id, '—'));
  }
}

function wireSettings() {
  $$('#set-theme button').forEach(b => b.onclick = () => { CFG.theme = b.dataset.v; saveCfg(); applyTheme(); syncSettingsUI(); });
  $$('#set-hl button').forEach(b => b.onclick = () => { CFG.hl = b.dataset.v; saveCfg(); syncSettingsUI(); });
  $$('#set-font button').forEach(b => b.onclick = () => { CFG.font = b.dataset.v; saveCfg(); });
  $$('#set-autosave button').forEach(b => b.onclick = () => { CFG.autosave = b.dataset.v; saveCfg(); });
  $$('#set-tab button').forEach(b => b.onclick = () => { CFG.tab = b.dataset.v; saveCfg(); });
  $$('#set-side button').forEach(b => b.onclick = () => { CFG.side = b.dataset.v; SIDE_W_CFG = true; localStorage.setItem('sj-side-cfg', '1'); saveCfg(); });
  $$('#set-lineh button').forEach(b => b.onclick = () => { CFG.lineh = b.dataset.v; saveCfg(); });
  $$('#set-editfont button').forEach(b => b.onclick = () => { CFG.editfont = b.dataset.v; saveCfg(); });
  const bind = (id, key) => {
    const e = $('#' + id);
    if (e) e.onchange = () => {
      CFG[key] = e.checked; saveCfg();
      if (key === 'outline') setOutline(e.checked);
    };
  };
  bind('set-lineno', 'lineno'); bind('set-wrap', 'wrap');
  bind('set-mathscroll', 'mathscroll'); bind('set-lightbox', 'lightbox');
  bind('set-outline', 'outline');
  bind('set-pasteupload', 'pasteupload');
  const ea = $('#set-export-all');
  if (ea) ea.onclick = () => doExportZip('', true);
  const sk = $('#set-keys');
  if (sk) sk.onclick = () => { el.keysOverlay.hidden = false; };
  bindEl('#set-reset', 'click', () => {
    CFG = Object.assign({}, DEFAULTS);
    saveCfg();
    document.documentElement.style.removeProperty('--side-w');
    localStorage.removeItem('sj-side-w');
    toast('已恢复默认设置');
  });
}

/* ── 编辑器行号 ───────────────────────────────────── */
function refreshLineno() {
  const ln = $('#lineno');
  if (!ln || ln.hidden || !el.editor) return;
  const n = el.editor.value.split('\n').length;
  if (String(n) !== ln.dataset.n) {
    ln.dataset.n = String(n);
    ln.innerHTML = Array.from({ length: n }, (_, i) => '<span>' + (i + 1) + '</span>').join('');
  }
  syncLinenoScroll();
}

function syncLinenoScroll() {
  const ln = $('#lineno');
  if (ln && !ln.hidden && el.editor) ln.scrollTop = el.editor.scrollTop;
}

/* ── 编辑器语法着色：只改字色，背景仍是原来的灰 ──────── */
function esc4hl(t) {
  return t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function hlCode(text) {
  const lines = text.split('\n');
  const out = lines.map(line => {
    // 公式整行 / 行内
    const parts = [];
    let rest = line, guard = 0;
    const re = /(\$\$[^$]*\$\$|\$[^$\n]*\$|`[^`\n]*`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[\[[^\]]+\]\]|!?\[[^\]]*\]\([^)]*\))/g;
    let last = 0, m;
    while ((m = re.exec(rest)) && guard++ < 200) {
      if (m.index > last) parts.push(esc4hl(rest.slice(last, m.index)));
      const t = m[0];
      let cls = 'tk-k';
      if (t.startsWith('$')) cls = 'tk-m';
      else if (t.startsWith('`')) cls = 'tk-c';
      else if (t.startsWith('**') || t.startsWith('*')) cls = 'tk-b';
      else if (t.startsWith('[') || t.startsWith('![') || t.startsWith('[[')) cls = 'tk-l';
      parts.push('<span class="' + cls + '">' + esc4hl(t) + '</span>');
      last = m.index + t.length;
    }
    if (last < rest.length) parts.push(esc4hl(rest.slice(last)));
    let html = parts.join('');
    // 行首记号
    html = html.replace(/^(\s*)(#{1,6})(\s)/, '$1<span class="tk-k">$2</span>$3');
    if (/^\s*#{1,6}\s/.test(line)) html = '<span class="tk-h">' + html + '</span>';
    else if (/^\s*>/.test(line)) html = '<span class="tk-q">' + html + '</span>';
    else if (/^\s*([-*+]|\d+\.)\s/.test(line)) html = '<span class="tk-k">' + html + '</span>';
    return html;
  });
  return out.join('\n') + '\n';
}

function refreshHl() {
  const pre = $('#hl-code');
  const pe = $('.pane-edit');
  if (!pre || !pe || !el.editor) return;
  if (CFG.hl === 'off') { pre.innerHTML = ''; return; }
  pre.innerHTML = hlCode(el.editor.value);
  const layer = $('#hl-layer');
  if (layer) { layer.scrollTop = el.editor.scrollTop; layer.scrollLeft = el.editor.scrollLeft; }
}

/* ══ 右键菜单 ═══════════════════════════════════════ */
let ctxPath = null, _ctxScrollT = 0;
let ctxDir = '';      // 右键落在哪个文件夹（空白处=点中的那一层；null=根）

let ctxKind = 'blank';      // 'doc' | 'dir' | 'blank'，决定显示哪一组菜单

function openCtx(x, y, path, kind) {
  const m = $('#ctxmenu');
  if (!m) return;
  ctxPath = path || null;
  ctxKind = kind || 'blank';
  // 只显示与目标匹配的那一组（参照 Windows 资源管理器）
  $$('#ctxmenu .ctx-group').forEach(g => { g.hidden = g.dataset.for !== ctxKind; });
  // 收藏项显示当前状态（三组各有一个 fav）
  $$('#ctxmenu .ctx-group[data-for="doc"] .ctx-item.star, #ctxmenu .ctx-group[data-for="dir"] .ctx-item.star')
    .forEach(star => {
      const on = !!path && favList().includes(path);
      star.classList.toggle('on', on);
      star.querySelector('span').textContent = on ? '取消收藏' : '收藏';
    });
  m.hidden = false;
  // 先显示再量尺寸，保证贴边时自动收回
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}

function closeCtx() {
  const m = $('#ctxmenu');
  if (m) m.hidden = true;
  ctxPath = null;
}

/* 触屏没有鼠标右键：长按 480ms，在手指位置合成一个 contextmenu 事件，
   文件栏 / 收藏夹 / 大纲原有的右键逻辑原样复用。滚动或移动超过 10px 就放弃。 */
let suppressClick = false;          // 长按菜单弹出后，吞掉紧跟的 click

function touchLongPressMenu() {
  if (!matchMedia('(pointer: coarse)').matches) return;
  document.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); }
  }, true);
  let t = null, x0 = 0, y0 = 0;
  const stop = () => { if (t) { clearTimeout(t); t = null; } };
  document.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return stop();
    const p = e.touches[0]; x0 = p.clientX; y0 = p.clientY;
    stop();
    t = setTimeout(() => {
      t = null;
      const node = document.elementFromPoint(x0, y0);
      if (!node) return;
      suppressClick = true;                       // 长按之后那一下 click 要吞掉，否则会顺手把文件打开
      setTimeout(() => { suppressClick = false; }, 700);
      node.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: x0, clientY: y0, button: 2 }));
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e2) {} }
    }, 480);
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    const p = e.touches[0];
    if (p && (Math.abs(p.clientX - x0) > 10 || Math.abs(p.clientY - y0) > 10)) stop();
  }, { passive: true });
  ['touchend', 'touchcancel'].forEach(ev => document.addEventListener(ev, stop, { passive: true }));
}

function wireCtxMenu() {
  const m = $('#ctxmenu');
  if (!m) return;
  // 在文件树和右侧大纲上右键
  const hook = sel => {
    const root = $(sel);
    if (!root) return;
    root.addEventListener('contextmenu', e => {
      const node = e.target.closest('.node');
      e.preventDefault();
      if (sel === '#outline-list') {
        // 大纲里点标题＝所属笔记；点空白不弹
        if (!node) return;
        openCtx(e.clientX, e.clientY, S.current, 'doc');
        return;
      }
      // 文件树：文件 / 文件夹 / 空白 三种
      if (node && node.classList.contains('dir')) {
        ctxDir = node.dataset.dir || null;      // 新建子文件夹/子文件的落点
        openCtx(e.clientX, e.clientY, node.dataset.dir, 'dir');
        return;
      }
      if (node) {
        const p = node.dataset.doc;             // 树节点用 data-doc，不是 data-path
        if (!p) return;
        ctxDir = node.dataset.of || null;       // 它所在的文件夹
        if (p !== S.current) openDoc(p);
        openCtx(e.clientX, e.clientY, p, 'doc');
        return;
      }
      // 空白：新建 / 重新载入（newdir、newdoc 落在这里记下的目录）
      ctxDir = treeDirAt(e.clientY);
      openCtx(e.clientX, e.clientY, null, 'blank');
    });
  };
  hook('#tree');
  hook('#outline-list');

  m.addEventListener('click', e => {
    e.stopPropagation();                 // 别让全局 click 先把菜单关掉、清空 ctxPath
    const b = e.target.closest('.ctx-item');
    if (!b) return;
    // 路径以「打开菜单时锁定的」为准；若已被清空，回退到当前打开的笔记，
    // 再不行就放弃——绝不能拿 null 去写收藏，否则会存进 [null]。
    const path = ctxPath || S.current;
    const act = b.dataset.act;
    closeCtx();
    if (!path) return toast('先打开一篇笔记');
    if (act === 'fav') { if (!path) return toast('先选中一项'); toast(toggleFav(path) ? '已收藏' : '已取消收藏'); return; }
    if (act === 'rename') doRename(path);
    else if (act === 'export') doExportMd(path);
    else if (act === 'media') openMedia(ctxKind === 'doc' ? path : S.current);
    else if (act === 'imgedit' || act === 'imglib') {
      const ip = imgPathFromSrc(ctxImgSrc);
      if (!ip) return toast('这张图不在笔记库的媒体目录里，没法这样编辑');
      openMedia(S.current, ip, { edit: act === 'imgedit', from: act === 'imgedit' ? 'preview' : 'preview-lib' });
    }
    else if (act === 'imgnew') { try { window.open(ctxImgSrc, '_blank', 'noopener'); } catch (e) {} }
    else if (act === 'history') { if (ctxKind === 'dir') toast('文件夹本身没有历史版本，请对单篇笔记使用'); else doHistory(path); }
    else if (act === 'delete') doDelete(path);
    else if (act === 'newdir') doNewDir(ctxDir || '');
    else if (act === 'newdoc') doNewDoc(ctxDir || '');
    else if (act === 'zip') doExportZip(path);
    else if (act === 'reload') { refreshTree(); toast('已重新载入文件目录'); }
  });
  addEventListener('click', closeCtx);
  // 滚动时收起菜单，但延后一拍：打开菜单那一刻也可能触发一次 scroll，
  // 立刻 closeCtx 会把刚记下的 ctxPath 清掉，导致点了没反应。
  addEventListener('scroll', () => { clearTimeout(_ctxScrollT); _ctxScrollT = setTimeout(closeCtx, 120); }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape') closeCtx(); });
}

/* 空白处右键时，用纵坐标猜落在哪一层文件夹：取该位置以上最近的一条目录边线 */
function treeDirAt(clientY) {
  const dirs = $$('#tree .node.dir');
  let cur = '';
  for (const d of dirs) {
    const r = d.getBoundingClientRect();
    if (r.top + r.height / 2 <= clientY) cur = d.dataset.dir || '';
    else break;
  }
  return cur;
}

/* ══ 竖向导航栏 / 收藏 / 日历 / 折叠 ══════════════════ */
let RAIL = 'tree';

/* ── 侧栏栏目：文件树 / 收藏夹 / 回收站 / 设置 ────────────────
   四个栏目互斥地占用同一块侧栏，宽度一致（--side-w）。
   回收站与设置以前是覆盖全屏的页面，现已改为侧栏栏目。 */
let welcoming = false;              // 欢迎界面是否开着（开着时左栏一个都不点亮）
let PAGE = (function () {           // 刷新后回到上次那个栏目
  try { return localStorage.getItem('sj-page') || 'tree'; } catch (e) { return 'tree'; }
})();
const PANES = ['tree', 'fav', 'trash', 'set'];
const PANE_BOX = { fav: '#pane-fav', trash: '#pane-trash', set: '#pane-set' };

function setSidePane(pane) {
  PAGE = pane;
  try { localStorage.setItem('sj-page', pane); } catch (e) {}
  const sb = el.sidebar;
  if (sb) sb.dataset.pane = pane;
  // 窄屏（≤860px）侧栏是抽屉：切栏目时要把它拉出来，否则切了却看不见
  if (innerWidth <= 860 && sb) {
    if (pane === 'tree') sb.classList.remove('open');
    else sb.classList.add('open');
  }
  PANES.forEach(p => { const b = $('#nav-' + p); if (b) b.classList.toggle('on', !welcoming && p === pane); });
  Object.keys(PANE_BOX).forEach(k => {
    const n = $(PANE_BOX[k]);
    if (n) n.hidden = (k !== pane);
  });
  if (pane === 'fav') openFav();
  else if (pane === 'trash') openTrash();
  else if (pane === 'set') openSettings();
}

function closePages() { setSidePane('tree'); }
function closePanels() { setSidePane('tree'); }

/* ── 收藏（存 localStorage，只存路径）───────────────── */
function favList() {
  try {
    const a = JSON.parse(localStorage.getItem('sj-fav') || '[]');
    return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x) : [];
  } catch (e) { return []; }
}
function isFav(p) { return favList().includes(p); }
function toggleFav(p) {
  if (!p) return false;                 // 绝不把 null 写进收藏列表
  const l = favList();
  const i = l.indexOf(p);
  if (i >= 0) l.splice(i, 1); else l.unshift(p);
  localStorage.setItem('sj-fav', JSON.stringify(l.slice(0, 200)));
  return i < 0;
}
function openFav() {
  const box = $('#fav-list');
  const p = $('#pane-fav');            // 收藏夹现在在侧栏内，不再是独立面板
  if (!box || !p) return;
  const list = favList().filter(x => S.byPath.has(x));
  box.innerHTML = list.length
    ? list.map(x => {
        const n = S.byPath.get(x) || {};
        const label = n.type === 'dir' ? (n.name || x.split('/').pop()) : (n.title || x.split('/').pop());   // 文件夹没有 title，别显示 undefined
        const ic = n.type === 'dir'
          ? '<svg viewBox="0 0 16 16" class="ico fav-ic"><path d="M2 4h4l1.2 1.6H14V13H2z"/></svg>'
          : '<svg viewBox="0 0 16 16" class="ico fav-ic"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>';
        return '<button class="fav-item" data-path="' + esc(x) + '">' + ic +
               '<span class="fi-t">' + esc(label) + '</span>' +
               '<span class="fi-p">' + esc(x) + '</span></button>';
      }).join('')
    : '<div class="empty-hint"><svg viewBox="0 0 16 16" class="ico eh-ic"><path d="M8 2.4l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.1 4.6 12.9l.7-3.8L2.5 6.4l3.8-.5z"/></svg>'
      + '<b>还没有收藏</b><span>在任意一篇上按 <kbd>Ctrl</kbd><kbd>D</kbd></span></div>';
  p.hidden = false;
}
function favClick(e) {
  const b = e.target.closest('.fav-item');
  if (!b) return;
  const n = S.byPath.get(b.dataset.path);
  if (n && n.type === 'dir') {              // 文件夹：切回文件树并展开它
    setSidePane('tree'); S.expanded.add(n.path); renderTree();
    return;
  }
  openDoc(b.dataset.path);
}

/* ── 右侧大纲：显示/收起 ─────────────────────────── */
function syncOutlineTab() {
}

function setOutline(on) {
  jellyPulse();
  // 窄屏：侧栏和大纲互斥，避免两个浮层叠在一起挡住正文
  if (on && innerWidth <= 860) el.sidebar.classList.remove('open');
  if (!on && innerWidth <= 860) el.sidebar.classList.remove('open');
  el.body.classList.toggle('no-outline', !on);
  localStorage.setItem('sj-outline', on ? '1' : '');
  $$('#seg-ol button').forEach(b => {
    const want = b.dataset.ol === '1' ? true : false;
    const on_ = want === !!on;
    b.classList.toggle('on', on_);
    b.setAttribute('aria-pressed', on_ ? 'true' : 'false');
  });
  el.outline.hidden = false;                 // 面板常驻，靠 body.no-outline 控制显隐
  syncOutlineTab();
}

/* ── 笔记树折叠 ───────────────────────────────────── */
/* 收起/展开这类「宽度动画」每帧都要重排整页：单核无 GPU 的机器上一路掉到 12fps。
   jelly-anim 这一段时间里关掉最贵的两件事——磨砂的逐帧重模糊、代码高亮层逐帧重排。
   动画一结束就撤掉，观感几乎无差。 */
function jellyPulse() {
  const root = document.documentElement;
  root.classList.add('jelly-anim');
  clearTimeout(jellyPulse._t);
  jellyPulse._t = setTimeout(() => root.classList.remove('jelly-anim'), 420);
}

function setCollapsed(on) {
  jellyPulse();
  el.body.classList.toggle('collapsed', !!on);
  localStorage.setItem('sj-collapsed', on ? '1' : '');
  // 收起时四个栏目按钮都不高亮；展开时高亮回到当前栏目
  PANES.forEach(p => {
    const b = $('#nav-' + p);
    if (!b) return;
    b.classList.toggle('on', !on && p === PAGE);
    if (p === 'tree') b.title = on ? '展开侧栏（Ctrl+B）' : '收起侧栏（Ctrl+B）';
  });
}

/* ── 拖拽：调整顺序 / 换目录 ─────────────────────── */
let DRAG = null;         // {path, type, from}

/** 落点判定：目录的中间 70% 算「放进去」，上下边缘算「排在前面/后面」 */
function hitMode(node, rel) {
  if (node.classList.contains('dir')) {
    if (rel > 0.15 && rel < 0.85) return 'in';
    return rel <= 0.15 ? 'before' : 'after';
  }
  return rel < 0.5 ? 'before' : 'after';
}

function dropDirOf(node) {
  if (!node) return '';
  // 树是平铺渲染的，没有嵌套 DOM，所以所属目录直接写在 data-of 上
  if (node.classList.contains('dir')) return node.getAttribute('data-of') || '';
  return node.getAttribute('data-of') || '';
}

function wireDrag() {
  el.tree.addEventListener('dragstart', e => {
    const n = e.target.closest('.node.doc, .node.dir');
    if (!n) return;
    DRAG = { path: n.getAttribute('data-doc') || n.getAttribute('data-dir'),
             type: n.classList.contains('dir') ? 'dir' : 'doc',
             node: n };
    n.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', DRAG.path); } catch (err) { /* 某些浏览器要求非空 */ }
  });
  el.tree.addEventListener('dragend', () => {
    if (DRAG && DRAG.node) DRAG.node.classList.remove('dragging');
    el.tree.querySelectorAll('.drop-in, .drop-before').forEach(x => x.classList.remove('drop-in', 'drop-before'));
    DRAG = null;
  });
  el.tree.addEventListener('dragover', e => {
    if (!DRAG) return;
    const n = e.target.closest('.node.doc, .node.dir');
    if (!n || n === DRAG.node) return;
    if (DRAG.type === 'dir' && n.classList.contains('dir') &&
        n.getAttribute('data-dir').startsWith(DRAG.path + '/')) return;   // 不能拖进自己
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = n.getBoundingClientRect();
    const rel = (e.clientY - r.top) / Math.max(1, r.height);   // 0=顶 1=底
    const mode = hitMode(n, rel);
    n.classList.toggle('drop-in', mode === 'in');
    n.classList.toggle('drop-before', mode === 'before');
  });
  el.tree.addEventListener('dragleave', e => {
    const n = e.target.closest('.node.doc, .node.dir');
    if (n) n.classList.remove('drop-in', 'drop-before');
  });
  el.tree.addEventListener('drop', async e => {
    if (!DRAG) return;
    const n = e.target.closest('.node.doc, .node.dir');
    if (!n) return;
    e.preventDefault();
    const src = DRAG.path;
    const r = n.getBoundingClientRect();
    const mode = hitMode(n, (e.clientY - r.top) / Math.max(1, r.height));
    const tgtPath = n.getAttribute('data-doc') || n.getAttribute('data-dir');
    const tgtIsDir = n.classList.contains('dir');
    el.tree.querySelectorAll('.drop-in, .drop-before').forEach(x => x.classList.remove('drop-in', 'drop-before'));
    if (n === DRAG.node || tgtPath === src) return;

    const srcDir = src.split('/').slice(0, -1).join('/');
    const dstDir = mode === 'in' ? tgtPath : dropDirOf(n);
    const dstDirName = ((S.byPath.get(dstDir) || {}).name) || dstDir || '顶层';

    try {
      // ① 换目录
      if (dstDir !== srcDir) {
        if (DRAG.type === 'dir' && (dstDir === src || dstDir.startsWith(src + '/'))) {
          return toast('不能把文件夹挪进它自己里面');
        }
        const r1 = await post('/api/move', { from: src, dir: dstDir });
        if (!r1.ok) return toast('移动失败：' + (r1.error || '未知原因'));
        S.expanded.add(dstDir);
        await loadTree(true);
        return toast('已移到「' + dstDirName + '」');
      }
      // ② 同目录内换序
      if (mode === 'in') return toast('已经在「' + dstDirName + '」里了');
      const rows = Array.from(el.tree.querySelectorAll('.node.doc, .node.dir'))
        .filter(x => dropDirOf(x) === dstDir);
      // 目录没展开时，把它里面的笔记补进来，否则顺序会漏
      const known = new Set(rows.map(x => (x.getAttribute('data-doc') || x.getAttribute('data-dir')).split('/').pop()));
      const add = [];
      const collect = nodes => nodes.forEach(c => {
        const nm = c.name;
        if (!known.has(nm) && c.path.split('/').slice(0, -1).join('/') === dstDir) { known.add(nm); add.push(nm); }
        if (c.type === 'dir') collect(c.children || []);
      });
      collect(S.tree);
      const names = rows.map(x => (x.getAttribute('data-doc') || x.getAttribute('data-dir')).split('/').pop())
        .concat(add.filter(nm => !nm.startsWith('.')));
      const from = names.indexOf(src.split('/').pop());
      let to = names.indexOf(tgtPath.split('/').pop());
      if (from < 0 || to < 0 || from === to) return;
      to += (mode === 'before') ? 0 : 1;
      if (mode === 'after' && to > from) to -= 1;
      if (to < 0 || to >= names.length + 1) return;
      names.splice(to, 0, names.splice(from, 1)[0]);
      const r2 = await post('/api/reorder', { dir: dstDir, names: names });
      if (!r2.ok) return toast('排序没保存上：' + (r2.error || ''));
      await loadTree(true);
      toast('顺序已保存');
    } catch (err) { toast('移动失败：' + err.message); }
  });
}

/* ── 回收站 ─────────────────────────────────────── */
async function openTrash() {
  let r;
  try { r = await get('/api/trash'); }
  catch (e) { window.__e && window.__e.push('回收站：' + e.message); return toast('回收站打不开：' + e.message); }
  const items = r.items || [];
  const box = $('#trash-cards'), hint = $('#trash-empty-hint'), cnt = $('#trash-n');
  if (box) box.innerHTML = items.map(it => `
      <div class="trash-card" data-name="${esc(it.name)}">
        <div class="tc-h">
          <svg viewBox="0 0 16 16" class="ico tc-i"><path d="${it.is_dir ? 'M2 4h4l1.2 1.6H14V13H2z' : 'M4 2h5l3 3v9H4z M9 2v3h3'}"/></svg>
          <div class="tc-t">${esc(it.orig)}</div>
        </div>
        <div class="tc-m">${it.is_dir ? '文件夹' : (it.size / 1024).toFixed(1) + ' KB'} · ${timeAgo(it.mtime)}</div>
        <div class="tc-a">
          <button data-act="restore"><svg viewBox="0 0 16 16" class="ico"><path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M3 3.6V7h3.4"/></svg>还原</button>
          <button class="del" data-act="purge"><svg viewBox="0 0 16 16" class="ico"><path d="M4 4l8 8M12 4l-8 8"/></svg>彻底删</button>
        </div>
      </div>`).join('');
  if (hint) hint.hidden = items.length > 0;
  if (cnt) cnt.textContent = items.length ? items.length + ' 项' : '';
  const dot = $('#trash-dot');
  if (dot) dot.hidden = items.length === 0;
  const ea = $('#trash-empty');
  if (ea) ea.disabled = !items.length;
  const ra = $('#trash-restore-all');
  if (ra) ra.disabled = !items.length;
}

function timeAgo(ts) {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
  return new Date(ts * 1000).toLocaleDateString('zh-CN');
}

async function doMkdir() {
  const name = await ask('新建文件夹名字', '新建文件夹');
  if (!name) return;
  const dir = S.current ? S.current.split('/').slice(0, -1).join('/')
            : (el.filter.value.trim() ? null : '');
  if (dir === null) return toast('搜索状态下没法确定放在哪，先选中一篇笔记或在清空搜索后新建');
  const r = await post('/api/mkdir', { dir: dir || '', name: name });
  if (r.ok) { S.expanded.add(r.path); await loadTree(true); toast('已新建文件夹「' + r.name + '」'); }
}

async function doTrashAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.trash-card');
  if (!card) return;
  const name = card.dataset.name;
  const act = btn.dataset.act;
  if (act === 'restore') {
    const r = await post('/api/restore', { name: name });
    if (r.ok) {
      await loadTree(true);
      await openTrash();               // 还原后刷新回收站列表（之前卡片会留在原地）
      toast('已还原：' + (r.path || ''));
    } else toast('还原失败：' + (r.error || ''));
  } else if (act === 'purge') {
    const t = await ask('彻底删除后找不回来了，输入 DEL 确认', '', '彻底删除');
    if (t !== 'DEL') return;
    await post('/api/purge', { name: name });
    await openTrash();
    toast('已彻底删除');
  }
}

async function doTrashEmpty() {
  const t = await ask('清空回收站后找不回来了，输入 DEL 确认', '', '清空回收站');
  if (t !== 'DEL') return;
  await post('/api/trash/empty', {});
  await openTrash();
  toast('回收站已清空');
}

function indexTree() {
  S.byPath.clear();
  const walk = nodes => nodes.forEach(n => { S.byPath.set(n.path, n); if (n.children) walk(n.children); });
  walk(S.tree);
}

async function loadTree(keepOpen) {
  const data = await api('/api/tree');
  S.tree = data.tree || [];
  indexTree();
  if (!keepOpen && !localStorage.getItem('sj-open')) {
    // 默认展开第一层目录
    S.tree.forEach(n => { if (n.type === 'dir') S.expanded.add(n.path); });
  }
  renderTree();
}

/* 重新载入：树 + 当前笔记（服务器上被外部改动时用） */
async function refreshTree() {
  const cur = S.current;
  await loadTree(true);
  if (cur && S.byPath.has(cur)) {
    if (!S.dirty) await openDoc(cur, { force: true });
  } else if (cur) {
    S.current = null; S.body = ''; el.editor.value = '';
    el.preview.innerHTML = '';
  }
}

/* ══ 账号 ═══════════════════════════════════════════════ */


/* ══ 用户设置弹窗（头像 / 用户名 / 密码）════════════════════
   入口：右上角用户菜单第一项「用户设置」。
   头像复用 /api/avatar、/api/avatar/clear，密码复用 /api/password，
   改用户名用 /api/username（要带当前密码）。保存一次性提交，空着的项不动。
   用户名的口径：它既是登录名，也是界面上显示的名字 —— 没有单独的「显示名称」。 */

function refreshAcctAvatar() {
  const box = $('#acct-avatar');
  if (!box) return;
  const first = ((ME && ME.user) || localStorage.getItem('sj-user') || '素').trim().charAt(0).toUpperCase();
  box.style.backgroundImage = '';
  box.textContent = first;
  fetch('/api/avatar?v=' + Date.now(), { credentials: 'same-origin' })
    .then(r => { if (!r.ok) throw new Error('none'); return r.blob(); })
    .then(blob => {
      const u = URL.createObjectURL(blob);
      box.style.backgroundImage = 'url("' + u + '")';
      box.style.backgroundSize = 'cover';
      box.style.backgroundPosition = 'center';
      box.textContent = '';
    })
    .catch(() => { box.style.backgroundImage = ''; box.textContent = first; });
}

function openAcct() {
  el.userMenu.hidden = true;
  $('#acct-overlay').hidden = false;
  const must = $('#acct-must'), cancel = $('#acct-cancel');
  if (must) must.hidden = !MUST_CHANGE;
  if (cancel) cancel.hidden = MUST_CHANGE;         // 强制改资料时不给取消
  $('#acct-user').value = (ME && ME.user) || '';
  $('#acct-old').value = '';
  $('#acct-new').value = '';
  $('#acct-new2').value = '';
  $('#acct-err').textContent = '';
  refreshAcctAvatar();
  // 触屏设备不自动聚焦：一聚焦就弹系统键盘，把弹窗顶掉一半
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => { const f = $('#acct-user'); if (f) f.focus(); }, 40);
}

async function submitAcct(ev) {
  ev.preventDefault();
  const err = $('#acct-err');
  err.textContent = '';
  const uname = $('#acct-user').value.trim();
  const oldPw = $('#acct-old').value, newPw = $('#acct-new').value, newPw2 = $('#acct-new2').value;
  if (!/^[\w.\-]{2,32}$/.test(uname)) { err.textContent = '用户名要 2-32 位，中英文数字或 _ . -，不能有空格'; return; }
  if (uname !== ((ME && ME.user) || '') && !oldPw) { err.textContent = '改用户名要填当前密码'; return; }
  if (oldPw || newPw || newPw2) {
    if (!oldPw) { err.textContent = '改密码要填当前密码'; return; }
    if (newPw !== newPw2) { err.textContent = '两次输入的新密码不一致'; return; }
    if (newPw.length < 6) { err.textContent = '新密码至少 6 位'; return; }
  }
  const btn = $('#acct-form button[type=submit]');
  btn.disabled = true;
  try {
    if (uname !== ((ME && ME.user) || '')) {
      const r = await post('/api/username', { username: uname, old: oldPw });
      ME.user = r.user || uname;
      ME.display = ME.user;
      localStorage.setItem('sj-user', ME.user);
    }
    if (newPw) await post('/api/password', { old: oldPw, new: newPw });
    applyMe();
    if (MUST_CHANGE) {
      const m2 = await api('/api/me');               // 服务端说了算：两项都改掉才算完
      MUST_CHANGE = !!m2.must_change;
      if (MUST_CHANGE) { err.textContent = '用户名和密码都要改掉，保存后才算完成'; return; }
      const cancel = $('#acct-cancel'); if (cancel) cancel.hidden = false;
      const must = $('#acct-must'); if (must) must.hidden = true;
      $('#acct-overlay').hidden = true;              // 改完就关掉，不用再点一次 Esc
      toast('资料已改好，可以开始用了');
      return;
    }
    $('#acct-overlay').hidden = true;
    toast(newPw ? '资料与密码已保存' : '资料已保存');
  } catch (e) {
    err.textContent = e.message || '保存失败';
  } finally { btn.disabled = false; }
}

function wireAcct() {
  bindEl('#mi-settings', 'click', openAcct);
  bindEl('#acct-cancel', 'click', () => { if (!MUST_CHANGE) $('#acct-overlay').hidden = true; });
  bindEl('#acct-pick', 'click', () => $('#acct-file').click());
  bindEl('#acct-clear', 'click', async () => {
    try { await post('/api/avatar/clear', {}); refreshAcctAvatar(); refreshAvatar(); toast('已恢复默认头像'); }
    catch (e) { toast('失败：' + e.message); }
  });
  const ov = $('#acct-overlay');
  ov.addEventListener('click', e => { if (e.target === ov && !MUST_CHANGE) ov.hidden = true; });
  $('#acct-form').addEventListener('submit', submitAcct);
  $('#acct-file').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try { await post('/api/avatar', { data: await fileToB64(f) }); refreshAcctAvatar(); refreshAvatar(); toast('头像已更新'); }
    catch (err) { toast('上传失败：' + err.message); }
    e.target.value = '';
  });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !ov.hidden && !MUST_CHANGE) ov.hidden = true; });
}

/* ══ 渲染后处理：大纲、目录跳转、滚动定位 ═══════════════════ */
function normTitle(t) {
  return String(t || '').replace(/\s+/g, '').replace(/[：:、。，,.．·—\-]/g, '').toLowerCase();
}

function afterRender() {
  const box = el.preview;
  const hs = Array.from(box.querySelectorAll('h1,h2,h3,h4,h5,h6'));

  // 目录里那些纯文字的条目，能对上标题的就做成可点跳转
  const byText = new Map(hs.map(h => [normTitle(h.textContent), h]));
  box.querySelectorAll('li').forEach(li => {
    if (li.querySelector('a')) return;
    const t = normTitle(li.textContent);
    if (!t || t.length < 2) return;
    let target = byText.get(t);
    if (!target) {
      for (const pair of byText) {
        const k = pair[0];
        if (k.length > 2 && (k.startsWith(t) || t.startsWith(k))) { target = pair[1]; break; }
      }
    }
    if (target) {
      const a = document.createElement('a');
      a.href = '#' + target.id;
      a.className = 'toc-jump';
      while (li.firstChild) a.appendChild(li.firstChild);
      li.appendChild(a);
    }
  });

  // 大纲面板
  const list = $('#outline-list');
  if (list) {
    list.innerHTML = OUTLINE.length
      ? OUTLINE.map(h => {
          const pad = 8 + (h.level - 1) * 10;
          return '<a class="ol-item lv' + h.level + '" href="#' + h.id + '" data-id="' + h.id +
                 '" style="padding-left:' + pad + 'px"><span class="ol-t">' +
                 esc(h.text).slice(0, 90) + '</span></a>';
        }).join('')
      : '<div class="empty-hint">这篇没有标题</div>';
    const n = $('#ol-count');
    if (n) n.textContent = OUTLINE.length ? OUTLINE.length + ' 节' : '';
    const oe = $('#ol-empty');
    if (oe) oe.hidden = OUTLINE.length > 0;
  }
  spyHeadings(hs);
  linkNoteTitles();
  if (S.hit) highlightTerm(S.hit);
}

/** 正文里出现的其它笔记名，做成可点跳转（方便顺着「相关笔记」走） */
function linkNoteTitles() {
  const titles = [];
  const firstInDir = new Map();                 // 目录名 -> 该目录第一篇
  S.byPath.forEach((n, path) => {
    if (n.type === 'doc' && path !== S.current && n.title && n.title.trim().length >= 3) {
      titles.push({ title: n.title.trim(), path: path });
      const dir = path.split('/')[0];
      if (dir && path.includes('/') && !firstInDir.has(dir)) firstInDir.set(dir, path);
      if (n.title === path.split('/').pop().replace(/\.md$/, '')) { /* 无标题页 */ }
    }
  });
  // 科目目录名也能点（例如正文里写「理论力学」→ 跳到该科笔记）
  firstInDir.forEach((path, dir) => {
    if (dir && dir.length >= 2 && !dir.startsWith('.') && dir !== (S.current || '').split('/')[0]) {
      titles.push({ title: dir, path: path });
    }
  });
  if (!titles.length) return;
  titles.sort((a, b) => b.title.length - a.title.length);      // 长标题优先，避免嵌套误配

  const box = el.preview;
  const skipTags = new Set(['CODE', 'PRE', 'A', 'SCRIPT', 'STYLE', 'MARK', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || n.nodeValue.length < 3) return NodeFilter.FILTER_REJECT;
      let p = n.parentElement;
      while (p && p !== box) {
        if (skipTags.has(p.tagName) || p.classList.contains('katex') || p.classList.contains('katex-display')) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentElement;
      }
      return titles.some(t => n.nodeValue.includes(t.title))
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  nodes.forEach(node => {
    let text = node.nodeValue, changed = false;
    const frag = document.createDocumentFragment();
    let guard = 0;
    while (text.length && guard++ < 200) {
      let hit = null;
      for (const t of titles) {
        const k = text.indexOf(t.title);
        if (k !== -1 && (!hit || k < hit.k)) hit = { k: k, t: t };
      }
      if (!hit) break;
      if (hit.k > 0) frag.appendChild(document.createTextNode(text.slice(0, hit.k)));
      const a = document.createElement('a');
      a.className = 'note-link';
      a.href = '#';
      a.dataset.note = hit.t.path;
      a.textContent = hit.t.title;
      a.title = '打开：' + hit.t.path;
      frag.appendChild(a);
      text = text.slice(hit.k + hit.t.title.length);
      changed = true;
    }
    if (changed) {
      if (text) frag.appendChild(document.createTextNode(text));
      node.parentNode.replaceChild(frag, node);
    }
  });
}

/** 在预览里把搜索词标黄（跳过公式与代码内部，免得破坏排版） */
function highlightTerm(term) {
  const t = String(term || '').trim();
  if (t.length < 2) return;
  const box = el.preview;
  const skip = new Set(['SCRIPT', 'STYLE', 'MARK']);
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      let p = n.parentElement;
      while (p && p !== box) {
        if (skip.has(p.tagName) || p.classList.contains('katex') || p.classList.contains('katex-display')) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentElement;
      }
      return n.nodeValue.toLowerCase().includes(t.toLowerCase())
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  const lower = t.toLowerCase();
  let first = null;
  targets.slice(0, 400).forEach(node => {
    const text = node.nodeValue, lowText = text.toLowerCase();
    if (!lowText.includes(lower)) return;
    const frag = document.createDocumentFragment();
    let i = 0, k;
    while ((k = lowText.indexOf(lower, i)) !== -1) {
      if (k > i) frag.appendChild(document.createTextNode(text.slice(i, k)));
      const mk = document.createElement('mark');
      mk.textContent = text.slice(k, k + t.length);
      frag.appendChild(mk);
      if (!first) first = mk;
      i = k + t.length;
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    node.parentNode.replaceChild(frag, node);
  });
  if (first) {
    const box2 = el.preview;
    box2.scrollTo({ top: Math.max(0, first.offsetTop - box2.offsetTop - 60), behavior: 'smooth' });
  }
}

/** 预览滚动时高亮当前所在标题 */
function spyHeadings(hs) {
  const box = el.preview;
  const upd = () => {
    if (!hs.length) return;
    if (Date.now() < _olJump) return;          // 刚点过大纲：这段时间听点击的，别抢
    // 阈值要比滚动锁定的 16px 留白大一点，否则「滚到的那一标题」反而不高亮
    const top = box.getBoundingClientRect().top + 48;
    let cur = hs[0];
    for (const h of hs) { if (h.getBoundingClientRect().top <= top) cur = h; else break; }
    $$('#outline-list .ol-item').forEach(a => a.classList.toggle('on', a.dataset.id === cur.id));
  };
  if (box._spy) box.removeEventListener('scroll', box._spy);
  box._spy = upd;
  box.addEventListener('scroll', upd, { passive: true });
  upd();
}


/* ══ 正文两栏 / 大纲 滚动锁定 ══════════════════════════════
   只按百分比同步，碰上长插图 / 长代码块会越滚越偏；
   这里拿标题在源码里的行号当锚点，段内按行号线性插值。 */
let _scrollBy = 0;                       // 0 空闲 / 1 编辑器驱动 / 2 预览驱动
function _lockWho(who) { _scrollBy = who; clearTimeout(_lockT); _lockT = setTimeout(() => { _scrollBy = 0; }, 60); }
let _lockT = 0;
function _edMetrics() {
  const cs = getComputedStyle(el.editor);
  return { lh: parseFloat(cs.lineHeight) || 24, pad: parseFloat(cs.paddingTop) || 0 };
}
function _anchors() {
  const out = [];
  (OUTLINE || []).forEach(h => {
    if (typeof h.line !== 'number') return;
    const e = document.getElementById(h.id);
    if (e) out.push({ line: h.line, y: e.offsetTop });
  });
  out.sort((a, b) => a.line - b.line);
  return out;
}
function _pick(list, val, key) {         // 返回夹住 val 的 [低, 高]（高可能为 null）
  let lo = { line: 0, y: 0 }, hi = null;
  for (const a of list) { if (a[key] <= val) lo = a; else { hi = a; break; } }
  return [lo, hi];
}
function syncFromEditor() {
  if (S.view !== 'split' || _scrollBy === 2) return;
  if (Date.now() < _olJump) return;          // 跳转滑动期间：编辑器不反向驱动
  _lockWho(1);
  const box = el.preview, m = _edMetrics();
  const total = (el.editor.value || '').split('\n').length || 1;
  const line = Math.max(0, (el.editor.scrollTop - m.pad) / m.lh);
  const A = _anchors();
  const maxP = Math.max(0, box.scrollHeight - box.clientHeight);
  let y;
  if (A.length >= 2) {
    const [lo, hi] = _pick(A, line, 'line');
    if (hi) { const f = (line - lo.line) / Math.max(1, hi.line - lo.line); y = lo.y + f * (hi.y - lo.y); }
    else { const f = Math.min(1, (line - lo.line) / Math.max(1, total - lo.line));
           y = lo.y + f * Math.max(0, box.scrollHeight - lo.y - box.clientHeight * 0.6); }
  } else { y = (line / total) * box.scrollHeight; }
  box.scrollTop = Math.max(0, Math.min(maxP, y - 16));
}
function syncFromPreview() {
  if (S.view !== 'split' || _scrollBy === 1) return;
  if (_olJump && Date.now() < _olJump) _olJump = Date.now() + 420;   // 滑动还没停：继续保护
  _lockWho(2);
  const box = el.preview, m = _edMetrics();
  const total = (el.editor.value || '').split('\n').length || 1;
  const y = box.scrollTop + 16;
  const A = _anchors();
  let line;
  if (A.length >= 2) {
    const [lo, hi] = _pick(A, y, 'y');
    if (hi) { const f = hi.y === lo.y ? 0 : (y - lo.y) / (hi.y - lo.y); line = lo.line + f * (hi.line - lo.line); }
    else { const rest = Math.max(1, box.scrollHeight - lo.y);
           line = lo.line + Math.min(1, (y - lo.y) / rest) * Math.max(1, total - lo.line); }
  } else { line = (y / Math.max(1, box.scrollHeight)) * total; }
  el.editor.scrollTop = Math.max(0, m.pad + line * m.lh - 8);
}

/* 点大纲是一次「有主」的滚动：这期间只许预览带动编辑器，不许编辑器反过来把预览拽走
   （来回插值本身有误差，互相拽一次就偏几十像素——「错位」就是这么来的）。
   _olJump 是个截止时间戳：滑动期间不断续期，停稳 0.4 秒后自动恢复双向跟随。 */
let _olJump = 0;
function jumpToHeading(id) {
  const h = document.getElementById(id);
  if (!h) return;
  const box = el.preview;
  // 用视口矩形换算：h.offsetTop 的参照物（offsetParent）一变，位置就偏，这就是「错位」的来源
  const top = h.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  box.scrollTo({ top: Math.max(0, top - 16), behavior: 'smooth' });
  h.classList.remove('flash'); void h.offsetWidth; h.classList.add('flash');
  $$('#outline-list .ol-item').forEach(a => a.classList.toggle('on', a.dataset.id === id));
  _olJump = Date.now() + 420;
}


/* ══ 欢迎界面 ═════════════════════════════════════════════
   点左上角 logo、或刚登录时出现；盖住文件栏 + 正文 + 大纲。 */
function recentList() { try { return JSON.parse(localStorage.getItem('sj-recent') || '[]'); } catch (e) { return []; } }
function pushRecent(p) {
  if (!p) return;
  const l = recentList().filter(x => x !== p);
  l.unshift(p);
  try { localStorage.setItem('sj-recent', JSON.stringify(l.slice(0, 8))); } catch (e) {}
}
function setWelcome(on) {
  welcoming = !!on;
  try { localStorage.setItem('sj-welcome', on ? '1' : '0'); } catch (e) {}
  PANES.forEach(p => { const b = $('#nav-' + p); if (b) b.classList.toggle('on', !on && p === PAGE); });
  const w = $('#welcome');
  if (!w) return;
  if (on) { drawWelcome(); w.hidden = false; }
  else { w.hidden = true; }
  // 欢迎页是一块「分栏」：开着的时候把文件栏 / 正文栏 / 大纲栏整个让出来
  document.body.classList.toggle('welcoming', !!on);
}
function drawWelcome() {
  const ver = $('#wc-ver'); if (ver) ver.textContent = 'v' + (typeof APP_VER !== 'undefined' ? APP_VER : '0.1.0');
  const lg = $('#wc-logo');
  if (lg) lg.src = CFG.logoUrl || '/sujot-logo-104.png?v=5';
  const cnt = $('#wc-count');
  if (cnt) {
    const docs = flatten(S.tree).filter(([n]) => n.type === 'doc').length;
    cnt.textContent = docs ? '共 ' + docs + ' 篇笔记' : '';
  }
  const box = $('#wc-recent');
  if (!box) return;
  const list = recentList().filter(p => S.byPath.has(p)).slice(0, 6);
  box.innerHTML = list.length
    ? list.map(p => {
        const n = S.byPath.get(p) || {};
        const t = n.title || p.split('/').pop().replace(/\.md$/i, '');
        return '<button class="wc-note" data-path="' + esc(p) + '"><b>' + esc(t) + '</b><span>' + esc(p) + '</span></button>';
      }).join('')
    : '<div class="wc-none">还没有打开过笔记</div>';
}

/* ══ 打开 / 保存 ════════════════════════════════════════ */
async function openDoc(path, opts = {}) {
  S.hit = opts.hit || '';
  if (S.dirty && !opts.force) await save({ silent: true });
  const d = await api('/api/doc?path=' + encodeURIComponent(path));
  S.current = d.path; S.front = d.front; S.body = d.body; S.dirty = false;
  pushRecent(d.path); setWelcome(false);
  // 展开所在目录，免得找不到自己在哪
  const segs = d.path.split('/'); let acc = '';
  for (let k = 0; k < segs.length - 1; k++) { acc = acc ? acc + '/' + segs[k] : segs[k]; S.expanded.add(acc); }
  el.editor.value = d.body;
  el.stPath.textContent = d.path;
  el.stSaved.textContent = fmtTime(d.mtime);
  render();
  setSaveState('idle');
  refreshLineno(); refreshHl();
  localStorage.setItem('sj-open', d.path);
  renderTree();
  if (innerWidth <= 860) el.sidebar.classList.remove('open');
  el.editor.scrollTop = 0; el.preview.scrollTop = 0;
}

function render() {
  const src = S.body || '';
  try {
    el.preview.innerHTML = md(src);
  } catch (err) {
    console.error('预览渲染失败', err);
    el.preview.innerHTML = '<p class="muted">预览渲染出错：' + esc(err.message) + '</p>' +
      '<pre><code>' + esc(src.slice(0, 4000)) + '</code></pre>';
  }
  const n = src.replace(/\s/g, '').length;
  el.stWords.textContent = n.toLocaleString('zh-CN') + ' 字';
  /* 空态已由欢迎界面接管 */
  try { afterRender(); } catch (e) { console.error('后处理失败', e); }
  try { queueKatex(); } catch (e) { console.error('公式渲染失败', e); }
}

function setSaveState(s, extra) {
  const txt = { idle: '已保存', dirty: '未保存', saving: '保存中…', saved: '已保存', error: '保存失败' }[s] || s;
  el.saveState.textContent = extra || txt;
  el.saveState.dataset.s = s;
}

async function save(opts = {}) {
  if (!S.current) return;
  S.dirty = false;
  setSaveState('saving');
  try {
    const r = await post('/api/save', { path: S.current, body: el.editor.value, front: S.front });
    S.body = el.editor.value;
    el.stSaved.textContent = fmtTime(r.mtime);
    setSaveState('saved');
    const node = S.byPath.get(S.current);
    if (node) { node.mtime = r.mtime; node.size = (el.editor.value || '').length; }
    localStorage.setItem('sj-open', S.current);
    if (!opts.silent) toast('已保存');
    setTimeout(() => { if (!S.dirty) setSaveState('idle'); }, 1600);
  } catch (e) {
    setSaveState('error');
    toast(e.message || '保存失败');
  }
}

let _autoSaveFn = null;
function autoSave() {
  if (!_autoSaveFn) _autoSaveFn = debounce(() => { if (S.dirty) save({ silent: true }); }, 2500);
  if (!AUTOSAVE_MS) return;                 // 设置里关了自动保存
  _autoSaveFn();
}
function rebuildAutoSave() {
  _autoSaveFn = debounce(() => { if (S.dirty) save({ silent: true }); }, AUTOSAVE_MS || 2500);
}

/** 预览渲染节流：连续敲字时只在停手后重排一次，长笔记也不卡 */
let _raf = null, _renderPending = false;
function renderSoon() {
  if (_renderPending) return;
  _renderPending = true;
  _raf = setTimeout(() => {
    _renderPending = false;
    if (window.requestIdleCallback) requestIdleCallback(() => render(), { timeout: 200 });
    else render();
  }, 130);
}

/* ══ 搜索 ═══════════════════════════════════════════════ */
function openSearch() {
  el.searchOverlay.hidden = false;
  el.q.value = ''; el.results.innerHTML = '<div class="empty-hint">输入关键词，回车打开第一条</div>';
  setTimeout(() => el.q.focus(), 30);
}
function closeSearch() { el.searchOverlay.hidden = true; }

const runSearch = debounce(async () => {
  const q = el.q.value.trim();
  if (!q) { el.results.innerHTML = '<div class="empty-hint">输入关键词</div>'; return; }
  el.results.innerHTML = '<div class="empty-hint">搜索中…</div>';
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    const hits = r.results || [];
    if (!hits.length) { el.results.innerHTML = '<div class="empty-hint">没有找到「' + esc(q) + '」</div>'; return; }
    el.results.innerHTML = hits.map((h, i) => `<div class="hit${i === 0 ? ' on' : ''}" data-doc="${esc(h.path)}">
      <div class="t">${esc(h.title)}</div><div class="p">${esc(h.path)}</div>
      <div class="s">${h.snippet.map(s => esc(s).replace(new RegExp('(' + esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>')).join(' … ')}</div>
    </div>`).join('');
  } catch (e) { el.results.innerHTML = '<div class="empty-hint">搜索失败：' + esc(e.message) + '</div>'; }
}, 220);


/** 安全绑定：元素不存在时跳过，不拖垮整个启动流程 */
function on(sel, type, fn) {
  const e = $(sel);
  if (e && e.addEventListener) e.addEventListener(type, fn);
}

/* ══ 拖拽性能 ═══════════════════════════════════════════
   之前三处拖拽（侧栏宽 / 大纲宽 / 分栏）都在每个 mousemove 里直接改
   CSS 变量或 style.flex，导致每移动 1px 就整页同步重排——预览里几千个
   KaTeX 节点全要重新布局，所以「很卡」。
   现在统一：pointer 事件 + rAF 每帧只写一次 + 拖拽期加 .dragging
   让浏览器跳过重活（contain / content-visibility），松手后一次性收尾。 */
let _dragCtx = null;
/* _dragCtx 里同时记着「这一根拖拽要动哪里（apply）」和「松手要存什么（end）」。
   全局只注册一组 pointermove / up / cancel 监听（见 bind），谁按下的就听谁的。
   曾经的坑：每根 grip 各自挂 window 监听、共用同一个 rAF 去重位，注册最早的
   大纲监听永远抢先调度 —— 拖任何一根动的都是大纲宽。 */
function beginDrag(e, apply, end) {
  if (_dragCtx) return _dragCtx;
  document.documentElement.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  /* 高亮只给按下的这根把手：以前靠 html.dragging 一起点亮，拖一根别的栏也跟着冒亮条 */
  const grip = e && e.currentTarget && e.currentTarget.classList ? e.currentTarget : null;
  if (grip) grip.classList.add('dg');
  _dragCtx = { x: e.clientX, raf: 0, apply: apply || null, end: end || null, grip: grip };
  return _dragCtx;
}
function dragMove(e) {
  const c = _dragCtx;
  if (!c) return;
  c.x = e.clientX;
  if (c.raf) return;
  c.raf = requestAnimationFrame(() => { c.raf = 0; if (c.apply) c.apply(c.x); });
}
function endDrag() {
  const c = _dragCtx;
  if (!c) return;
  if (c.raf) { cancelAnimationFrame(c.raf); c.raf = 0; if (c.apply) c.apply(c.x); }   // 冲掉最后一帧，落盘的值才准
  if (c.end) c.end();
  if (c.grip) c.grip.classList.remove('dg');
  document.documentElement.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  _dragCtx = null;
}

/* ══ 覆盖面板通用 ══════════════════════════════════════ */
let promptResolve = null;
function ask(title, value = '', okLabel = '确定') {
  el.promptOverlay.hidden = false;
  promptConfirm = false;
  el.promptInput.value = value;
  el.promptInput.placeholder = title;
  const btn = $('#prompt-form .accent'); if (btn) btn.textContent = okLabel;
  setTimeout(() => { el.promptInput.focus(); el.promptInput.select(); }, 30);
  return new Promise(res => { promptResolve = res; });
}
/* 是/否确认：复用弹窗。提交时回传的是按钮文案（okLabel），
   输入框只读、内容为空 —— 旧版直接取输入框内容（''），永远等于不了 okLabel，
   于是「移动至回收站」点了等于没点。 */
let promptConfirm = false;
function confirm(title, okLabel = '确定') {
  el.promptOverlay.hidden = false;
  el.promptInput.value = '';
  el.promptInput.placeholder = title;
  el.promptInput.setAttribute('readonly', '');
  promptConfirm = true;
  const btn = $('#prompt-form .accent'); if (btn) btn.textContent = okLabel;
  setTimeout(() => { const f = $('#prompt-form .ghost'); if (f) f.focus(); }, 30);
  return new Promise(res => { promptResolve = res; }).then(v => { el.promptInput.removeAttribute('readonly'); promptConfirm = false; return v === okLabel; });
}
function closeAsk(v) { el.promptOverlay.hidden = true; const r = promptResolve; promptResolve = null; if (r) r(v); }

function toast(msg) {
  el.toast.textContent = msg; el.toast.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

/* ══ 事件绑定 ═══════════════════════════════════════════ */
/** 记录启动期错误，界面上看得见 */
window.__bindErr = [];
function bind() {
  window.__L = n => { window.__lastLine = n; }; window.__t = performance.now();
  // 树
  el.tree.addEventListener('click', e => { const dir = e.target.closest('[data-dir]');
    if (dir) { const p = dir.dataset.dir; S.expanded.has(p) ? S.expanded.delete(p) : S.expanded.add(p); renderTree(); return;
    } const doc = e.target.closest('[data-doc]'); if (doc) openDoc(doc.dataset.doc);
  }); el.filter.addEventListener('input', debounce(() => doSearch(el.filter.value.trim()), 200)); wireScope();
  const nb = $('#side-new');
  if (nb) nb.addEventListener('click', () => doNew());
  const nbd = $('#side-newdir');
  if (nbd) nbd.addEventListener('click', () => doNewDir(''));


  // 编辑器
  el.editor.addEventListener('input', () => { S.body = el.editor.value; if (!S.dirty) setSaveState('dirty'); S.dirty = true; renderSoon(); autoSave(); refreshLineno(); refreshHl();
  }); el.editor.addEventListener('scroll', () => { syncLinenoScroll(); refreshHl(); });
  el.editor.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); const s = el.editor.selectionStart, t = el.editor.value; const pad = ' '.repeat(TAB_SPACES); el.editor.value = t.slice(0, s) + pad + t.slice(el.editor.selectionEnd); el.editor.selectionStart = el.editor.selectionEnd = s + TAB_SPACES; el.editor.dispatchEvent(new Event('input'));
    }
  });
  el.editor.addEventListener('scroll', syncFromEditor, { passive: true });
  el.preview.addEventListener('scroll', syncFromPreview, { passive: true });
  // 粘贴图片直接上传
  el.editor.addEventListener('paste', e => { if (!CFG.pasteupload) return;
    const items = (e.clipboardData && e.clipboardData.files) || [];
    if (Array.from(items).some(f => /^image\//.test(f.type))) { e.preventDefault(); handleFiles(items);
    }
  });
  // 拖图片进来
  el.editor.addEventListener('dragover', e => { if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  el.editor.addEventListener('drop', e => { const files = e.dataTransfer && e.dataTransfer.files; if (files && Array.from(files).some(f => /^image\//.test(f.type))) { e.preventDefault(); handleFiles(files); }
  });
  // 工具栏「插图」
  $('#file-input').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });

  // 工具栏
  bindEl('#btn-save', 'click', () => save());
  bindEl('#btn-new', 'click', doNew);
  bindEl('#btn-newdir', 'click', doMkdir);
  wireDrag();
  $('#btn-theme').onclick = () => {                     // 只做深 ⇄ 浅，不再有「跟随系统」
    const next = resolveTheme(localStorage.getItem('sj-theme') || DEFAULTS.theme) === 'dark' ? 'light' : 'dark';
    localStorage.setItem('sj-theme', next); applyTheme(); syncSettingsUI();
    toast(next === 'dark' ? '深色' : '浅色');
  };
bindEl('#btn-image', 'click', () => $('#file-input').click());
  $$('#seg-ol button').forEach(b => b.onclick = () => setOutline(b.dataset.ol === '1'));
  // 右侧大纲宽度可拖
  /* ① 三根分栏互相独立：文件栏 --side-w / sj-side-w，
        大纲栏 --ol-w / sj-ol-w，正文中缝 --split-pct / sj-split-pct。
        （原来大纲栏也写 --side-w，拖任一个另一个跟着动） */
  /* 三根 grip（侧栏 / 大纲 / 正文中缝）共用这一组全局拖拽管道：哪里按下就只动哪一根 */
  addEventListener('pointermove', e => dragMove(e), { passive: true });
  addEventListener('pointerup', () => endDrag());
  addEventListener('pointercancel', () => endDrag());
  (function outlineResize() {
    const grip = $('#ol-grip'); if (!grip) return;
    const saved = parseInt(localStorage.getItem('sj-ol-w') || '', 10);
    if (saved >= 180 && saved <= 460) document.documentElement.style.setProperty('--ol-w', saved + 'px');
    // 大纲在右侧：宽度 = 起始宽度 - 指针横向位移（左拖变宽、右拖变窄，不跳不越界）
    grip.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch (_) { }   // 同侧栏：保证拖拽期间事件目标不丢
      const base = $('#outline-panel').getBoundingClientRect().width;
      const x0 = e.clientX;
      beginDrag(e,
        x => { const w = Math.min(460, Math.max(180, base - (x - x0)));
          document.documentElement.style.setProperty('--ol-w', w + 'px'); },
        () => { localStorage.setItem('sj-ol-w',
          getComputedStyle(document.documentElement).getPropertyValue('--ol-w').trim()); });
    });
    grip.addEventListener('dblclick', () => { document.documentElement.style.removeProperty('--ol-w');
      localStorage.removeItem('sj-ol-w'); });
  })();
  bindEl('#btn-keys', 'click', () => { el.keysOverlay.hidden = false; });  // 侧栏底部的快捷键入口
  /* 左侧导航统一口径：点未激活的栏目＝切过去并展开侧栏；
     点当前栏目＝收放侧栏（唯一的收放入口） */
  PANES.forEach(pane => bindEl('#nav-' + pane, 'click', () => {
    /* 从欢迎页点栏目：先把欢迎页「正经」收起来（写进 sj-welcome）。
       之前只是被别的东西顺手 hidden，localStorage 里还留着 1 ——
       于是刷新一下又跳回欢迎页，用户会以为「点栏目根本不管用」。 */
    const fromWelcome = welcoming || !$('#welcome').hidden;   // 先记下来：下面马上就把欢迎页关了
    if (!$('#welcome').hidden) setWelcome(false);
    const on = el.sidebar && el.sidebar.dataset.pane === pane;
    // 窄屏：侧栏是抽屉——点栏目＝拉出来（「文件」也拉出来），再点当前栏目＝收回去
    if (innerWidth <= 860) {
      if (fromWelcome) { el.sidebar.classList.add('open'); if (!on) setSidePane(pane); return; }
      if (on && el.sidebar.classList.contains('open')) { el.sidebar.classList.remove('open'); return; }
      if (!on) setSidePane(pane);
      el.sidebar.classList.add('open');
      if (pane === 'tree' && S.view === 'split') setView('read');
      return;
    }
    // 欢迎页开着时，侧栏整个是被藏起来的（body.welcoming）：
    // 这时点栏目一律「展开 + 切过去」，不能再按「点当前栏目＝收起」处理，
    // 否则点「文件」（正好是当前栏目）会把文件栏收掉，跳过去一片空。
    if (fromWelcome) { setCollapsed(false); if (!on) setSidePane(pane); return; }
    const collapsed = $('#body').classList.contains('collapsed');
    if (on && !collapsed) { setCollapsed(true); return; }
    setCollapsed(false);
    if (!on) setSidePane(pane);
  }));
  /* 窄屏：点正文任意处就把抽屉收回去 */
  document.addEventListener('click', e => {
    if (innerWidth > 860 || !el.sidebar || !el.sidebar.classList.contains('open')) return;
    if (el.sidebar.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.rail')) return;
    el.sidebar.classList.remove('open');
  });
  /* 设置栏目的分区导航（顶部横排芯片） */
  $$('#set-nav .set-nav-btn').forEach(b => b.onclick = () => {
    $$('#set-nav .set-nav-btn').forEach(x => x.classList.toggle('on', x === b));
    showSetSec(b.dataset.sec);
  });
  const si = $('#set-search');
  if (si) si.oninput = () => applySetSearch(si.value);
  const sg = $('#search-go');
  if (sg) {
    const go = () => { const f = $('#filter'); if (!f) return; f.focus(); f.dispatchEvent(new Event('input')); };
    sg.onclick = go;
    sg.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  }
  const rb = $('#rail-brand');
  if (rb) {
    const home = () => {
      const docs = [];
      (function walk(ns) { (ns || []).forEach(n => n.type === 'dir' ? walk(n.children) : docs.push(n)); })(S.tree);
      setWelcome(true);                     // 点 logo：回欢迎界面
    };
    rb.onclick = home;
    rb.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); home(); } };
  }
  on('#fav-list', 'click', favClick);
  // 收藏夹右键：跟文件栏同一个菜单（文件/文件夹各一组），路径取 fav-item 上的 data-path
  const favRoot = $('#fav-list');
  if (favRoot) favRoot.addEventListener('contextmenu', e => {
    const item = e.target.closest('.fav-item');
    e.preventDefault();
    if (!item) return;
    const p = item.dataset.path;
    const n = S.byPath.get(p) || {};
    if (n.type === 'dir') { ctxDir = p; openCtx(e.clientX, e.clientY, p, 'dir'); }
    else { ctxDir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null;
           openCtx(e.clientX, e.clientY, p, 'doc'); }
  });
  // 欢迎界面
  on('#wc-recent', 'click', e => { const b = e.target.closest('.wc-note'); if (b) openDoc(b.dataset.path); });
  // 「栏目」按钮（文件/收藏/回收站/设置）才收起欢迎页。
  // 主题切换、快捷键、账号这些也长在左栏上，但点它们不该把人从欢迎页赶走。
  document.addEventListener('click', e => {
    const b = e.target.closest('.rail-btn');
    if (b && !$('#welcome').hidden && /^nav-/.test(b.id)) setWelcome(false);
  });
  // 「检查更新」目前只做按钮：等发布流程定下来（比如放到 GitHub Release 或
  // 服务器上一个 version.json），把它换成 fetch('/api/update-check') 之类，
  // 拿到远端版本号和 APP_VER 比一比，再决定弹「有新版本」还是「已是最新」。
  on('#set-update', 'click', () => {
    toast('检查更新还没接上发布流程（当前 ' + APP_VER + '，测试版先占个位）');
  });
  // 磨砂强度滑块：拖动即时生效
  const sb = $('#set-blur');
  if (sb) sb.addEventListener('input', () => {
    CFG.blurPct = +sb.value; saveCfg(); applyCfg();
    const v = $('#set-blur-v'); if (v) v.textContent = sb.value + '%';
  });
  // 收藏角标（二级导航里那个）+ 恢复上次折叠状态
  setCollapsed(localStorage.getItem('sj-collapsed') === '1');
  /* 侧栏栏目状态必须在这里初始化：data-pane 缺失时 CSS 的
     `.sidebar:not([data-pane="tree"])` 会把搜索框 / 文件树一起藏掉，
     表现就是「刷新后左侧栏空空如也」 */
  setSidePane(PAGE);
  wireSettings();
  wireCtxMenu();
  touchLongPressMenu();
  wireBrand();
  wireAcct();
  loadCfg();
  applyCfg();
  rebuildAutoSave();
  refreshAvatar();
  // 收起/展开的弹性动画：整套效果挂在 html.jelly 上，去掉这个类即回到原来的瞬变
  document.documentElement.classList.add('jelly');
  // 手机屏幕太窄：大纲默认收起、侧栏抽屉默认关闭，正文占满
  const wide = innerWidth > 860;
  setOutline(wide ? localStorage.getItem('sj-outline') !== '0' : false);
  if (!wide) {
    el.sidebar.classList.remove('open');
    if (S.view === 'split') setView('read');
  }
  // 侧栏宽度可拖（拖完记住）
  (function sidebarResize() { const grip = $('#side-grip'); if (!grip) return; const saved = parseInt(localStorage.getItem('sj-side-w') || '', 10); if (saved >= 180 && saved <= 460) document.documentElement.style.setProperty('--side-w', saved + 'px');
    // 侧栏在左侧：宽度 = 起始宽度 + 指针横向位移（右拖变宽；旧写 w=x 会整体偏一个 rail 宽的错位）
    grip.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch (_) { }   // 锁指针：拖拽态下命中区会被 contain:paint 裁掉外半，锁上后 click/dblclick 才回到把手本身
      const base = el.sidebar.getBoundingClientRect().width;
      const x0 = e.clientX;
      beginDrag(e,
        x => { const w = Math.min(460, Math.max(180, base + (x - x0)));
          document.documentElement.style.setProperty('--side-w', w + 'px'); },
        () => { localStorage.setItem('sj-side-w',
          getComputedStyle(document.documentElement).getPropertyValue('--side-w').trim()); });
    });
    grip.addEventListener('dblclick', () => { document.documentElement.style.removeProperty('--side-w'); localStorage.removeItem('sj-side-w');
    });
  })();

  /* 正文中缝：调左右两栏的比例，与两侧栏完全无关 */
  (function splitResize() {
    const gut = $('#gutter'); if (!gut) return;
    const split = gut.closest('.split'); if (!split) return;
    const saved = parseFloat(localStorage.getItem('sj-split-pct') || '');
    if (saved >= 15 && saved <= 85) document.documentElement.style.setProperty('--split-pct', saved + '%');
    gut.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { gut.setPointerCapture(e.pointerId); } catch (_) { }
      const r = split.getBoundingClientRect(); if (!r.width) return;
      const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--split-pct')) || 50;
      const off = e.clientX - (r.left + r.width * cur / 100);   // 抓取偏移（≈半个中缝宽），保证不跳
      beginDrag(e,
        x => { const pct = ((x - off) - r.left) / r.width * 100;
          document.documentElement.style.setProperty('--split-pct',
            Math.min(85, Math.max(15, pct)).toFixed(2) + '%'); },
        () => { localStorage.setItem('sj-split-pct',
          getComputedStyle(document.documentElement).getPropertyValue('--split-pct').trim()); });
    });
    gut.addEventListener('dblclick', () => { document.documentElement.style.removeProperty('--split-pct');
      localStorage.removeItem('sj-split-pct'); });
  })();
  bindEl('#keys-close', 'click', () => { el.keysOverlay.hidden = true; }); el.keysOverlay.addEventListener('click', e => { if (e.target === el.keysOverlay) el.keysOverlay.hidden = true; });
  // 预览里点图片放大
  el.preview.addEventListener('click', e => { const img = e.target.closest('img'); if (img) { e.preventDefault(); openLightbox(img.getAttribute('src'), img.getAttribute('alt') || ''); }
  });
  // 预览里右键图片：编辑 / 在媒体库中显示
  el.preview.addEventListener('contextmenu', e => {
    const img = e.target.closest('img');
    if (!img) return;
    e.preventDefault();
    ctxImgSrc = img.getAttribute('src') || '';
    openCtx(e.clientX, e.clientY, S.current, 'img');
  });
  // 预览里点别的笔记名 → 直接打开那篇
  el.preview.addEventListener('click', e => { const a = e.target.closest('a.note-link'); if (a) { e.preventDefault(); openDoc(a.dataset.note); }
  });
  bindEl('#outline-list', 'click', e => { const a = e.target.closest('.ol-item'); if (a) { e.preventDefault(); jumpToHeading(a.dataset.id); }
  });
  // 预览里点目录/锚点：平滑跳转
  el.preview.addEventListener('click', e => { const a = e.target.closest('a[href^="#"]'); if (!a) return; e.preventDefault(); const id = decodeURI(a.getAttribute('href').slice(1)); if (id) jumpToHeading(id);
  }); bindEl('#btn-user', 'click', e => { e.stopPropagation(); el.userMenu.hidden = !el.userMenu.hidden; }); document.addEventListener('click', e => { if (!e.target.closest('#user')) el.userMenu.hidden = true; }); bindEl('#mi-logout', 'click', async () => { await post('/api/logout'); location.reload(); }); $$('#seg-view button').forEach(b => b.onclick = () => setView(b.dataset.view));

  /* （旧的 S.ratio / style.flex 分栏拖拽已并入上面的 splitResize：--split-pct 方案；两个写入方曾互相打架） */

  // 搜索面板
  el.q.addEventListener('input', runSearch);
  el.q.addEventListener('keydown', e => { const hits = Array.from(el.results.querySelectorAll('.hit')); const cur = el.results.querySelector('.hit.on') || hits[0];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!hits.length) return; let i = hits.indexOf(cur); i = e.key === 'ArrowDown' ? Math.min(hits.length - 1, i + 1) : Math.max(0, i - 1); hits.forEach(h => h.classList.remove('on')); hits[i].classList.add('on'); hits[i].scrollIntoView({ block: 'nearest' }); } else if (e.key === 'Enter') { if (cur) { const q = el.q.value.trim(); closeSearch(); openDoc(cur.dataset.doc, { hit: q }); }
    }
  });
  el.results.addEventListener('click', e => { const hit = e.target.closest('.hit'); if (hit) { const q = el.q.value.trim(); closeSearch(); openDoc(hit.dataset.doc, { hit: q }); }
  }); el.searchOverlay.addEventListener('click', e => { if (e.target === el.searchOverlay) closeSearch(); });

  // 输入面板
  on('#trash-cards', 'click', doTrashAction);
  bindEl('#trash-empty', 'click', doTrashEmpty);
  $('#prompt-form').addEventListener('submit', e => { e.preventDefault();
    const btn = $('#prompt-form .accent');
    closeAsk(promptConfirm ? ((btn && btn.textContent) || '确定') : el.promptInput.value.trim()); });
  bindEl('#prompt-cancel', 'click', () => closeAsk(null));
  el.promptOverlay.addEventListener('click', e => { if (e.target === el.promptOverlay) closeAsk(null); });

  // 历史面板
  el.historyOverlay.addEventListener('click', e => { if (e.target === el.historyOverlay) el.historyOverlay.hidden = true; });

  /* 首次部署没有账号时，登录页自动切成「注册管理员」表单；
     注册成功后这个入口由后端永久关闭（/api/register 只在无用户时可用）。 */
  async function checkSetup() {
    try { const r = await post('/api/setup-state', {}); NEEDS_SETUP = !!(r && r.needs_setup);
    } catch (e) { NEEDS_SETUP = false; } const box = $('#reg-only'); if (!box) return; box.hidden = !NEEDS_SETUP; const un = $('#user-name'), ru = $('#reg-user');
    if (NEEDS_SETUP) { un.value = ru.value || ''; ru.placeholder = '2-32 位，中英文均可'; document.querySelector('#login-form .accent').textContent = '注册并进入'; const tip = document.querySelector('#gate-tip'); if (tip) tip.textContent = '初次见面，先为自己配一把钥匙'; } else { document.querySelector('#login-form .accent').textContent = '进入'; const tip = document.querySelector('#gate-tip'); if (tip) tip.textContent = '凭钥匙入内，才翻得开这一册';
    }
  } $('#reg-user').addEventListener('input', e => { $('#user-name').value = e.target.value; });

  $('#login-form').addEventListener('submit', async e => { e.preventDefault(); const err = $('#gate-err'); err.textContent = ''; const btn = $('#login-form .accent'); const old = btn.textContent; btn.disabled = true; btn.textContent = NEEDS_SETUP ? '注册中…' : '进入中…';
    try { let r;
      if (NEEDS_SETUP) { const pw = $('#reg-pw').value, pw2 = $('#reg-pw2').value; if (pw !== pw2) throw new Error('两次输入的密码不一致');
        r = await post('/api/register', {
          username: $('#reg-user').value.trim(), password: pw, password2: pw2
        }); localStorage.setItem('sj-justregistered', '1'); } else {
        r = await post('/api/login', {
          username: $('#user-name').value.trim(), password: $('#pw').value, remember: $('#remember').checked
        });
      } $('#pw').value = ''; $('#reg-pw').value = ''; $('#reg-pw2').value = ''; localStorage.setItem('sj-user', r.user || ''); await boot(true);
      if (NEEDS_SETUP) { toast('账号已立好，钥匙归你');
        setTimeout(() => { toast('站名与 Logo 在「设置 · 网站」，头像在「设置 · 头像」——先去认领它们'); setSidePane('set'); $$('#set-nav .set-nav-btn').find(b => b.dataset.sec === 'brand')?.click();
        }, 1400);
      }
    } catch (ex) { err.textContent = ex.message || '登录失败'; } finally { btn.disabled = false; btn.textContent = old; }
  }); checkSetup();

  // 快捷键
  addEventListener('keydown', e => { const mod = e.ctrlKey || e.metaKey; if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); } else if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); doExportMd(); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); if (!S.current) return toast('先打开一篇笔记'); toast(toggleFav(S.current) ? '已收藏' : '已取消收藏'); if (RAIL === 'fav') openFav();
    }
    else if (mod && e.key === '\\') { e.preventDefault(); setOutline(el.body.classList.contains('no-outline'));
    }
    else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); setCollapsed(!el.body.classList.contains('collapsed'));
    } else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); doNew(); }
    else if (e.key === '?' && !/INPUT|TEXTAREA/.test((e.target.tagName || ''))) { e.preventDefault(); el.keysOverlay.hidden = !el.keysOverlay.hidden;
    }
    else if (e.key === 'Escape') { if (!el.keysOverlay.hidden) el.keysOverlay.hidden = true; else if (!el.searchOverlay.hidden) closeSearch(); else if (!el.promptOverlay.hidden) closeAsk(null); else if (!el.historyOverlay.hidden) el.historyOverlay.hidden = true; el.sidebar.classList.remove('open');
    }
  }); addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } }); window.__bindMs = Math.round(performance.now() - window.__t);
}

async function uploadImage(file, doc) {
  const name = file.name || ('粘贴图-' + Date.now() + '.png');
  const data = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(new Error('读取图片失败'));
    fr.readAsDataURL(file);
  });
  const r = await post('/api/upload', { name, data, doc: doc || S.current || '' });
  return r.name;
}

/** 在光标处插入文本 */
function insertAtCursor(text) {
  const ed = el.editor, s = ed.selectionStart, t = ed.value;
  ed.value = t.slice(0, s) + text + t.slice(ed.selectionEnd);
  ed.selectionStart = ed.selectionEnd = s + text.length;
  ed.focus();
  S.body = ed.value; S.dirty = true; setSaveState('dirty');
  // 插入图片走的是这条路（粘贴 / 拖拽 / 工具栏），要把「输入」时该刷的都刷一遍：
  // 预览 + 行号 + 高亮，否则插完图编辑区看上去还是旧样子，得再敲一下键才更新。
  render(); refreshLineno(); refreshHl(); autoSave();
}

async function handleFiles(files) {
  const imgs = Array.from(files || []).filter(f => /^image\//.test(f.type));
  if (!imgs.length) return;
  toast('上传中…（' + imgs.length + ' 张）');
  const lines = [];
  const dirName = S.current ? mediaDirName(S.current) : '';
  for (const f of imgs) {
    try {
      const name = await uploadImage(f, S.current);
      // 存进本篇笔记自己的媒体目录，正文里写相对路径
      const ref = dirName ? dirName + '/' + name : name;
      lines.push('![' + name + '](' + encodeURI(ref) + ')');
    } catch (e) { toast('上传失败：' + e.message); }
  }
  if (lines.length) {
    insertAtCursor((el.editor.value.endsWith('\n') || !el.editor.value ? '' : '\n') + lines.join('\n') + '\n');
    toast('已插入 ' + lines.length + ' 张图');
  }
}

/* ══ 媒体库（每篇笔记一个 <笔记名>.assets/）═════════════════════
   入口：① 文件栏右键「打开媒体库」 ② 预览里右键图片「在媒体库中显示 / 编辑图片」。
   点开一张先看大图（查看模式：上一张 / 下一张 / 编辑），进编辑再改：
   左转、右转、水平翻转、垂直翻转、裁剪、透视矫正（自动识别，失败转手动四点）、撤销、还原。
   全部在浏览器里用 canvas 做，后端只负责读写文件。 */
const MEDIA = { doc: '', dir: '', items: [], idx: -1, from: 'tree' };
const MED = { img: null, orig: null, rot: 0, fh: false, fv: false, crop: null, path: '',
              name: '', mtime: 0, hist: [], cropMode: false, mode: 'view' };
let MEDIA_EL = null;
let ctxImgSrc = '';
let QUAD = null;        // 手动透视的四个角（0~1 的比例坐标）
let PERSP = null;       // {prev:{img,rot,fh,fv}} 进手动透视前的状态
let PERSP_TRIED = false; // 自动没认出纸边时，第二次点击才进手动

/** 笔记路径 → 它的媒体目录名（不含上级路径） */
function mediaDirName(doc) {
  const parts = (doc || '').split('/');
  const file = parts.pop() || '';
  return file.replace(/\.(md|markdown|txt)$/i, '') + '.assets';
}

/** 从 /api/raw?path=… 里取回相对路径 */
function imgPathFromSrc(src) {
  const m = (src || '').match(/[?&]path=([^&]+)/);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (e) { return ''; }
}

function mediaTitle(doc) {
  const n = S.byPath.get(doc) || {};
  return n.title || (doc || '').split('/').pop().replace(/\.(md|markdown|txt)$/i, '');
}

function ensureMediaEl() {
  if (MEDIA_EL) return MEDIA_EL;
  const d = document.createElement('div');
  d.className = 'media-lib';
  d.hidden = true;
  d.innerHTML =
    '<div class="ml-shell">' +
      '<div class="ml-head">' +
        '<div class="ml-title">媒体库</div>' +
        '<span class="ml-chip"><span class="ml-dir"></span></span>' +
        '<span class="flex"></span>' +
        '<button class="ml-btn" data-mact="upload">上传图片</button>' +
        '<button class="ml-x" data-mact="close" title="关闭（Esc）">✕</button>' +
      '</div>' +
      '<div class="ml-bar ml-gridbar">' +
        '<span class="ml-hint">点一张先看大图，右上角有「上一张 / 下一张 / 编辑」</span>' +
        '<span class="flex"></span><span class="ml-count"></span>' +
      '</div>' +
      '<div class="ml-body">' +
        '<div class="ml-grid"></div>' +
        '<div class="ml-view" hidden>' +
          '<div class="ml-bar ml-viewbar">' +
            '<span class="ml-name"></span>' +
            '<span class="flex"></span>' +
            '<button class="ml-btn" data-mact="prev">‹ 上一张</button>' +
            '<button class="ml-btn" data-mact="next">下一张 ›</button>' +
            '<button class="ml-btn primary" data-mact="edit">编辑</button>' +
          '</div>' +
          '<div class="ml-bar ml-editbar" hidden>' +
            '<button class="ml-btn" data-mact="left" title="逆时针 90°">↺ 左转</button>' +
            '<button class="ml-btn" data-mact="right" title="顺时针 90°">↻ 右转</button>' +
            '<button class="ml-btn" data-mact="fhh" title="左右镜像">⇋ 水平翻转</button>' +
            '<button class="ml-btn" data-mact="fvv" title="上下镜像">⇅ 垂直翻转</button>' +
            '<button class="ml-btn" data-mact="crop" title="在图上拖一个框">▣ 裁剪</button>' +
            '<button class="ml-btn" data-mact="persp" title="自动识别纸面，识别不到就手动拖四角">⬚ 透视矫正</button>' +
            '<button class="ml-btn" data-mact="undo" title="撤销上一步">↶ 撤销</button>' +
            '<button class="ml-btn" data-mact="reset" title="回到刚打开时的样子">⟲ 还原</button>' +
            '<span class="flex"></span>' +
            '<button class="ml-btn primary" data-mact="save">保存</button>' +
            '<button class="ml-btn" data-mact="done">完成</button>' +
          '</div>' +
          '<div class="ml-canvas-wrap"><div class="ml-canvas-inner">' +
            '<canvas id="ml-canvas"></canvas>' +
            '<div class="ml-crop" hidden></div>' +
            '<div class="ml-quad" hidden>' +
              '<svg class="ml-qline" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points=""/></svg>' +
              '<span class="ml-qh" data-q="0"></span><span class="ml-qh" data-q="1"></span>' +
              '<span class="ml-qh" data-q="2"></span><span class="ml-qh" data-q="3"></span>' +
            '</div>' +
          '</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="ml-meta"></div>' +
    '</div>' +
    '<input type="file" class="ml-file" accept="image/*" multiple hidden>';
  document.body.appendChild(d);

  const wrap = d.querySelector('.ml-canvas-wrap');
  let drag = null;

  /* 裁剪：在画布上拖一个框，松手即裁 */
  wrap.addEventListener('pointerdown', e => {
    if (!MED.cropMode) return;
    const cv = d.querySelector('#ml-canvas').getBoundingClientRect();
    drag = { x0: e.clientX - cv.left, y0: e.clientY - cv.top, cv };
    try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
  });
  wrap.addEventListener('pointermove', e => {
    if (!drag) return;
    const cv = drag.cv;
    const x = Math.min(Math.max(e.clientX - cv.left, 0), cv.width);
    const y = Math.min(Math.max(e.clientY - cv.top, 0), cv.height);
    const box = d.querySelector('.ml-crop');
    box.hidden = false;
    box.style.left = Math.min(drag.x0, x) + 'px';
    box.style.top = Math.min(drag.y0, y) + 'px';
    box.style.width = Math.abs(x - drag.x0) + 'px';
    box.style.height = Math.abs(y - drag.y0) + 'px';
    drag.cx = x; drag.cy = y;
  });
  wrap.addEventListener('pointerup', () => {
    if (!drag) return;
    const s = drag; drag = null;
    d.querySelector('.ml-crop').hidden = true;
    if (s.cx === undefined) return;
    mediaApplyCrop(s.x0, s.y0, s.cx - s.x0, s.cy - s.y0);
  });

  /* 手动透视：拖四个角 */
  const quadEl = d.querySelector('.ml-quad');
  let qdrag = null;
  quadEl.addEventListener('pointerdown', e => {
    const hd = e.target.closest('.ml-qh');
    if (!hd || !QUAD) return;
    e.preventDefault(); e.stopPropagation();
    qdrag = +hd.dataset.q;
    try { hd.setPointerCapture(e.pointerId); } catch (err) {}
  });
  quadEl.addEventListener('pointermove', e => {
    if (qdrag === null || !QUAD) return;
    const cv = d.querySelector('#ml-canvas').getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - cv.left) / cv.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - cv.top) / cv.height));
    QUAD[qdrag] = [fx, fy];
    drawQuad();
  });
  quadEl.addEventListener('pointerup', () => { qdrag = null; });
  quadEl.addEventListener('pointercancel', () => { qdrag = null; });

  d.addEventListener('change', () => {});
  d.querySelector('.ml-file').addEventListener('change', async () => {
    const inp = d.querySelector('.ml-file');
    const files = Array.from(inp.files || []);
    inp.value = '';
    for (const f of files) {
      try {
        await post('/api/upload', { name: f.name, data: await fileToB64(f), doc: MEDIA.doc });
      } catch (e) { toast('上传失败：' + (e.message || '未知错误')); }
    }
    if (files.length) { toast('已上传 ' + files.length + ' 张'); await reloadMedia(); }
  });

  d.addEventListener('click', async e => {
    const th = e.target.closest('.ml-thumb');
    if (th) { await mediaOpenIdx(+th.dataset.i); return; }
    const b = e.target.closest('[data-mact]');
    if (!b) return;
    const act = b.dataset.mact;
    if (act === 'close') return closeMedia();
    if (act === 'upload') { d.querySelector('.ml-file').click(); return; }
    if (act === 'back') return showMediaGrid();
    if (act === 'done') return setMediaMode('view');
    if (act === 'edit') return setMediaMode('edit');
    if (act === 'prev') return mediaStep(-1);
    if (act === 'next') return mediaStep(1);
    if (act === 'left' || act === 'right' || act === 'fhh' || act === 'fvv') {
      if (PERSP) exitPersp();          // 透视中改朝向，四边形就对不上了，先退出
      const before = mediaSnapshot();  // 撤销要退回改之前，所以先存一份
      if (act === 'left')  MED.rot = (MED.rot + 270) % 360;
      if (act === 'right') MED.rot = (MED.rot + 90) % 360;
      if (act === 'fhh')   MED.fh = !MED.fh;
      if (act === 'fvv')   MED.fv = !MED.fv;
      mediaDirty(before);
      return;
    }
    if (act === 'crop') {
      if (PERSP) exitPersp();
      MED.cropMode = !MED.cropMode;
      b.classList.toggle('on', MED.cropMode);
      wrap.classList.toggle('cropping', MED.cropMode);
      if (!MED.cropMode) d.querySelector('.ml-crop').hidden = true;
      return;
    }
    if (act === 'persp') return autoPersp();
    if (act === 'perspapply') return applyPersp();
    if (act === 'perspcancel') return exitPersp();
    if (act === 'undo') return mediaUndo();
    if (act === 'reset') return mediaReset();
    if (act === 'save') return mediaSave();
  });

  addEventListener('keydown', e => {
    if (d.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (PERSP) return exitPersp();
      if (MED.mode === 'edit') return setMediaMode('view');
      if (!d.querySelector('.ml-view').hidden) return showMediaGrid();
      return closeMedia();
    }
    if (e.key === 'ArrowLeft') { if (MED.mode === 'view') { e.preventDefault(); mediaStep(-1); } }
    if (e.key === 'ArrowRight') { if (MED.mode === 'view') { e.preventDefault(); mediaStep(1); } }
  });
  MEDIA_EL = d;
  return d;
}

async function openMedia(doc, focusPath, opts) {
  opts = opts || {};
  const d0 = doc || S.current;
  if (!d0) return toast('先打开一篇笔记');
  let data;
  try { data = await api('/api/media?doc=' + encodeURIComponent(d0)); }
  catch (e) { return toast('媒体库打不开：' + (e.message || '未知错误')); }
  MEDIA.doc = d0;
  MEDIA.dir = data.dir;
  MEDIA.from = opts.from || (opts.edit ? 'preview' : 'tree');
  MEDIA.items = data.items || [];
  MEDIA.idx = -1;
  const box = ensureMediaEl();
  box.hidden = false;
  box.querySelector('.ml-title').textContent = '媒体库 · ' + mediaTitle(d0);
  box.querySelector('.ml-dir').textContent = (data.dir || '') + '　·　' + MEDIA.items.length + ' 张';
  renderMediaGrid();
  if (focusPath) {
    const i = MEDIA.items.findIndex(x => x.path === focusPath);
    if (i >= 0) { MEDIA.idx = i; await mediaShow(i, opts.edit ? 'edit' : 'view'); }
    else await mediaOpenFile({ path: focusPath, name: focusPath.split('/').pop(), mtime: 0,
                               url: '/api/raw?path=' + encodeURIComponent(focusPath) }, true,
                             opts.edit ? 'edit' : 'view');
  } else if (opts.edit) { await mediaShow(0, 'edit'); }
  else showMediaGrid();
}

async function reloadMedia() {
  if (!MEDIA.doc) return;
  try {
    const data = await api('/api/media?doc=' + encodeURIComponent(MEDIA.doc));
    MEDIA.items = data.items || [];
    MEDIA.dir = data.dir;
    const box = MEDIA_EL;
    if (box) {
      box.querySelector('.ml-dir').textContent = (data.dir || '') + '　·　' + MEDIA.items.length + ' 张';
      renderMediaGrid();
    }
  } catch (e) { /* 保持原样 */ }
}

function closeMedia() {
  if (PERSP) { try { exitPersp(); } catch (e) {} }
  if (MEDIA_EL) { MEDIA_EL.hidden = true; MEDIA_EL.querySelector('.ml-view').hidden = true; }
  MED.cropMode = false;
}

function showMediaGrid() {
  const box = MEDIA_EL;
  if (!box) return;
  if (PERSP) exitPersp();
  box.querySelector('.ml-view').hidden = true;
  box.querySelector('.ml-grid').hidden = false;
  box.querySelector('.ml-gridbar').hidden = false;
  MED.cropMode = false;
  const c = box.querySelector('[data-mact="crop"]');
  if (c) c.classList.remove('on');
  renderMediaGrid();
}

function renderMediaGrid() {
  const box = MEDIA_EL;
  if (!box) return;
  const grid = box.querySelector('.ml-grid');
  grid.hidden = false;
  box.querySelector('.ml-view').hidden = true;
  box.querySelector('.ml-gridbar').hidden = false;
  const total = MEDIA.items.reduce((a, b) => a + (b.size || 0), 0);
  const cnt = box.querySelector('.ml-count');
  if (cnt) cnt.textContent = MEDIA.items.length + ' 张';
  const meta = box.querySelector('.ml-meta');
  if (meta) meta.textContent = MEDIA.items.length + ' 张　·　' + fmtSize(total);
  if (!MEDIA.items.length) {
    grid.innerHTML = '<div class="ml-empty">这篇笔记的媒体目录还是空的。<br>' +
      '点右上角「上传图片」，或在正文里粘贴 / 拖入图片，图就会落到 <code>' +
      esc(MEDIA.dir || '') + '</code>。</div>';
    return;
  }
  grid.innerHTML = MEDIA.items.map((it, i) =>
    '<button class="ml-thumb" data-i="' + i + '" title="' + esc(it.name) + '">' +
      '<img src="' + esc(it.url + '&v=' + (it.mtime || 0)) + '" alt="" loading="lazy">' +
      '<span>' + esc(it.name) + '</span>' +
    '</button>').join('');
}

async function mediaOpenIdx(i) {
  const it = MEDIA.items[i];
  if (!it) return;
  MEDIA.idx = i;
  await mediaShow(i, 'view');
}

/** 打开第 i 张；mode = 'view'（看大图）或 'edit'（进编辑器） */
async function mediaShow(i, mode) {
  const it = MEDIA.items[i];
  if (!it) return;
  MEDIA.idx = i;
  await mediaOpenFile(it, false, mode || 'view');
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('图片加载失败'));
    im.src = url;
  });
}

async function mediaOpenFile(rec, foreign, mode) {
  const box = ensureMediaEl();
  box.querySelector('.ml-grid').hidden = true;
  box.querySelector('.ml-view').hidden = false;
  box.querySelector('.ml-gridbar').hidden = true;
  MED.path = rec.path; MED.name = rec.name; MED.mtime = rec.mtime || 0;
  MED.rot = 0; MED.fh = false; MED.fv = false; MED.crop = null; MED.hist = [];
  PERSP_TRIED = false;
  MED.cropMode = false; MED.foreign = !!foreign;
  PERSP = null; QUAD = null;
  box.querySelector('.ml-quad').hidden = true;
  box.querySelector('[data-mact="crop"]').classList.remove('on');
  box.querySelector('.ml-canvas-wrap').classList.remove('cropping');
  box.querySelector('.ml-crop').hidden = true;
  box.querySelector('.ml-meta').textContent = '载入中…';
  try {
    MED.img = await loadImage(rec.url + (rec.url.includes('?') ? '&' : '?') + 'v=' + (rec.mtime || 0));
  } catch (e) { box.querySelector('.ml-meta').textContent = '这张图打不开：' + e.message; return; }
  MED.orig = mediaSnapshot();
  setMediaMode(mode || 'view');
}

function setMediaMode(mode) {
  const box = MEDIA_EL;
  if (!box || !MED.img) return;
  if (PERSP) exitPersp();
  MED.mode = mode === 'edit' ? 'edit' : 'view';
  const editing = MED.mode === 'edit';
  box.querySelector('.ml-viewbar').hidden = editing;
  box.querySelector('.ml-editbar').hidden = !editing;
  box.querySelector('.ml-name').textContent = MED.name;
  box.querySelector('.ml-crop').hidden = true;
  box.querySelector('.ml-quad').hidden = true;
  MED.cropMode = false;
  box.querySelector('[data-mact="crop"]').classList.remove('on');
  box.querySelector('.ml-canvas-wrap').classList.remove('cropping');
  mediaDraw();
}

function mediaSnapshot() {
  return { img: MED.img, rot: MED.rot, fh: MED.fh, fv: MED.fv };
}

function mediaRestore(s) {
  MED.img = s.img; MED.rot = s.rot; MED.fh = s.fh; MED.fv = s.fv;
}

function mediaDirty(before) {
  if (before) MED.hist.push(before);
  mediaDraw();
}

/** 撤销：退回上一步 */
function mediaUndo() {
  if (PERSP) exitPersp();
  const s = MED.hist.pop();
  if (!s) return toast('没有可撤销的步骤了');
  mediaRestore(s);
  mediaDraw();
}

/** 还原：回到刚打开这张图时的样子 */
function mediaReset() {
  if (PERSP) exitPersp();
  if (!MED.orig) return;
  MED.hist = [];
  mediaRestore(MED.orig);
  MED.crop = null;
  mediaDraw();
  toast('已还原到打开时的样子');
}

function mediaDraw() {
  const box = MEDIA_EL;
  if (!box || !MED.img) return;
  const cv = box.querySelector('#ml-canvas');
  const img = MED.img;
  const cw = MED.crop ? MED.crop.w : img.naturalWidth;
  const ch = MED.crop ? MED.crop.h : img.naturalHeight;
  const swap = (MED.rot % 180) !== 0;
  cv.width = swap ? ch : cw;
  cv.height = swap ? cw : ch;
  const g = cv.getContext('2d');
  g.save();
  g.clearRect(0, 0, cv.width, cv.height);
  g.translate(cv.width / 2, cv.height / 2);
  g.rotate(MED.rot * Math.PI / 180);
  g.scale(MED.fh ? -1 : 1, MED.fv ? -1 : 1);
  g.drawImage(img, MED.crop ? MED.crop.x : 0, MED.crop ? MED.crop.y : 0, cw, ch,
              -cw / 2, -ch / 2, cw, ch);
  g.restore();
  const meta = box.querySelector('.ml-meta');
  if (meta) meta.textContent = (MED.foreign ? '（不在本文媒体目录）　' : '') +
    MED.name + '　·　' + cv.width + '×' + cv.height +
    '　·　' + (MEDIA.items.length > 1 ? (MEDIA.idx + 1) + ' / ' + MEDIA.items.length : '1 张');
}

/** 把当前画布上的选区长出来，变成新图（旋转/翻转已经烘焙进去） */
function mediaApplyCrop(x, y, w, h) {
  const box = MEDIA_EL;
  const cv = box.querySelector('#ml-canvas');
  const fx = cv.width / cv.clientWidth, fy = cv.height / cv.clientHeight;
  const sx = Math.max(0, Math.round(Math.min(x, x + w) * fx));
  const sy = Math.max(0, Math.round(Math.min(y, y + h) * fy));
  const sw = Math.min(cv.width - sx, Math.round(Math.abs(w) * fx));
  const sh = Math.min(cv.height - sy, Math.round(Math.abs(h) * fy));
  if (sw < 4 || sh < 4) return;
  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  tmp.getContext('2d').drawImage(cv, sx, sy, sw, sh, 0, 0, sw, sh);
  const url = tmp.toDataURL('image/png');
  const im = new Image();
  im.onload = () => {
    MED.hist.push(mediaSnapshot());
    MED.img = im; MED.rot = 0; MED.fh = false; MED.fv = false; MED.crop = null;
    MED.cropMode = false;
    box.querySelector('.ml-canvas-wrap').classList.remove('cropping');
    box.querySelector('[data-mact="crop"]').classList.remove('on');
    box.querySelector('.ml-crop').hidden = true;
    mediaDraw();
  };
  im.src = url;
}

function mediaStep(dir) {
  if (MEDIA.items.length < 2 || MEDIA.idx < 0) return;
  let i = MEDIA.idx + dir;
  if (i < 0) i = MEDIA.items.length - 1;
  if (i >= MEDIA.items.length) i = 0;
  mediaOpenIdx(i);
}

/* ── 透视矫正 ───────────────────────────────────────────── */
function drawQuad() {
  if (!QUAD || !MEDIA_EL) return;
  const box = MEDIA_EL;
  const cv = box.querySelector('#ml-canvas');
  const w = cv.clientWidth, h = cv.clientHeight;
  box.querySelectorAll('.ml-qh').forEach(el => {
    const i = +el.dataset.q;
    if (!QUAD[i]) return;
    el.style.left = (QUAD[i][0] * w) + 'px';
    el.style.top = (QUAD[i][1] * h) + 'px';
  });
  const poly = QUAD.map(p => (p[0] * 100).toFixed(2) + ',' + (p[1] * 100).toFixed(2)).join(' ');
  const pg = box.querySelector('.ml-qline polygon');
  if (pg) pg.setAttribute('points', poly);
}

/** 点「透视矫正」：先自动认纸面；认不出来再让手动拖四角 */
let SCAN_ENGINE = null;      // 懒加载：opencv.js + jscanify（只在第一次点「透视矫正」时拉）

/** 加载图像识别引擎（OpenCV.js + jscanify），返回 jscanify 构造函数 */
function loadScanEngine() {
  if (SCAN_ENGINE) return SCAN_ENGINE;
  SCAN_ENGINE = new Promise((resolve, reject) => {
    const withJscanify = () => {
      if (window.jscanify) return resolve(window.jscanify);
      const s = document.createElement('script');
      s.src = '/vendor/jscanify.js';
      s.onload = () => resolve(window.jscanify);
      s.onerror = () => reject(new Error('识别脚本加载失败'));
      document.head.appendChild(s);
    };
    if (window.cv && window.cv.Mat) return withJscanify();
    const s0 = document.createElement('script');
    s0.src = '/vendor/opencv.js';
    s0.onload = () => {
      const t0 = Date.now();
      const tick = () => {
        if (window.cv && window.cv.Mat) return withJscanify();
        if (Date.now() - t0 > 40000) return reject(new Error('识别引擎初始化超时'));
        setTimeout(tick, 120);
      };
      tick();
    };
    s0.onerror = () => reject(new Error('识别引擎加载失败'));
    document.head.appendChild(s0);
  });
  return SCAN_ENGINE;
}

/** 用 jscanify/OpenCV 找纸面四角（找不到或铺满画面返回 null） */
async function enginePaperQuad(cvEl) {
  const JS = await loadScanEngine();
  const scanner = new JS();
  let src = null, contour = null;
  try {
    src = cv.imread(cvEl);                       // 画布 → cv.Mat
    contour = scanner.findPaperContour(src);     // 找最大的四边形轮廓
    if (!contour) return null;
    const q = scanner.getCornerPoints(contour);
    if (!q || !q.topLeftCorner) return null;
    const pts = [q.topLeftCorner, q.topRightCorner, q.bottomRightCorner, q.bottomLeftCorner]
      .map(p => [p.x, p.y]);
    const area = Math.abs(polyArea(pts)) / (cvEl.width * cvEl.height);
    if (!(area > 0.08 && area < 0.985)) return null;   // 太小=噪点，太大=铺满画面
    return pts;
  } finally {
    if (src && !src.isDeleted()) src.delete();
    if (contour && !contour.isDeleted()) contour.delete();
  }
}

async function autoPersp() {
  if (!MED.img) return;
  const cv = MEDIA_EL.querySelector('#ml-canvas');
  const path0 = MED.path, mtime0 = MED.mtime;
  // ① 先用 OpenCV + jscanify 认纸边：拍纸、拍本子这类最稳
  try {
    if (!window.cv) toast('第一次用要加载识别引擎，稍等两三秒…');
    const pts = await enginePaperQuad(cv);
    if (pts) {
      if (MED.path !== path0) return;                 // 等引擎的时候换了图，就别动
      PERSP_TRIED = false;
      return applyQuad(pts, mediaSnapshot(), '已识别纸边并拉正，记得点「保存」');
    }
  } catch (e) {
    console.warn('识别引擎不可用：', e);
  }
  if (MED.path !== path0) return;
  // ② 看不到纸边（整页扫描、拍满画面）：按文字行的形状判歪
  const tq = detectTextQuad(cv);
  if (tq && (Math.abs(tq.tilt) >= 0.35 || tq.skew >= 0.006)) {
    PERSP_TRIED = false;
    const how = Math.abs(tq.tilt) >= 0.35
      ? '歪了 ' + Math.abs(tq.tilt).toFixed(1) + '°'
      : '左右差 ' + (tq.skew * 100).toFixed(1) + '%';
    return applyQuad(tq.quad, mediaSnapshot(), '已按文字行摆正（' + how + '），记得点「保存」');
  }
  // ③ 文字行也看不出来：只做整体倾斜摆正
  const ang = detectSkew(cv);
  if (Math.abs(ang) >= 0.6) { PERSP_TRIED = false; return applySkew(ang); }
  if (PERSP_TRIED) {
    PERSP_TRIED = false;
    enterPersp();
    return toast('手动把四个点拖到纸的四个角上，再点一次「透视矫正」应用');
  }
  PERSP_TRIED = true;
  return toast('没看出歪斜，已经够正了；要手动调就再点一次「透视矫正」');
}

/** 多边形面积（任意点数，符号无关） */
function polyArea(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function shoelace(q) {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function nearBorder(q, w, h) {
  const m = Math.min(w, h) * 0.02;
  return q.every(p => p[0] < m || p[0] > w - m || p[1] < m || p[1] > h - m);
}

/** 最小二乘拟合直线（y = a·x + b），点太少或近乎竖直就返回 null；剔除离群点再来一次 */
function fitBoundary(pts) {
  let cur = pts;
  for (let pass = 0; pass < 3; pass++) {
    const n = cur.length;
    if (n < 10) return null;
    let sx = 0, sy = 0;
    for (const p of cur) { sx += p[0]; sy += p[1]; }
    const mx = sx / n, my = sy / n;
    let sxx = 0, sxy = 0;
    for (const p of cur) { const dx = p[0] - mx; sxx += dx * dx; sxy += dx * (p[1] - my); }
    if (sxx < 1e-6) return null;
    const a = sxy / sxx, b = my - a * mx;
    let sum = 0;
    const res = cur.map(p => Math.abs(p[1] - (a * p[0] + b)));
    for (const r of res) sum += r;
    const mean = sum / n;
    const lim = Math.max(3, mean * 2.2);
    const keep = cur.filter((p, i) => res[i] <= lim);
    if (keep.length === n || keep.length < 10) return { a: a, b: b };
    cur = keep;
  }
  return null;
}

/** 两条线求交：y = a1·x + b1 与 x = c2·y + d2 */
function crossBounds(l1, l2) {
  const den = 1 - l1.a * l2.c;
  if (Math.abs(den) < 1e-6) return null;
  const y = (l1.a * l2.d + l1.b) / den;
  return [l2.c * y + l2.d, y];
}

/**
 * 按「文字的形状」找纸面：先按行投影切出文字行，量出文字块的上下左右四条边界线，
 * 四条线求交得到四角。字被拍歪、拍斜、近大远小都能看出来，不依赖有没有纸边。
 */
function detectTextQuad(cv) {
  const MAXD = 760;
  const sc = Math.min(1, MAXD / Math.max(cv.width, cv.height));
  const w = Math.max(60, Math.round(cv.width * sc));
  const h = Math.max(60, Math.round(cv.height * sc));
  const t = document.createElement('canvas');
  t.width = w; t.height = h;
  const g = t.getContext('2d');
  g.drawImage(cv, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const n = w * h;
  const lum = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    lum[p] = l; hist[l | 0]++;
  }
  // Otsu 阈值：比它暗的算笔画
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = i; }
  }
  const cut = thr - 6;
  // 行投影，切出文字行
  const rows = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    const o = y * w;
    for (let x = 0; x < w; x++) if (lum[o + x] < cut) c++;
    rows[y] = c;
  }
  let rowMax = 0;
  for (let y = 0; y < h; y++) if (rows[y] > rowMax) rowMax = rows[y];
  if (rowMax < w * 0.04) { return null; }
  const minCount = Math.max(2, rowMax * 0.12);
  const bands = [];
  let st = -1;
  for (let y = 0; y < h; y++) {
    const on = rows[y] >= minCount;
    if (on && st < 0) st = y;
    if (st >= 0 && (!on || y === h - 1)) {
      const e = on ? y : y - 1;
      if (e - st >= 1) bands.push([st, e]);
      st = -1;
    }
  }
  if (bands.length < 3) { return null; }
  const top = bands[0][0], bot = bands[bands.length - 1][1];
  if (bot - top < h * 0.18) { return null; }

  // 每一列在文字块里的最上／最下笔画 → 上下边界
  const topPts = [], botPts = [];
  for (let x = 0; x < w; x++) {
    let y0 = -1, y1 = -1;
    for (let y = top; y <= bot; y++) {
      if (lum[y * w + x] < cut) { if (y0 < 0) y0 = y; y1 = y; }
    }
    if (y0 >= 0) { topPts.push([x, y0]); botPts.push([x, y1]); }
  }
  // 每一行在文字块里的最左／最右笔画 → 左右边界
  const leftPts = [], rightPts = [];
  for (let y = top; y <= bot; y++) {
    let x0 = -1, x1 = -1;
    for (let x = 0; x < w; x++) {
      if (lum[y * w + x] < cut) { if (x0 < 0) x0 = x; x1 = x; }
    }
    if (x0 >= 0) { leftPts.push([y, x0]); rightPts.push([y, x1]); }
  }
  const lt = fitBoundary(topPts), lb = fitBoundary(botPts);
  const ll = fitBoundary(leftPts), lr = fitBoundary(rightPts);
  if (!lt || !lb || !ll || !lr) { return null; }
  // 明显不合理（字行倾斜过 30°、边界近乎平行）就别信
  if (Math.abs(lt.a) > 0.6 || Math.abs(lb.a) > 0.6) { return null; }
  if (Math.abs(ll.a) > 0.6 || Math.abs(lr.a) > 0.6) { return null; }
  // 拟合是在「行做 x」的坐标系里，换回 x = c·y + d
  const L1 = { a: lt.a, b: lt.b };                    // 上边：y = a x + b
  const L2 = { a: lb.a, b: lb.b };                    // 下边
  const LL = { c: ll.a, d: ll.b };                    // 左边：x = c y + d
  const LR = { c: lr.a, d: lr.b };                    // 右边
  const tl = crossBounds(L1, LL), tr = crossBounds(L1, LR);
  const br = crossBounds(L2, LR), bl = crossBounds(L2, LL);
  if (!tl || !tr || !br || !bl) { return null; }
  const quad = [tl, tr, br, bl];
  // 有效面积、边长检查
  const area = Math.abs(polyArea(quad)) / (w * h);
  if (area < 0.15) { return null; }
  const side = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const bw = Math.max(side(tl, tr), side(bl, br));
  const bh = Math.max(side(tl, bl), side(tr, br));
  if (bw < w * 0.3 || bh < h * 0.15) { return null; }

  // 往外放一点余量，别把纸面留白切光
  const cx = (tl[0] + tr[0] + br[0] + bl[0]) / 4;
  const cy = (tl[1] + tr[1] + br[1] + bl[1]) / 4;
  const pad = 1.035;
  const grown = quad.map(p => {
    const x = cx + (p[0] - cx) * pad, y = cy + (p[1] - cy) * pad;
    return [Math.min(w - 0.5, Math.max(0, x)) / sc, Math.min(h - 0.5, Math.max(0, y)) / sc];
  });

  // 量一下「歪了多少」：上边斜率、左右高度差
  const tilt = Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) * 180 / Math.PI;
  const hL = side(tl, bl), hR = side(tr, br);
  const skew = Math.abs(hL - hR) / Math.max(hL, hR, 1);
  return { quad: grown, tilt: tilt, skew: skew };
}

/** 自动识别：缩图 → 亮度 Otsu → 最大亮块 → 轮廓凸包 → 最大面积四边形 */
function detectPageQuad(cv) {
  const MAXD = 520;
  const sc = Math.min(1, MAXD / Math.max(cv.width, cv.height));
  const w = Math.max(16, Math.round(cv.width * sc)), h = Math.max(16, Math.round(cv.height * sc));
  const t = document.createElement('canvas');
  t.width = w; t.height = h;
  const g = t.getContext('2d');
  try { g.drawImage(cv, 0, 0, w, h); } catch (e) { return null; }
  let data;
  try { data = g.getImageData(0, 0, w, h).data; } catch (e) { return null; }

  const n = w * h;
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const l = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
    lum[p] = l; hist[l]++;
  }
  // Otsu 阈值
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = i; }
  }

  let flat = false;
  for (const bright of [true, false]) {
    const mask = new Uint8Array(n);
    for (let p = 0; p < n; p++) mask[p] = (bright ? lum[p] > thr : lum[p] <= thr) ? 1 : 0;
    const res = quadFromMask(mask, w, h);
    if (!res) continue;
    if (res.coverage > 0.965) { flat = true; continue; }
    const quad = res.quad;
    const s2 = Math.abs(shoelace(quad)) / (w * h);
    if (s2 > 0.14 && s2 < 0.965) return quad.map(p => [p[0] / sc, p[1] / sc]);
  }
  // 纸面铺满整张图：没有可见纸边，谈不上校正
  return flat ? 'flat' : null;
}

/** 最大连通域 → 轮廓点 → 凸包 → 最大面积四边形（像素坐标） */
function quadFromMask(mask, w, h) {
  const n = w * h;
  const seen = new Uint8Array(n);
  let bestPix = null, bestCount = 0;
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0, count = 0;
    stack[sp++] = start;
    seen[start] = 1;
    const idx = [];
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      count++;
      idx.push(p);
      if (x > 0) { const q = p - 1; if (mask[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; } }
      if (x < w - 1) { const q = p + 1; if (mask[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; } }
      if (y > 0) { const q = p - w; if (mask[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; } }
      if (y < h - 1) { const q = p + w; if (mask[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; } }
    }
    if (count > bestCount) { bestCount = count; bestPix = idx; }
  }
  if (!bestPix || bestCount < n * 0.1) return null;

  // 只取轮廓（上下左右有邻居在域外的像素），并控一下点数
  const step = Math.max(1, Math.ceil(bestPix.length / 60000));
  const edge = [];
  for (let i = 0; i < bestPix.length; i += step) {
    const p = bestPix[i], x = p % w, y = (p / w) | 0;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        !mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w]) {
      edge.push([x, y]);
    }
  }
  if (edge.length < 12) return null;
  const hull = convexHull(edge);
  if (hull.length < 4) return null;
  let quad = maxAreaQuad(hull);
  if (!quad) return null;
  quad = refineQuad(hull, quad, Math.hypot(w, h));
  // 每条边别太短，否则说明只是画面里的一个小亮斑
  const diag = Math.hypot(w, h);
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < diag * 0.2) return null;
  }
  const hullArea = Math.abs(polyArea(hull)) / n;   // 纸面占画面的比例（按轮廓面积算，不受笔迹影响）
  return { quad: orderQuad(quad), coverage: hullArea };
}

/** Andrew monotone chain 凸包 */
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** 凸包上找面积最大的四点（对角线枚举，O(n³)，n 已限在几百） */
function maxAreaQuad(hull) {
  const n = hull.length;
  const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  let bestA = 0, best = null;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let bk = -1, ba = 0;
      for (let k = i + 1; k < j; k++) { const a = tri(hull[i], hull[j], hull[k]); if (a > ba) { ba = a; bk = k; } }
      let bl = -1, bb = 0;
      for (let l = (j + 1) % n; l !== i; l = (l + 1) % n) {
        const a = tri(hull[i], hull[j], hull[l]);
        if (a > bb) { bb = a; bl = l; }
      }
      const area = ba + bb;
      if (bk >= 0 && bl >= 0 && area > bestA) { bestA = area; best = [hull[i], hull[bk], hull[j], hull[bl]]; }
    }
  }
  return best;
}

/** 角点精修：把四条边附近的凸包点各拟合一条直线，相邻直线求交 */
function refineQuad(hull, quad, diag) {
  const q = orderQuad(quad).slice();
  const tol = diag * 0.045;
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    if (len2 < 1) return q;
    const near = [];
    for (const p of hull) {
      const t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
      if (t < 0.08 || t > 0.92) continue;
      const dx = p[0] - (a[0] + t * vx), dy = p[1] - (a[1] + t * vy);
      if (dx * dx + dy * dy <= tol * tol) near.push(p);
    }
    if (near.length < 8) return q;                  // 点太少就不精修
    lines.push(fitLine(near));
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = lineCross(lines[(i + 3) % 4], lines[i]);
    if (!p) return q;
    out.push(p);
  }
  const ref = orderQuad(out);
  const a1 = Math.abs(shoelace(q)), a2 = Math.abs(shoelace(ref));
  if (a2 < a1 * 0.85 || a2 > a1 * 1.15) return q;   // 精修跑偏了就放弃
  return ref;
}

/** 最小二乘直线：返回 {px,py,dx,dy} 过点+方向 */
function fitLine(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p[0] - mx, dy = p[1] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);   // 主轴方向
  return { px: mx, py: my, dx: Math.cos(th), dy: Math.sin(th) };
}

/** 两条直线求交 */
function lineCross(l1, l2) {
  const den = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
  return [l1.px + t * l1.dx, l1.py + t * l1.dy];
}

/** 排成 TL → TR → BR → BL 的顺序（顺时针，屏幕坐标 y 向下） */
function orderQuad(pts) {
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const arr = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let s = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i][0] + arr[i][1] < arr[s][0] + arr[s][1]) s = i;
  return arr.slice(s).concat(arr.slice(0, s));
}

/** 找文字行的倾斜角（度）：行投影最锐时的剪切角 */
function detectSkew(cv) {
  const MAXD = 560;
  const sc = Math.min(1, MAXD / Math.max(cv.width, cv.height));
  const w = Math.max(32, Math.round(cv.width * sc)), h = Math.max(32, Math.round(cv.height * sc));
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const g = t.getContext('2d');
  try { g.drawImage(cv, 0, 0, w, h); } catch (e) { return 0; }
  let data;
  try { data = g.getImageData(0, 0, w, h).data; } catch (e) { return 0; }
  const n = w * h, lum = new Uint8Array(n), hist = new Uint32Array(256);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const l = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
    lum[p] = l; hist[l]++;
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const b = wB * wF * (mB - mF) * (mB - mF);
    if (b > best) { best = b; thr = i; }
  }
  const dark = new Uint8Array(n);
  let cnt = 0;
  for (let p = 0; p < n; p++) if (lum[p] <= thr) { dark[p] = 1; cnt++; }
  if (cnt < n * 0.002 || cnt > n * 0.6) return 0;      // 几乎没有笔画，谈不上倾斜

  const span = Math.ceil(w * 0.15) + 2;
  const score = (deg) => {
    const k = Math.tan(deg * Math.PI / 180);
    const prof = new Float32Array(h + span * 2);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (!dark[row + x]) continue;
        const yy = Math.round(y - k * (x - w / 2)) + span;
        if (yy >= 0 && yy < prof.length) prof[yy]++;
      }
    }
    let acc = 0;
    for (let i = 0; i < prof.length; i++) acc += prof[i] * prof[i];
    return acc;
  };
  const base = score(0);
  let bestDeg = 0, bestScore = base;
  for (let deg = -8; deg <= 8.001; deg += 0.5) {
    if (Math.abs(deg) < 0.01) continue;
    const sc2 = score(deg);
    if (sc2 > bestScore) { bestScore = sc2; bestDeg = deg; }
  }
  if (bestScore < base * 1.015) return 0;               // 提升不明显就算没倾斜
  return bestDeg;
}

/** 按角度把整张图转正，再裁掉四角透明 */
function applySkew(deg) {
  const cv = MEDIA_EL.querySelector('#ml-canvas');
  const w = cv.width, h = cv.height;
  const a = -deg * Math.PI / 180;                       // 画布 rotate 正方向是顺时针
  const co = Math.abs(Math.cos(a)), si = Math.abs(Math.sin(a));
  const W = Math.round(w * co + h * si), H = Math.round(w * si + h * co);
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const g = out.getContext('2d');
  g.translate(W / 2, H / 2);
  g.rotate(a);
  g.drawImage(cv, -w / 2, -h / 2);
  const box = alphaBBox(out);
  if (!box) return toast('摆正没成功，换张图试试');
  const fin = document.createElement('canvas');
  fin.width = box.w; fin.height = box.h;
  fin.getContext('2d').drawImage(out, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const url = fin.toDataURL('image/png');
  const prev = mediaSnapshot();
  const im = new Image();
  im.onload = () => {
    MED.hist.push(prev);
    MED.img = im; MED.rot = 0; MED.fh = false; MED.fv = false;
    mediaDraw();
    toast('已摆正 ' + Math.abs(deg).toFixed(1) + '°，记得点「保存」');
  };
  im.src = url;
}

/** 非透明像素的外接框 */
function alphaBBox(cv) {
  const w = cv.width, h = cv.height;
  const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] < 8) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 进手动透视：先把旋转/翻转烘焙成像素，再让四个角对着像素拖 */
function enterPersp() {
  const box = MEDIA_EL;
  const cv = box.querySelector('#ml-canvas');
  const tmp = document.createElement('canvas');
  tmp.width = cv.width; tmp.height = cv.height;
  tmp.getContext('2d').drawImage(cv, 0, 0);
  const url = tmp.toDataURL('image/png');
  const prev = mediaSnapshot();
  const im = new Image();
  im.onload = () => {
    PERSP = { prev: prev };
    MED.img = im; MED.rot = 0; MED.fh = false; MED.fv = false;
    QUAD = [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]];
    mediaDraw();
    box.querySelector('.ml-quad').hidden = false;
    box.querySelector('[data-mact="persp"]').classList.add('on');
    drawQuad();
    toast('把四个圆点拖到纸的四个角上，再点一次「透视矫正」应用');
  };
  im.src = url;
}

function exitPersp() {
  const box = MEDIA_EL;
  if (!box) return;
  if (PERSP) { mediaRestore(PERSP.prev); }
  PERSP = null; QUAD = null;
  box.querySelector('.ml-quad').hidden = true;
  box.querySelector('[data-mact="persp"]').classList.remove('on');
  mediaDraw();
}

/** 8 元一次方程组：解出「输出矩形 → 源四边形」的单应矩阵 */
function homography(dst, src) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const x = dst[i][0], y = dst[i][1], u = src[i][0], v = src[i][1];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    const t = A[c]; A[c] = A[p]; A[p] = t;
    const tb = b[c]; b[c] = b[p]; b[p] = tb;
    const piv = A[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / piv;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / (A[i][i] || 1e-12));
}

/** 把 srcCanvas 里由 quad 圈出的四边形，重采样成 W×H 的矩形 */
function warpToRect(srcCanvas, quad, W, H) {
  const sw = srcCanvas.width, sh = srcCanvas.height;
  const sd = srcCanvas.getContext('2d').getImageData(0, 0, sw, sh).data;
  const h = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const img = octx.createImageData(W, H);
  const od = img.data;
  let o = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const den = h[6] * x + h[7] * y + 1;
      const d2 = Math.abs(den) < 1e-9 ? 1e-9 : den;
      const u = (h[0] * x + h[1] * y + h[2]) / d2;
      const v = (h[3] * x + h[4] * y + h[5]) / d2;
      let r = 0, g = 0, b = 0, a = 0;
      if (u >= 0 && v >= 0 && u <= sw - 1 && v <= sh - 1) {
        const x0 = u | 0, y0 = v | 0;
        const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
        const fx = u - x0, fy = v - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy, w11 = fx * fy;
        r = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        g = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        b = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        a = sd[i00 + 3] * w00 + sd[i10 + 3] * w10 + sd[i01 + 3] * w01 + sd[i11 + 3] * w11;
      }
      od[o] = r; od[o + 1] = g; od[o + 2] = b; od[o + 3] = a;
      o += 4;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/** 用给的四角做矫正（自动、手动共用） */
function applyQuad(q, prev, msg) {
  const cv = MEDIA_EL.querySelector('#ml-canvas');
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const wTop = dist(q[0], q[1]), wBot = dist(q[3], q[2]);
  const hLeft = dist(q[0], q[3]), hRight = dist(q[1], q[2]);
  let W = Math.round(Math.max(wTop, wBot)), H = Math.round(Math.max(hLeft, hRight));
  const MAXD = 2600;
  const k = Math.min(1, MAXD / Math.max(W, H, 1));
  W = Math.max(8, Math.round(W * k)); H = Math.max(8, Math.round(H * k));
  toast('正在矫正…');
  setTimeout(() => {
    let url;
    try { url = warpToRect(cv, q, W, H).toDataURL('image/png'); }
    catch (e) { return toast('矫正失败：' + e.message); }
    const im = new Image();
    im.onload = () => {
      if (prev) MED.hist.push(prev);
      MED.img = im; MED.rot = 0; MED.fh = false; MED.fv = false;
      if (PERSP) { PERSP = null; QUAD = null; }
      MEDIA_EL.querySelector('.ml-quad').hidden = true;
      MEDIA_EL.querySelector('[data-mact="persp"]').classList.remove('on');
      mediaDraw();
      toast(msg || '已矫正成正视，记得点「保存」');
    };
    im.src = url;
  }, 30);
}

function applyPersp() {
  if (!QUAD) return;
  const cv = MEDIA_EL.querySelector('#ml-canvas');
  const q = QUAD.map(p => [p[0] * cv.width, p[1] * cv.height]);
  const prev = PERSP ? PERSP.prev : null;
  applyQuad(q, prev);
}

async function mediaSave() {
  const box = MEDIA_EL;
  if (!box || !MED.img) return;
  const ext = (MED.name.split('.').pop() || 'png').toLowerCase();
  if (ext === 'gif' || ext === 'svg') return toast('GIF / SVG 不能这样保存，换张图试试');
  const cv = box.querySelector('#ml-canvas');
  const type = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
             : ext === 'webp' ? 'image/webp' : 'image/png';
  let data;
  try { data = cv.toDataURL(type, 0.94); }
  catch (e) { return toast('导出图片失败：' + e.message); }
  try {
    const r = await post('/api/media/save', { path: MED.path, data: data });
    MED.mtime = r.mtime;
    const it = MEDIA.items.find(x => x.path === MED.path);
    if (it) { it.mtime = r.mtime; it.size = r.size; }
    IMG_VER.set(r.path, r.mtime);
    bustPreviewImage(r.path, r.mtime);
    if (el.preview && S.current) {                   // 重渲染一次，正文里的同一张图立刻换新
      const sc = el.preview.scrollTop;
      render();
      el.preview.scrollTop = sc;
    }
    const th = box.querySelectorAll('.ml-thumb')[MEDIA.idx];
    if (th) { const im = th.querySelector('img'); if (im && it) im.src = it.url + '&v=' + r.mtime; }
    if (MEDIA.from === 'preview') { closeMedia(); toast('已保存，回到正文'); return; }
    // 媒体库里存完回到「看大图」，原始基准也换成新图
    await openEditDone(r.mtime);
    toast('已保存（' + MED.name + '）');
  } catch (e) { toast('保存失败：' + (e.message || '未知错误')); }
}

async function openEditDone(mtime) {
  let rec = MEDIA.items.find(x => x.path === MED.path) ||
              { path: MED.path, name: MED.name, mtime: mtime, url: '/api/raw?path=' + encodeURIComponent(MED.path) };
  rec = Object.assign({}, rec, { mtime: mtime });
  await mediaOpenFile(rec, !!MED.foreign, 'view');
}

/** 保存后让预览里的同一张图立刻换新（URL 上带 v= 破缓存） */
function bustPreviewImage(rel, mtime) {
  if (!el.preview) return;
  $$('#preview img').forEach(im => {
    const src = im.getAttribute('src') || '';
    if (imgPathFromSrc(src) !== rel) return;
    im.setAttribute('src', src.split('&v=')[0] + '&v=' + mtime);
  });
}


/* ══ 动作 ═══════════════════════════════════════════════ */
/** 图片灯箱：点预览里的图放大看，← → 翻页，Esc/点背景关闭 */
function openLightbox(src, alt) {
  const all = Array.prototype.slice.call(el.preview.querySelectorAll('img'))
    .map(i => ({ src: i.getAttribute('src'), alt: i.getAttribute('alt') || '' }));
  let idx = Math.max(0, all.findIndex(x => x.src === src));
  if (!all.length) all.push({ src: src, alt: alt || '' });

  const box = document.createElement('div');
  box.className = 'lightbox';
  const draw = () => {
    const cur = all[idx] || { src: src, alt: alt };
    box.innerHTML =
      (all.length > 1 ? '<div class="lb-nav lb-prev" title="上一张（←）">‹</div>' : '') +
      '<img src="' + cur.src + '" alt="">' +
      (all.length > 1 ? '<div class="lb-nav lb-next" title="下一张（→）">›</div>' : '') +
      '<div class="cap">' + esc(cur.alt || '') + (all.length > 1 ? '　·　' + (idx + 1) + ' / ' + all.length : '') + '</div>';
  };
  draw();
  const goto = d => { idx = (idx + d + all.length) % all.length; draw(); };
  box.addEventListener('click', e => {
    if (e.target.closest('.lb-prev')) { e.stopPropagation(); goto(-1); return; }
    if (e.target.closest('.lb-next')) { e.stopPropagation(); goto(1); return; }
    if (e.target.closest('img')) return;              // 点图片本身不关
    box.remove();
  });
  const key = e => {
    if (!document.body.contains(box)) { document.removeEventListener('keydown', key); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); goto(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); goto(1); }
    else if (e.key === 'Escape') { e.preventDefault(); box.remove(); }
  };
  document.addEventListener('keydown', key);
  document.body.appendChild(box);
}

/** 导出这篇笔记为 Markdown 文件（就是磁盘上的原文，任何编辑器都能打开） */
function doExportMd(path) {
  const p = path || S.current;
  if (!p) return toast('先打开一篇笔记');
  const n = S.byPath.get(p) || {};
  const title = n.title || p.split('/').pop().replace(/\.md$/, '');
  // 正文别去 byPath 节点上找（那里只有 title/size/mtime）——当前打开那篇在 S.front/S.body 里
  if (p === S.current) return saveBlob(title, (S.front || '') + (S.body || ''));   // 已打开的：直接用内存内容
  fetch('/api/raw?path=' + encodeURIComponent(p), { credentials: 'same-origin' })
    .then(r => { if (!r.ok) throw new Error('找不到文件'); return r.text(); })
    .then(t => saveBlob(title, t))
    .catch(e => toast('导出失败：' + e.message));
}

function saveBlob(title, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = title.replace(/[\\/:*?"<>|]/g, '-') + '.md';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('已导出 ' + a.download);
}

/* 右键「新建文件夹」：落在 ctxDir 那一层 */
async function doNewDir(dir) {
  const name = await ask('文件夹名称', '新建文件夹');
  if (!name) return;
  const r = await post('/api/mkdir', { name: name, dir: dir || '' });   // 服务端收 name/dir 两个字段
  await loadTree(true); toast('已新建文件夹「' + (r.name || name) + '」');
}

/* 右键「新建文件」：落在 ctxDir 那一层 */
async function doNewDoc(dir) {
  const title = await ask('笔记标题', '新笔记');
  if (!title) return;
  const r = await post('/api/create', { dir: dir || '', title });
  await loadTree(true);
  await openDoc(r.path, { force: true });
  el.editor.focus();
}

/* 右键「导出为 ZIP」：把文件夹连同子目录打成 zip，纯前端做 */
async function doExportZip(dir, isAll) {
  if (!dir && !isAll) return toast('先选中一个文件夹');
  const base = isAll ? '速笺-全部笔记' : (dir.split('/').pop() || 'archive');
  const all = [];
  (function walk(ns) { for (const n of ns) {
    if (n.type === 'dir') walk(n.children || []); else all.push(n.path);
  } })(S.tree);
  const files = isAll ? all.slice() : all.filter(p => p === dir || p.startsWith(dir + '/'));
  if (!files.length) return toast('这个文件夹里没有笔记');
  toast('正在打包 ' + files.length + ' 个文件…');
  try {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const u16 = n => [n & 255, (n >> 8) & 255];
    const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
    const dt = new Date();
    const time = u16((dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1));
    const date = u16(((dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate());
    const addEntry = (name, data) => {
      const nb = enc.encode(name);
      const crc = crc32(data);
      const local = [].concat([80,75,3,4, 20,0, 0,8, 0,0], time, date,
        u32(crc), u32(data.length), u32(data.length), u16(nb.length), u16(0), Array.from(nb), Array.from(data));
      central.push({ name: nb, crc, size: data.length, offset });
      parts.push(new Uint8Array(local));
      offset += local.length;
    };
    const getRaw = async p => {
      const res = await fetch('/api/raw?path=' + encodeURIComponent(p), { credentials: 'same-origin' });
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    };
    const assets = new Set();
    for (const p of files) {
      const data = await getRaw(p);
      if (!data) continue;
      addEntry(p.slice(dir.length).replace(/^\//, ''), data);
      // 正文里引用的插图一并打包，否则解压出来全是断链
      // 支持两种写法：老的 /assets/xx.png（全库目录）和新的 <笔记名>.assets/xx.png（本文目录）
      for (const m of new TextDecoder().decode(data).matchAll(/\]\(([^)\s]+\.(?:png|jpe?g|gif|webp|bmp|svg|avif))\)/gi)) {
        let ref = m[1];
        try { ref = decodeURIComponent(ref); } catch (e2) {}
        if (/^(https?:|data:)/i.test(ref)) continue;
        let rel;
        if (ref.startsWith('/assets/')) rel = 'assets/' + ref.slice(8);
        else if (ref.startsWith('/')) rel = ref.slice(1);
        else rel = (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) + '/' : '') + ref.replace(/^\.\//, '');
        if (rel) assets.add(rel);
      }
    }
    for (const n of assets) {
      const data = await getRaw(n);
      // 打包时保持相对位置：md 在 <dir>/ 下，图在 <dir>/<笔记名>.assets/ 下
      const pre = dir ? dir.replace(/^\/+|\/+$/g, '') + '/' : '';
      if (data) addEntry(pre && n.startsWith(pre) ? n.slice(pre.length) : n, data);
    }
    const cdStart = offset;
    const cdParts = [];
    for (const c of central) {
      cdParts.push(new Uint8Array([].concat([80,75,1,2, 20,0, 20,0, 0,8, 0,0], time, date,
        u32(c.crc), u32(c.size), u32(c.size), u16(c.name.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(c.offset), Array.from(c.name))));
    }
    const cdSize = cdParts.reduce((a, b) => a + b.length, 0);
    const end = new Uint8Array([].concat([80,75,5,6, 0,0, 0,0],
      u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0)));
    const blob = new Blob([...parts, ...cdParts, end], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = base.replace(/[\\/:*?"<>|]/g, '-') + '.zip';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('已导出 ' + a.download);
  } catch (e) { toast('打包失败：' + e.message); }
}

function crc32(buf) {
  let c, table = crc32._t;
  if (!table) {
    table = crc32._t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[i] = c >>> 0; }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function doNew() {
  const title = await ask('新笔记标题', '新笔记');
  if (!title) return;
  const dir = S.current ? S.current.split('/').slice(0, -1).join('/') : '';
  const r = await post('/api/create', { dir, title });
  await loadTree(true);
  await openDoc(r.path, { force: true });
  el.editor.focus();
}

async function doRename(path) {
  const p = path || ctxPath || S.current;
  if (!p) return toast('先打开一篇笔记');
  const cur = (S.byPath.get(p) || {}).title || p.split('/').pop().replace(/\.md$/, '');
  const t = await ask('新的名称', cur);
  if (!t || t === cur) return;
  const r = await post('/api/rename', { path: p, title: t });
  // 路径簿记三处跟着换：当前打开的笔记 / 展开状态 / 收藏 —— 少一处都会留下死引用
  if (r.path && r.path !== p) {
    if (S.current === p) { S.current = r.path; el.stPath.textContent = r.path; }
    else if (S.current && S.current.startsWith(p + '/')) { S.current = r.path + S.current.slice(p.length); el.stPath.textContent = S.current; }
    Array.from(S.expanded).forEach(x => {
      if (x === p) { S.expanded.delete(x); S.expanded.add(r.path); }
      else if (x.startsWith(p + '/')) { S.expanded.delete(x); S.expanded.add(r.path + x.slice(p.length)); }
    });
    const fv = favList(); let hit = 0;
    const nf = fv.map(x => {
      if (x === p) { hit++; return r.path; }
      if (x.startsWith(p + '/')) { hit++; return r.path + x.slice(p.length); }
      return x;
    });
    if (hit) localStorage.setItem('sj-fav', JSON.stringify(nf.slice(0, 200)));
  } else if (p === S.current) {
    S.current = r.path; el.stPath.textContent = r.path;
  }
  if (S.current && (S.current === r.path || S.current.startsWith(r.path + '/'))) {
    // 服务器已把 frontmatter 的 title 改掉；内存里的 front 要对齐，否则下次保存会把旧标题写回去
    try { const dd = await api('/api/doc?path=' + encodeURIComponent(S.current)); S.front = dd.front; } catch (e) { }
  }
  await loadTree(true); toast('已重命名为 ' + t);
}

async function doDelete(path) {
  const p = path || ctxPath || S.current;
  if (!p) return toast('先选中一项');
  const isDir = (function hit(ns) {
    for (const n of ns || []) { if (n.type === 'dir') { if (n.path === p) return true; if (hit(n.children)) return true; } }
    return false;
  })(S.tree);
  const name = isDir ? p.split('/').pop() : ((S.byPath.get(p) || {}).title || p.split('/').pop());
  const tip = isDir
    ? '把文件夹「' + name + '」连同里面全部内容移入回收站？'
    : '把「' + name + '」移入回收站？';
  if (!await confirm(tip, '移动至回收站')) return;
  await post('/api/delete', { path: p });
  if (S.current && (S.current === p || S.current.startsWith(p + '/'))) {
    S.current = null; S.body = ''; el.editor.value = '';
    el.preview.innerHTML = ''; el.stPath.textContent = '—'; el.stSaved.textContent = '—';
    el.stWords.textContent = '0 字'; setSaveState('idle'); S.dirty = false;
  }
  // 收藏里的这条（及其子树）一并清掉，别留点不亮的角标
  const fv = favList();
  const nf = fv.filter(x => x !== p && !x.startsWith(p + '/'));
  if (nf.length !== fv.length) localStorage.setItem('sj-fav', JSON.stringify(nf.slice(0, 200)));
  await loadTree(true); toast('已移入回收站');
}

async function doHistory() {
  if (!S.current) return toast('先打开一篇笔记');
  const r = await api('/api/history?path=' + encodeURIComponent(S.current));
  const items = r.items || [];
  el.histList.innerHTML = items.length ? items.map((it, i) =>
    `<div class="hit" data-name="${esc(it.name)}"><div class="t">${esc(it.stamp.slice(9, 11) + ':' + it.stamp.slice(11, 13) + ':' + it.stamp.slice(13, 15))}</div>
     <div class="p">${esc(it.stamp.slice(0, 8))} · ${(it.size / 1024).toFixed(1)} KB${i === 0 ? ' · 最近' : ''}</div></div>`).join('')
    : '<div class="empty-hint">还没有历史版本（保存过才会有）</div>';
  el.historyOverlay.hidden = false;
}

el.histList.addEventListener('click', async e => {
  const hit = e.target.closest('.hit'); if (!hit) return;
  const r = await post('/api/history/read', { name: hit.dataset.name });
  el.editor.value = r.body;
  S.dirty = true; setSaveState('dirty'); render();
  refreshLineno(); refreshHl();
  el.historyOverlay.hidden = true;
  toast('已载入历史版本，按 Ctrl+S 才会保存');
});

/* ══ 启动 ═══════════════════════════════════════════════ */
function showGate() {
  el.gate.hidden = false; el.app.hidden = true;
  setTimeout(() => { const f = NEEDS_SETUP ? $('#reg-user') : $('#user-name'); if (f) f.focus(); }, 50);
}

let ME = null;                       // 当前账号信息，改名后要同步刷新顶栏
let MUST_CHANGE = false;             // 初始账号（admin/admin）：没改完用户名+密码之前不许关掉用户设置

/** 把 ME 里的用户名刷到顶栏、菜单头与各处首字母头像（用户名即显示名） */
function applyMe() {
  if (!ME || !ME.user) return;
  if (el.uname) el.uname.textContent = ME.user;
  if (el.btnUser) el.btnUser.title = '账号 · ' + ME.user;
  $$('.avatar').forEach(a => {
    if (a.querySelector('img')) return;                 // 已有图就不覆盖
    a.textContent = ME.user.trim().charAt(0).toUpperCase() || '素';
  });
  el.menuHead.textContent = ME.user;                    // 用户名就是显示名
  localStorage.setItem('sj-user', ME.user);
}

async function boot(justLoggedIn) {
  let me = null;
  try { me = await api('/api/me'); } catch (e) { return; }
  ME = me;
  MUST_CHANGE = !!me.must_change;
  el.gate.hidden = true; el.app.hidden = false;
  if (me && me.user) {
    // 用户信息渲染属于「锦上添花」：任何一个节点缺失都不该让整个 boot 崩掉
    try {
      if (el.uname) el.uname.textContent = me.user;
      // 有头像图就别用 textContent 把 <img> 冲掉（上一版就是这么把头像冲没的）
      if (el.avatar && !el.avatar.querySelector('img')) {
        el.avatar.textContent = me.user.trim().charAt(0).toUpperCase() || '素';
      }
      el.menuHead.textContent = me.user;                 // 用户名就是显示名
      if (el.btnUser) el.btnUser.title = '账号 · ' + me.user;
      localStorage.setItem('sj-user', me.user);
      refreshAvatar();                                   // 登录后才拿得到头像图
    } catch (e) { console.error('用户信息渲染失败（不影响使用）', e); }
  }
  // 站名/标签标题等与服务器对齐：服务器有值以服务器为准，服务器空则把本机设置推上去
  try {
    const site = (await api('/api/site')).site || {};
    if (site.version) APP_VER = String(site.version);
    const had = Boolean(site.brand || site.tabTitle || site.logoText);
    if (site.brand) CFG.brand = site.brand;          // 服务器有值才覆盖，空值不清本机设置
    if (site.tabTitle) CFG.tabTitle = site.tabTitle;
    if (site.logoText) CFG.logoText = site.logoText;
    if (had) { saveCfg(); applyCfg(); }
    else if (CFG.brand !== DEFAULTS.brand || CFG.tabTitle || CFG.logoText) {
      pushSite();                                     // 服务器还空着：把本机设置推上去
    }
  } catch (e) {}
  await loadTree();
  const last = localStorage.getItem('sj-open');
  const target = last && S.byPath.has(last) ? last
    : (flatten(S.tree).find(([n]) => n.type === 'doc') || [null])[0]?.path;
  // 刚登录、或刷新前就停在欢迎界面：保持欢迎界面不变（刷新不该跳去文件页、也不该改左栏选择）
  const wantWelcome = (function () { try { return localStorage.getItem('sj-welcome') === '1'; } catch (e) { return false; } })();
  if (justLoggedIn || wantWelcome) setWelcome(true);
  else if (target) await openDoc(target, { force: true });
  else setWelcome(true);
  if (MUST_CHANGE) setTimeout(openAcct, 260);        // 初始账号：先把资料改掉
  if (!justLoggedIn) return;
}

/* 全局兜底：出错也要看得见，绝不静默失败 */
let _lastErr = 0;
window.addEventListener('error', ev => {
  const msg = (ev.message || '') + '';
  console.error('页面出错:', msg, ev.filename, ev.lineno);
  if (Date.now() - _lastErr > 4000 && el && el.toast) { _lastErr = Date.now(); toast('界面出了点问题：' + msg.slice(0, 60)); }
});
window.addEventListener('unhandledrejection', ev => {
  const r = ev.reason || {};
  console.error('未处理的异步错误:', r);
  if (Date.now() - _lastErr > 4000 && el && el.toast) { _lastErr = Date.now(); toast('操作失败：' + String(r.message || r).slice(0, 60)); }
});

(async function init() {
  try { applyTheme(); } catch (e) { window.__bindErr.push('applyTheme: ' + e.message); }
  setView(localStorage.getItem('sj-view') || (innerWidth <= 860 ? 'edit' : 'split'));
  localStorage.removeItem('sj-ratio');   // 分栏比例改用 sj-split-pct / --split-pct，旧键作废
  // bind() 里任何一条绑定失败都只记下来，不能让整页起不来
  try { bind(); }
  catch (e) {
    window.__bindErr.push('bind: ' + (e.message || e));
    console.error('bind 失败：', e);
    toast('界面初始化不完整：' + String(e.message || e).slice(0, 60));
  }
  try { await api('/api/me'); } catch (e) { return; }
  try { await boot(); }
  catch (e) { window.__bindErr.push('boot: ' + (e.message || e)); console.error('boot 失败：', e); }
})();

})();
