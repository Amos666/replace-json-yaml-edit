/* ============================================================================
 * Batch Replace for JSON & YAML — Webview 前端逻辑
 *
 * 单一接口基准：src/shared/protocol.ts。消息名与顶层字段一字不改。
 * 前端只维护：输入态（指令、目标格式默认值、扩展名策略模板、过滤串、glob 编辑）、
 *   视图态（tree/flat、展开折叠、只看开关、审阅进度显示、diff 文本模式）等纯 UI 状态，
 *   并经 vscode.setState/getState 持久化。
 * 扫描结果（tree/flat/counts/candidateExtensions/equivalentGlob）、diff、审阅队列、
 *   报告一律由宿主消息下发；前端不自行计算最终扫描结果。
 * 树筛选「命中集 H」按 §6.3「在已建树数据上前端求值」做显示/批量作用集合判定，
 *   优先采用宿主下发的 hitRanges，缺省时回退到本地显示用匹配器。
 * ==========================================================================*/
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /* ── 工具 ─────────────────────────────────────────────── */
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function el(id) { return document.getElementById(id); }
  function ic(name, extra) {
    return '<span class="codicon codicon-' + name + (extra ? ' ' + extra : '') + '" aria-hidden="true"></span>';
  }
  function post(msg) { vscode.postMessage(msg); }
  function uid() { return 'i' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }

  const timers = {};
  function debounce(key, ms, fn) { clearTimeout(timers[key]); timers[key] = setTimeout(fn, ms); }

  /* ── 状态 ─────────────────────────────────────────────── */
  const PREFS = ['targetFormat', 'extPolicy', 'customInclude', 'customExclude', 'view',
    'onlyApplicable', 'onlyHits', 'showAll', 'expanded', 'activeDiff', 'globMode',
    'activeInstructionId', 'filter'];

  function zeroCounts() {
    return { changes: 0, files: 0, warnings: 0, parseErrors: 0, conflicts: 0, scanned: 0, total: 0 };
  }

  const S = {
    hasInit: false,
    title: 'Batch Replace for JSON & YAML',
    phase: 'input',
    counts: zeroCounts(),
    instructions: [],
    targetFormat: 'json',                 // 'json' | 'yaml' | 'sed' —— 新建指令默认值（UI-only）
    extPolicy: 'all',                    // 'all' | 'custom' —— 新建文本指令默认 fileScope（UI-only）
    customInclude: [],
    customExclude: [],
    filter: {
      raw: '', include: [], exclude: [], view: 'tree',
      rows: [],          // 多级筛选条件行 [{id,dim,op,value}]
      dirs: [],          // 目录层级下钻链（逐级聚焦）
      mode: 'and',       // 条件行之间 AND / OR
      onlySelected: false,
      advanced: false,
    },
    view: 'tree',
    onlyApplicable: false,
    onlyHits: false,
    showAll: false,
    selection: {
      baseInclude: [], baseExclude: [],
      treeFilter: { raw: '', include: [], exclude: [], view: 'tree' },
      overrides: { add: [], remove: [] },
    },
    candidateExtensions: [],
    equivalentGlob: [],
    tree: [],
    flat: [],
    expanded: {},
    resultExpanded: {},             // 第③步只读结果树的目录展开态（默认全展开）
    diffs: [],
    activeDiff: null,
    report: null,
    review: { active: false, index: 0, total: 0, item: null, message: '' },
    errors: [],
    globMode: 'edit',                    // 'edit' | 'summary'
    customSelection: false,
    activeInstructionId: null,
    // 瞬态（不持久化）
    scopeEditId: null,
    diffTextMode: false,
    focusPath: null,
    globExpanded: false,              // 等效 glob 面板纯 UI 折叠态（不影响 globMode/customSelection 语义）
    step: 1,                          // 三步向导：① 选择文件 ② 编辑值 ③ 预览并应用（不持久化）
    moreOpen: false,                  // 第①步「更多」高级选项折叠态
    previewUri: '',                   // 双击预览弹框当前文件
    scopeRoot: null,                  // 扫描根目录（null = VS Code 打开的工作区；由宿主 init/state 下发）
    canUndo: false,                     // 是否存在可回退的上次应用快照
    undoFiles: 0,                       // 可回退的文件数
  };

  const STEPS = [
    { id: 1, label: '选要修改文件' },
    { id: 2, label: '写修改的命令' },
    { id: 3, label: '应用执行' },
  ];

  try {
    const saved = vscode.getState();
    if (saved && typeof saved === 'object') {
      PREFS.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(saved, k)) S[k] = saved[k]; });
    }
  } catch (e) { /* getState 不可用时用默认值 */ }

  function persist() {
    try { const o = {}; PREFS.forEach(function (k) { o[k] = S[k]; }); vscode.setState(o); } catch (e) {}
  }

  let flatByPath = Object.create(null);
  let flatVersion = 0;
  let visCache = { key: '', value: [] };
  let hitCache = { key: '', value: new Set() };
  let selCache = { key: '', version: -1, value: [] };
  let dirStats = Object.create(null);

  /** Shift 范围勾选的锚点（当前视图内的路径）。 */
  let lastTriPath = null;

  /** 文件列表或勾选态变化时递增，用于失效前端派生缓存。 */
  function bumpFlatVersion() {
    flatVersion += 1;
    visCache = { key: '', value: [] };
    hitCache = { key: '', value: new Set() };
    selCache = { key: '', version: -1, value: [] };
  }
  function rebuildMaps() {
    flatByPath = Object.create(null);
    S.flat.forEach(function (f) { flatByPath[f.path] = f; });
  }

  /* ── 归一化 ───────────────────────────────────────────── */
  function normalizeFilter(f) {
    f = f || {};
    var rows = Array.isArray(f.rows) ? f.rows.map(function (r) {
      return {
        id: (r && typeof r.id === 'string') ? r.id : uid(),
        dim: (r && (r.dim === 'ext' || r.dim === 'state')) ? r.dim : 'path',
        op: (r && r.op === 'exclude') ? 'exclude' : 'include',
        value: (r && typeof r.value === 'string') ? r.value : '',
      };
    }) : [];
    return {
      raw: typeof f.raw === 'string' ? f.raw : '',
      include: Array.isArray(f.include) ? f.include.slice() : [],
      exclude: Array.isArray(f.exclude) ? f.exclude.slice() : [],
      view: f.view === 'flat' ? 'flat' : 'tree',
      rows: rows,
      dirs: Array.isArray(f.dirs) ? f.dirs.filter(function (d) { return typeof d === 'string' && d; }).slice() : [],
      mode: f.mode === 'or' ? 'or' : 'and',
      onlySelected: !!f.onlySelected,
      advanced: !!f.advanced,
    };
  }
  function normalizeSelection(s) {
    s = s || {}; const ov = s.overrides || {};
    return {
      baseInclude: Array.isArray(s.baseInclude) ? s.baseInclude.slice() : [],
      baseExclude: Array.isArray(s.baseExclude) ? s.baseExclude.slice() : [],
      treeFilter: normalizeFilter(s.treeFilter),
      overrides: {
        add: Array.isArray(ov.add) ? ov.add.slice() : [],
        remove: Array.isArray(ov.remove) ? ov.remove.slice() : [],
      },
    };
  }
  function normalizeIns(i) {
    const o = Object.assign({ id: uid(), enabled: true, engine: 'structured', fileScope: null }, i || {});
    if (!o.id) o.id = uid();
    if (!o.fileScope) {
      o.fileScope = o.engine === 'structured'
        ? { mode: 'fixed', format: o.format || 'json' }
        : { mode: 'all' };
    }
    return o;
  }

  function curEngine() { return S.targetFormat === 'sed' ? 'text' : 'structured'; }
  function policyScope() {
    if (S.extPolicy !== 'custom') return { mode: 'all' };
    return { mode: 'custom', include: S.customInclude.slice(), exclude: S.customExclude.slice() };
  }
  function scopeText(fs) {
    fs = fs || { mode: 'all' };
    if (fs.mode === 'fixed') return fs.format === 'yaml' ? '*.yaml, *.yml' : '*.json, *.jsonc';
    if (fs.mode === 'all') return '全部类型';
    const inc = fs.include || [], exc = fs.exclude || [];
    return '自定义: ' + (inc.length ? inc.join(', ') : '（空=全部）') + (exc.length ? ' · 排除 ' + exc.join(', ') : '');
  }
  /** 扫描根目录徽标：过长路径只保留末三段（完整路径在 title 里）。 */
  function shortRoot(p) {
    const parts = String(p).split('/').filter(Boolean);
    return parts.length <= 3 ? String(p) : '…/' + parts.slice(-3).join('/');
  }
  function ariaChecked(v) { return v === 'mixed' ? 'mixed' : (v ? 'true' : 'false'); }

  /* ── 发消息（严格按 protocol.ts） ───────────────────────── */
  function commitInstructions(immediate) {
    const send = function () { post({ type: 'setInstructions', instructions: S.instructions }); };
    if (immediate) { clearTimeout(timers.ins); send(); } else { debounce('ins', 300, send); }
    persist();
  }
  function sendScope(ins) { post({ type: 'setScope', instructionId: ins.id, scope: ins.fileScope }); }
  function sendFilter(immediate) {
    const send = function () { post({ type: 'setFilter', raw: composeRaw(), view: S.view }); };
    if (immediate) { clearTimeout(timers.filter); send(); } else { debounce('filter', 150, send); }
    persist();
  }
  function sendGlob() {
    debounce('glob', 300, function () {
      post({ type: 'setGlob', include: S.selection.baseInclude.slice(), exclude: S.selection.baseExclude.slice() });
    });
    persist();
  }
  /**
   * 立即发送所有防抖中的输入（指令 / 筛选 / glob）。
   * 在「扫描 / 换步 / 预览 / 应用」前调用，避免宿主拿上一版指令出结果
   * （反馈 bug5：修改值后不起效，多因 300ms 防抖窗口内直接点了下一步/应用）。
   */
  function flushPending() {
    if (timers.ins) { clearTimeout(timers.ins); timers.ins = undefined; post({ type: 'setInstructions', instructions: S.instructions }); }
    if (timers.filter) { clearTimeout(timers.filter); timers.filter = undefined; post({ type: 'setFilter', raw: S.filter.raw, view: S.view }); }
    if (timers.glob) { clearTimeout(timers.glob); timers.glob = undefined; post({ type: 'setGlob', include: S.selection.baseInclude.slice(), exclude: S.selection.baseExclude.slice() }); }
  }

  /* ── 显示用筛选匹配（§6.3，非扫描结果） ────────────────── */
  function globToRegex(g) {
    let out = '^';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*') { if (g[i + 1] === '*') { out += '.*'; i++; } else { out += '[^/]*'; } }
      else if (c === '?') out += '[^/]';
      else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(out + '$', 'i');
  }
  function tokenMatches(path, tok) {
    const p = path.toLowerCase(), t = tok.toLowerCase();
    if (!t) return true;
    if (t.indexOf('ext:') === 0) {
      const alias = { yaml: ['yaml', 'yml'], yml: ['yaml', 'yml'], json: ['json', 'jsonc'], jsonc: ['json', 'jsonc'] };
      let exts = t.slice(4).split(',').map(function (s) { return s.replace(/^\*?\.?/, ''); }).filter(Boolean);
      exts = exts.reduce(function (acc, e) { return acc.concat(alias[e] || [e]); }, []);
      const base = p.split('/').pop();
      const ext = base.indexOf('.') >= 0 ? base.split('.').pop() : '';
      return exts.some(function (e) { return e === '*' || ext === e || ('*.' + ext) === e; });
    }
    if (t.indexOf('*') >= 0 || t.indexOf('?') >= 0 || t.indexOf('/') >= 0) {
      // 与宿主 matchTreeFilter 对齐：原样 / 同义扩展名 / `**/` 任意深度 / 仅文件名 都要认。
      const name = p.split('/').pop();
      const cands = [t, '**/' + t];
      if (t === '*.yaml' || t === '*.yml') cands.push('*.yaml', '*.yml', '**/*.yaml', '**/*.yml');
      else if (t === '*.json' || t === '*.jsonc') cands.push('*.json', '*.jsonc', '**/*.json', '**/*.jsonc');
      return cands.some(function (g) { return globToRegex(g).test(p) || globToRegex(g).test(name); });
    }
    return p.indexOf(t) >= 0;
  }
  function parseFilter(raw) {
    const inc = [], exc = [];
    (raw || '').trim().split(/\s+/).forEach(function (tok) {
      if (!tok) return;
      let neg = false, t = tok;
      if (t[0] === '!' || t[0] === '-') { neg = true; t = t.slice(1); }
      if (!t) return;
      (neg ? exc : inc).push(t);
    });
    return { inc: inc, exc: exc };
  }
  function matchFilter(path, raw) {
    const pf = parseFilter(raw);
    if (!(raw || '').trim()) return true;
    for (const t of pf.exc) if (tokenMatches(path, t)) return false;
    if (!pf.inc.length) return true;
    for (const t of pf.inc) if (!tokenMatches(path, t)) return false;
    return true;
  }
  /* ── 多级筛选：条件行 + 目录层级链 ─────────────────────────
   * 参考成熟树选择器的做法：筛选表达式结构化、逐条可删可计数；
   * 目录链逐级聚焦；可见性完全由前端求值，宿主 raw 只用于高亮回显。 */
  function rowToken(row) {
    var v = (row.value || '').trim();
    if (!v) return '';
    if (row.dim === 'ext') return 'ext:' + v.replace(/^ext:/i, '').replace(/^\*?\.?/, '');
    return v;
  }
  function rowMatches(f, row) {
    var v = (row.value || '').trim();
    if (!v) return true;                    // 空条件不约束，方便边输入边看结果
    var hit;
    if (row.dim === 'ext') {
      hit = tokenMatches(f.path, 'ext:' + v.replace(/^ext:/i, '').replace(/^\*?\.?/, ''));
    } else if (row.dim === 'state') {
      if (v === 'selected') hit = f.checked === true;
      else if (v === 'hits') hit = (f.changeCount || 0) > 0;
      else if (v === 'applicable') hit = !!f.applicable;
      else hit = true;
    } else {
      hit = tokenMatches(f.path, v);
    }
    return row.op === 'exclude' ? !hit : hit;
  }
  /** 把结构化条件折成宿主可解析的表达式（state 维度/OR 仅前端生效）。 */
  function composeRaw() {
    var parts = [];
    var dirs = S.filter.dirs;
    if (dirs.length) parts.push(dirs[dirs.length - 1] + '/**');
    S.filter.rows.forEach(function (r) {
      if (r.dim === 'state' || !r.value.trim()) return;
      var tok = rowToken(r);
      if (tok) parts.push((r.op === 'exclude' ? '!' : '') + tok);
    });
    var quick = (S.filter.raw || '').trim();
    if (quick) parts.push(quick);
    return parts.join(' ');
  }
  function passFilter(f) {
    var fl = S.filter;
    // 0.2.1：结构化模式（JSON/YAML）下，非目标后缀文件直接从树中隐藏，
    // 不再灰显；「显示全部」高级开关可临时覆盖。
    if (isLocked(f) && !S.showAll) return false;
    if (fl.onlySelected && (f.checked !== true || isLocked(f))) return false;
    if (S.onlyHits && !(f.changeCount > 0)) return false;
    if (!S.showAll && S.onlyApplicable && !f.applicable) return false;
    // 层级链：落在最窄一级目录内（上级天然被包含）
    if (fl.dirs.length) {
      var d = fl.dirs[fl.dirs.length - 1];
      if (f.path.indexOf(d + '/') !== 0) return false;
    }
    var inc = [], exc = [];
    fl.rows.forEach(function (r) { if (r.value.trim()) (r.op === 'exclude' ? exc : inc).push(r); });
    for (var i = 0; i < exc.length; i += 1) if (!rowMatches(f, exc[i])) return false;
    if (inc.length) {
      if (fl.mode === 'or') {
        var any = false;
        for (var j = 0; j < inc.length; j += 1) if (rowMatches(f, inc[j])) { any = true; break; }
        if (!any) return false;
      } else {
        for (var k = 0; k < inc.length; k += 1) if (!rowMatches(f, inc[k])) return false;
      }
    }
    var quick = (fl.raw || '').trim();
    if (quick && !matchFilter(f.path, quick)) return false;
    return true;
  }
  function filterStateKey() {
    return [flatVersion, S.filter.raw, S.filter.mode, S.filter.onlySelected ? 1 : 0,
      S.filter.dirs.join('>'),
      S.filter.rows.map(function (r) { return [r.dim, r.op, r.value].join(':'); }).join('|'),
      S.onlyApplicable ? 1 : 0, S.onlyHits ? 1 : 0, S.showAll ? 1 : 0,
      S.targetFormat].join('|');
  }
  function filterSummary() {
    var total = S.flat.length;
    var vis = visibleFlat();
    var visPaths = Object.create(null);
    vis.forEach(function (v) { visPaths[v.path] = true; });
    // 与向导徽标 / 底栏 / 应用按钮同源，避免多处「已选 N」口径不一致。
    var selected = selectedUris().length;
    var outside = S.flat.filter(function (f) {
      return f.checked === true && !isLocked(f) && !visPaths[f.path];
    }).length;
    return { total: total, vis: vis.length, selected: selected, outside: outside };
  }

  function validateGlob(raw) {
    let curly = 0, square = 0;
    for (const ch of (raw || '')) {
      if (ch === '{') curly++; else if (ch === '}') curly--;
      else if (ch === '[') square++; else if (ch === ']') square--;
      if (curly < 0 || square < 0) return { ok: false, msg: '右括号多余' };
    }
    if (curly !== 0) return { ok: false, msg: '花括号不匹配' };
    if (square !== 0) return { ok: false, msg: '方括号不匹配' };
    return { ok: true, msg: '' };
  }
  function hitPathSet() {
    const raw = (S.filter.raw || '').trim();
    const key = flatVersion + '|' + raw;
    if (hitCache.key === key) return hitCache.value;
    const set = new Set();
    S.flat.forEach(function (f) {
      if (!raw) { set.add(f.path); return; }
      if (Array.isArray(f.hitRanges) && f.hitRanges.length) set.add(f.path);
      else if (matchFilter(f.path, raw)) set.add(f.path);
    });
    hitCache = { key: key, value: set };
    return set;
  }
  function visibleFlat() {
    const key = filterStateKey();
    if (visCache.key === key) return visCache.value;
    const out = S.flat.filter(passFilter)
      .sort(function (a, b) { return a.path.localeCompare(b.path); });
    visCache = { key: key, value: out };
    return out;
  }
  /* ── 结构化后缀白名单（0.1.7 反馈）─────────────────────────
   * YAML 只认 .yaml/.yml，JSON 只认 .json/.jsonc；其它后缀在树里
   * 灰显标注「不可选」，且不进入命中集 / 已选集 / 应用集合。
   * 文本 sed 模式不限制（由扩展名策略面板另行管理）。 */
  function structuredWhitelist() {
    // 「由目标格式固定」从只读面板搬到树上（0.1.7 反馈）：
    // 结构化模式下 YAML 只认 .yaml/.yml，JSON 只认 .json/.jsonc；
    // Sed / 文本模式不限制（可改任意类型）。
    // 用 targetFormat 而非 candidateExtensions：后者在启用指令后会让
    // findFiles 收窄到只剩白名单文件，规则反而永远看不到；而用户看到的
    // 「其它后缀都能勾」正是发生在第 ① 步还没写指令的时候。
    if (S.targetFormat === 'yaml') return ['yaml', 'yml'];
    if (S.targetFormat === 'json') return ['json', 'jsonc'];
    return null;
  }
  function whitelistText() {
    var wl = structuredWhitelist();
    return wl ? ('.' + wl.join(' / .')) : '';
  }
  function isLocked(f) {
    const wl = structuredWhitelist();
    if (!wl || !f) return false;
    const ext = String(f.ext || '').toLowerCase().replace(/^\./, '');
    return wl.indexOf(ext) < 0;
  }
  /** 当前筛选视图内可选文件的勾选情况（用于全选/取消全选切换） */
  function viewSelectState() {
    const vis = visibleFlat();
    // visibleFlat 已在结构化模式过滤掉非目标后缀，这里再兜底一次防御
    const selectable = vis.filter(function (f) { return !isLocked(f) || S.showAll; });
    const selected = selectable.filter(function (f) { return f.checked === true; }).length;
    return {
      total: selectable.length,
      selected: selected,
      allSelected: selectable.length > 0 && selected === selectable.length,
    };
  }

  function lockedByPath(path) {
    return isLocked(flatByPath[path]);
  }
  function lockBadgeHtml() {
    return '<span class="lock-badge" role="note" title="目标格式不支持此后缀，不可勾选">' +
      ic('lock') + ' 不可选</span>';
  }
  function hitUris() {
    return visibleFlat().filter(function (f) { return !isLocked(f); })
      .map(function (f) { return f.uri; }).filter(Boolean);
  }
  function selectedUris() {
    const key = flatVersion + '|' + S.targetFormat;
    if (selCache.key === key) return selCache.value;
    const out = S.flat.filter(function (f) { return f.checked === true && !isLocked(f); })
      .map(function (f) { return f.uri; }).filter(Boolean);
    selCache = { key: key, version: flatVersion, value: out };
    return out;
  }

  /* ── 小组件 HTML ───────────────────────────────────────── */
  function skeletonHtml(n) {
    let s = '<div class="state-skeleton" aria-hidden="true">';
    for (let i = 0; i < n; i++) s += '<div class="skel-line" style="width:' + (70 + ((i * 13) % 28)) + '%"></div>';
    return s + '</div>';
  }
  function emptyState(icon, text, actionLabel, action) {
    return '<div class="state-empty">' +
      '<span class="codicon codicon-' + icon + ' empty-icon" aria-hidden="true"></span>' +
      '<span class="empty-text">' + esc(text) + '</span>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="' + action + '">' + esc(actionLabel) + '</button>' +
      '</div>';
  }
  function panelHtml(ico, title, body) {
    return '<div class="panel"><div class="panel-head"><span>' + ic(ico) + ' ' + esc(title) + '</span></div>' +
      '<div class="panel-body">' + body + '</div></div>';
  }
  function errBox(msg) {
    return '<div class="state-error">' + ic('error') +
      '<div class="err-line">' + esc(msg) + '</div>' +
      '<div class="state-actions">' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="retry-scan">' + ic('refresh') + ' 重试扫描</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="help">' + ic('question') + ' 查看帮助</button>' +
      '</div></div>';
  }
  function highlight(text, ranges) {
    text = String(text || '');
    if (!Array.isArray(ranges) || !ranges.length) return esc(text);
    const segs = ranges.slice().sort(function (a, b) { return a[0] - b[0]; });
    let out = '', pos = 0;
    segs.forEach(function (r) {
      let s = Math.max(0, Math.min(r[0], text.length));
      let e = Math.max(s, Math.min(r[1], text.length));
      if (s > pos) out += esc(text.slice(pos, s));
      out += '<span class="hit">' + esc(text.slice(s, e)) + '</span>';
      pos = Math.max(pos, e);
    });
    if (pos < text.length) out += esc(text.slice(pos));
    return out;
  }
  function tagEditor(key, list, placeholder) {
    return '<div class="tag-input">' +
      list.map(function (t, i) {
        return '<span class="tag">' + esc(t) +
          '<button type="button" class="tag-x" data-action="tag-del" data-key="' + esc(key) + '" data-index="' + i + '" aria-label="移除 ' + esc(t) + '">' + ic('close') + '</button></span>';
      }).join('') +
      '<input class="tag-new" type="text" data-tagkey="' + esc(key) + '" placeholder="' + esc(placeholder) + '" aria-label="' + esc(placeholder) + '，按回车确认">' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="tag-add" data-key="' + esc(key) + '" aria-label="添加">' + ic('add') + ' 添加</button>' +
      '</div>';
  }
  function findTagInput(key) {
    const all = document.querySelectorAll('input[data-tagkey]');
    for (const i of all) if (i.getAttribute('data-tagkey') === key) return i;
    return null;
  }
  function tagList(key) {
    const p = String(key).split(':');
    if (p[0] === 'policy') return { arr: p[1] === 'exclude' ? S.customExclude : S.customInclude, commit: onPolicyChanged };
    if (p[0] === 'glob') return { arr: p[1] === 'exclude' ? S.selection.baseExclude : S.selection.baseInclude, commit: onGlobChanged };
    if (p[0] === 'ins') {
      const ins = S.instructions.find(function (i) { return i.id === p[1]; });
      if (ins) {
        if (ins.fileScope.mode !== 'custom') ins.fileScope = { mode: 'custom', include: [], exclude: [] };
        if (!Array.isArray(ins.fileScope.include)) ins.fileScope.include = [];
        if (!Array.isArray(ins.fileScope.exclude)) ins.fileScope.exclude = [];
        return {
          arr: p[2] === 'exclude' ? ins.fileScope.exclude : ins.fileScope.include,
          commit: function () { onInsScopeChanged(ins); },
        };
      }
    }
    return { arr: [], commit: function () {} };
  }

  /* ── 指令区渲染 ─────────────────────────────────────────── */
  function newInstruction() {
    const engine = curEngine();
    const base = { id: uid(), enabled: true, engine: engine };
    if (engine === 'structured') {
      const fmt = S.targetFormat === 'yaml' ? 'yaml' : 'json';
      return Object.assign(base, {
        format: fmt, fileScope: { mode: 'fixed', format: fmt },
        kind: 'set', path: '', value: '', valueType: undefined, scope: 'all',
      });
    }
    return Object.assign(base, {
      textOp: 'replace', pattern: '', replacement: '', flags: 'g', fileScope: policyScope(),
    });
  }
  function applyPolicyToActive() {
    let ins = S.instructions.find(function (i) { return i.id === S.activeInstructionId && i.engine === 'text'; });
    if (!ins) ins = S.instructions.find(function (i) { return i.engine === 'text'; });
    if (!ins) return;
    S.activeInstructionId = ins.id;
    ins.fileScope = policyScope();
    sendScope(ins);
  }
  function onPolicyChanged() {
    applyPolicyToActive();
    commitInstructions(true);
    renderScopePreserve();
    renderInstructions();
    persist();
  }
  function onGlobChanged() {
    S.globMode = 'edit'; S.customSelection = false;
    sendGlob();
    renderScopePreserve();
    persist();
  }
  function onInsScopeChanged(ins) {
    sendScope(ins);
    commitInstructions(true);
    renderInstructions();
    persist();
  }

  function insScopeEditHtml(ins) {
    const fs = ins.fileScope || { mode: 'all' };
    const mode = fs.mode === 'custom' ? 'custom' : 'all';
    const inc = Array.isArray(fs.include) ? fs.include : [];
    const exc = Array.isArray(fs.exclude) ? fs.exclude : [];
    return '<div class="ins-scope-edit">' +
      '<div class="policy-radios">' +
      '<label class="radio"><input type="radio" name="ins-scope-' + esc(ins.id) + '" data-action="ins-scope-mode" data-id="' + esc(ins.id) + '" data-mode="all" ' + (mode === 'all' ? 'checked' : '') + '> 全部类型（不过滤）</label>' +
      '<label class="radio"><input type="radio" name="ins-scope-' + esc(ins.id) + '" data-action="ins-scope-mode" data-id="' + esc(ins.id) + '" data-mode="custom" ' + (mode === 'custom' ? 'checked' : '') + '> 自定义</label>' +
      '</div>' +
      (mode === 'custom'
        ? '<div class="tag-line"><span class="tag-label">包含</span>' + tagEditor('ins:' + ins.id + ':include', inc, 'py / .env / Dockerfile / *.tf*，回车添加') + '</div>' +
          '<div class="tag-line"><span class="tag-label">排除</span>' + tagEditor('ins:' + ins.id + ':exclude', exc, '*.min.js / *.lock，回车添加') + '</div>'
        : '<div class="sec-note">当前作用于全部文件类型，二进制/非 UTF-8 会自动跳过。</div>') +
      '</div>';
  }

  function renderInsRow(ins) {
    const structured = ins.engine === 'structured';
    const off = !ins.enabled;
    const opField = structured ? 'kind' : 'textOp';
    const opVal = ins[opField] || (structured ? 'set' : 'replace');
    const ops = structured
      ? [['set', '设置值'], ['delete', '删除'], ['insert', '新增']]
      : [['replace', '替换'], ['deleteLine', '删除行']];
    const hasValue = !(opVal === 'delete' || opVal === 'deleteLine');
    const fs = ins.fileScope || { mode: 'all' };

    let scopeCtrl;
    if (structured) {
      const fmt = ins.format || (fs.mode === 'fixed' ? fs.format : 'json');
      scopeCtrl = '<div class="seg" role="group" aria-label="目标格式（决定该指令固定扩展名）">' +
        '<button type="button" class="seg-btn" data-action="ins-format" data-id="' + esc(ins.id) + '" data-format="json" aria-pressed="' + (fmt === 'json') + '" title="固定为 *.json, *.jsonc">JSON</button>' +
        '<button type="button" class="seg-btn" data-action="ins-format" data-id="' + esc(ins.id) + '" data-format="yaml" aria-pressed="' + (fmt === 'yaml') + '" title="固定为 *.yaml, *.yml">YAML</button>' +
        '</div>';
    } else {
      scopeCtrl = '<button type="button" class="ins-scope-btn" data-action="toggle-ins-scope" data-id="' + esc(ins.id) + '" aria-expanded="' + (S.scopeEditId === ins.id) + '" title="编辑该指令适用扩展名（fileScope）">' +
        ic('globe') + ' ' + esc(scopeText(fs)) + ' ' + ic(S.scopeEditId === ins.id ? 'chevron-down' : 'chevron-right') + '</button>';
    }

    const valInput = hasValue
      ? '<input class="ins-text ins-value" type="text" data-ins-field="' + (structured ? 'value' : 'replacement') + '" value="' + esc(ins[structured ? 'value' : 'replacement'] || '') + '" placeholder="' + (structured ? '新值' : '替换为（$1..$9）') + '" aria-label="' + (structured ? '新值' : '替换为') + '">'
      : '';
    const typeOrFlags = structured
      ? '<select class="ins-type" data-ins-field="valueType" aria-label="值类型"' + (opVal === 'delete' ? ' disabled' : '') + '>' +
        '<option value=""' + (!ins.valueType ? ' selected' : '') + '>沿用旧值</option>' +
        ['string', 'number', 'boolean', 'null', 'object', 'array'].map(function (t) {
          return '<option value="' + t + '"' + (ins.valueType === t ? ' selected' : '') + '>' + t + '</option>';
        }).join('') + '</select>'
      : '<input class="ins-flags" type="text" data-ins-field="flags" value="' + esc(ins.flags || '') + '" placeholder="g" aria-label="正则标志 g/i/m" title="仅接受 g / i / m 组合；无 g 时仅替换首个命中">';

    const meta1 = (structured ? ic('bracket-dot') + ' 结构化' : ic('regex') + ' 文本 sed');
    const meta2 = ic(fs.mode === 'fixed' ? 'lock' : 'globe') + ' ' + esc(scopeText(fs));
    const meta3 = structured ? '路径：$.a.b[0].c / $.items[*].name'
      : (opVal === 'deleteLine' ? '删除匹配整行（含换行符）' : 'JS 正则 · $1..$9 反向引用');

    return '<div class="ins-row' + (off ? ' is-off' : '') + '" data-id="' + esc(ins.id) + '" data-ins-row="1">' +
      '<div class="ins-main">' +
      '<label class="ins-enable" title="启用/禁用该指令（不删除）"><input type="checkbox" data-ins-field="enabled" ' + (ins.enabled ? 'checked' : '') + ' aria-label="启用该指令"></label>' +
      '<select class="ins-op" data-ins-field="' + opField + '" aria-label="操作类型">' +
      ops.map(function (o) { return '<option value="' + o[0] + '"' + (opVal === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
      '</select>' + scopeCtrl +
      '<input class="ins-text ins-path" type="text" data-ins-field="' + (structured ? 'path' : 'pattern') + '" value="' + esc(ins[structured ? 'path' : 'pattern'] || '') + '" placeholder="' + (structured ? '路径 $.a.b[0].c' : '模式（JS 正则源文本）') + '" aria-label="' + (structured ? '结构化路径' : '匹配模式') + '">' +
      valInput + typeOrFlags +
      '<button type="button" class="icon-btn ins-del" data-action="del-ins" data-id="' + esc(ins.id) + '" aria-label="删除该指令" title="删除指令">' + ic('trash') + '</button>' +
      '</div>' +
      '<div class="ins-meta"><span>' + meta1 + '</span><span>' + meta2 + '</span><span>' + meta3 + '</span></div>' +
      ((S.scopeEditId === ins.id && !structured) ? insScopeEditHtml(ins) : '') +
      '</div>';
  }

  function renderInsStatsHtml() {
    const eng = curEngine();
    const title = eng === 'structured' ? '旧值分布统计（防误伤）' : '命中样本预览（前 3 个片段及上下文）';
    const ico = eng === 'structured' ? 'graph' : 'search';
    const diffs = S.diffs.slice(0, 200); // 大工作区只统计前 200 个文件，避免渲染卡顿
    const removes = [];
    diffs.forEach(function (d) {
      (d.lines || []).forEach(function (l) { if (l.kind === 'remove') removes.push(l.text); });
    });
    if (eng === 'structured') {
      const freq = Object.create(null);
      removes.forEach(function (t) { const k = (t.trim().slice(0, 80) || '(空)'); freq[k] = (freq[k] || 0) + 1; });
      const entries = Object.keys(freq).map(function (k) { return [k, freq[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 6);
      const max = entries.length ? entries[0][1] : 1;
      const rows = entries.length
        ? entries.map(function (e) {
          return '<div class="dist-row"><span class="dist-val" title="' + esc(e[0]) + '">' + esc(e[0]) + '</span>' +
            '<span class="dist-bar"><i style="width:' + Math.round(e[1] / max * 100) + '%"></i></span>' +
            '<span class="dist-n">' + e[1] + '</span></div>';
        }).join('')
        : '<div class="dist-row"><span class="dist-val">预览 Diff 后显示旧值分布</span></div>';
      return panelHtml(ico, title, rows);
    }
    const samples = [];
    for (const d of S.diffs.slice(0, 200)) {
      const lines = d.lines || [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].kind === 'remove') {
          samples.push({
            path: d.path, ctx: (lines[i - 1] && lines[i - 1].kind === 'context') ? lines[i - 1].text : '',
            old: lines[i].text, nw: (lines[i + 1] && lines[i + 1].kind === 'add') ? lines[i + 1].text : '',
          });
          if (samples.length >= 3) break;
        }
      }
      if (samples.length >= 3) break;
    }
    const rows = samples.length
      ? samples.map(function (s) {
        return '<div class="sample-item"><span class="s-ctx">' + esc(s.path) + ' ' + esc(s.ctx) + '</span>' +
          '<span class="s-old">− ' + esc(s.old) + '</span><span class="s-new">+ ' + esc(s.nw) + '</span></div>';
      }).join('')
      : '<div class="sample-item"><span class="s-ctx">预览 Diff 后显示前 3 个命中片段及上下文一行</span></div>';
    return panelHtml(ico, title, rows);
  }
  function renderInsStats() { const n = el('ins-stats'); if (n) n.innerHTML = renderInsStatsHtml(); }

  function renderInstructions() {
    const eng = curEngine();
    el('tab-structured').setAttribute('aria-selected', String(eng === 'structured'));
    el('tab-text').setAttribute('aria-selected', String(eng === 'text'));
    const body = el('ins-body');
    if (!S.hasInit) { body.innerHTML = skeletonHtml(3); return; }
    const list = S.instructions.filter(function (i) { return i.engine === eng; });
    const total = S.instructions.length;
    const mixed = S.instructions.some(function (i) { return i.engine === 'structured'; }) &&
      S.instructions.some(function (i) { return i.engine === 'text'; });
    let html = '<div class="ins-toolbar">' +
      '<span class="ins-count">共 ' + total + ' 条指令' + (mixed ? '（双引擎混用）' : '') + '</span>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="add-ins">' + ic('add') + ' 添加' + (eng === 'structured' ? '结构化' : '文本') + '指令</button>' +
      '</div>';
    if (!list.length) {
      html += emptyState('edit', '暂无指令，点「添加」配置批量修改。', '添加第一条指令', 'add-ins');
    } else {
      html += '<div class="ins-list">' + list.map(renderInsRow).join('') + '</div>';
    }
    if (S.errors.length) html += errBox(S.errors[S.errors.length - 1].message);
    html += '<div class="ins-stats" id="ins-stats">' + renderInsStatsHtml() + '</div>';
    body.innerHTML = html;
    applyDisabled();
  }

  /* ── 文件范围区（§8.10）渲染 ────────────────────────────── */
  function policyTextHtml() {
    const mode = S.extPolicy;
    return '<div class="panel policy">' +
      '<div class="panel-head"><span>' + ic('globe') + ' 扩展名策略（文本 sed）</span></div>' +
      '<div class="panel-body">' +
      '<div class="policy-radios">' +
      '<label class="radio"><input type="radio" name="policy-mode" data-action="policy-mode" data-mode="all" ' + (mode === 'all' ? 'checked' : '') + '> 全部类型（不过滤）</label>' +
      '<label class="radio"><input type="radio" name="policy-mode" data-action="policy-mode" data-mode="custom" ' + (mode === 'custom' ? 'checked' : '') + '> 自定义</label>' +
      '</div>' +
      (mode === 'all'
        ? '<div class="sec-note">当前作用于全部文件类型，二进制/非 UTF-8 会自动跳过。切换「自定义」可指定扩展名/文件名与排除项。</div>'
        : '<div class="tag-line"><span class="tag-label">包含</span>' + tagEditor('policy:include', S.customInclude, 'py / .env / Dockerfile / *.tf*，回车添加') + '</div>' +
          '<div class="tag-line"><span class="tag-label">排除</span>' + tagEditor('policy:exclude', S.customExclude, '*.min.js / *.lock，回车添加') + '</div>') +
      '</div></div>';
  }
  function filterEchoHtml() {
    const raw = composeRaw();
    if (!raw) return '已解析：<span class="k">（无筛选条件，显示全部候选文件）</span>';
    const parts = raw.split(/\s+/).filter(Boolean).map(function (tok) {
      if (tok[0] === '!' || tok[0] === '-') return '¬ ' + esc(tok.slice(1) || tok);
      return esc(tok);
    });
    const v = validateGlob(raw);
    return (v.ok ? '已解析：' : 'glob 语法错误：') + '<span class="k">' + parts.join(' ∧ ') + '</span>' +
      (v.ok ? '' : ' — ' + esc(v.msg));
  }
  function renderFilterEcho() {
    const n = el('filter-echo'); if (!n) return;
    const ok = validateGlob(composeRaw()).ok;
    n.classList.toggle('is-invalid', !ok);
    n.innerHTML = filterEchoHtml();
    const fi = el('filter-input');
    if (fi) {
      fi.classList.toggle('is-invalid', !ok);
      if (!ok) fi.setAttribute('aria-invalid', 'true'); else fi.removeAttribute('aria-invalid');
    }
  }
  function crumbHtml() {
    var dirs = S.filter.dirs;
    var out = '<div class="filter-levels" role="group" aria-label="目录层级筛选">' +
      '<span class="fl-label">' + ic('list-tree') + ' 层级</span>' +
      '<button type="button" class="crumb' + (dirs.length ? '' : ' is-active') + '" data-action="filter-crumb" data-index="-1" title="显示全部目录层级">全部</button>';
    dirs.forEach(function (d, i) {
      var name = d.split('/').pop() || d;
      out += '<span class="crumb-sep" aria-hidden="true">/</span>' +
        '<button type="button" class="crumb' + (i === dirs.length - 1 ? ' is-active' : '') + '" data-action="filter-crumb" data-index="' + i + '" title="' + esc(d) + '">' + esc(name) + '</button>';
    });
    out += (dirs.length ? '<button type="button" class="btn btn-sec btn-sm" data-action="filter-crumb-clear" title="清除目录层级聚焦">' + ic('clear-all') + ' 清除层级</button>' : '') +
      '<span class="fl-tip">点树中目录的 ' + ic('target') + ' 可逐级聚焦</span></div>';
    return out;
  }
  function condRowHtml(row) {
    var dims = [['path', '路径 / 名称'], ['ext', '扩展名'], ['state', '状态']];
    var ops = [['include', '包含'], ['exclude', '排除']];
    var states = [['selected', '已勾选'], ['hits', '有命中'], ['applicable', '适用指令']];
    var count = S.flat.filter(function (f) { return rowMatches(f, row); }).length;
    var valueCtrl;
    if (row.dim === 'state') {
      valueCtrl = '<select class="cond-value" id="cv-' + esc(row.id) + '" data-filter-field="value" data-id="' + esc(row.id) + '" aria-label="状态条件值">' +
        states.map(function (o) { return '<option value="' + o[0] + '"' + (row.value === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>';
    } else {
      valueCtrl = '<input class="cond-value" id="cv-' + esc(row.id) + '" type="text" data-filter-field="value" data-id="' + esc(row.id) + '" value="' + esc(row.value) + '" placeholder="' +
        (row.dim === 'ext' ? 'yaml 或 yaml,yml' : '子串 / glob，如 conf 或 *.yaml') + '" aria-label="筛选条件值" autocomplete="off" spellcheck="false">';
    }
    return '<div class="filter-cond-row" data-id="' + esc(row.id) + '">' +
      '<select class="cond-dim" id="cd-' + esc(row.id) + '" data-filter-field="dim" data-id="' + esc(row.id) + '" aria-label="筛选维度">' +
      dims.map(function (o) { return '<option value="' + o[0] + '"' + (row.dim === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
      '<select class="cond-op" id="co-' + esc(row.id) + '" data-filter-field="op" data-id="' + esc(row.id) + '" aria-label="包含或排除">' +
      ops.map(function (o) { return '<option value="' + o[0] + '"' + (row.op === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
      valueCtrl +
      '<span class="cond-count" title="该条件单独命中的文件数">命中 <b>' + count + '</b></span>' +
      '<button type="button" class="icon-btn" data-action="filter-row-del" data-id="' + esc(row.id) + '" aria-label="删除此条件" title="删除此条件">' + ic('close') + '</button>' +
      '</div>';
  }
  function advancedFilterHtml() {
    var fl = S.filter;
    var n = fl.rows.filter(function (r) { return r.value.trim(); }).length;
    var open = fl.advanced || n > 0;
    return '<div class="filter-advanced">' +
      '<div class="fa-head">' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="filter-advanced" aria-expanded="' + open + '" title="展开/收起多级筛选条件">' +
      ic('filter') + ' 多级筛选' + (n ? ' <span class="fa-badge">' + n + '</span>' : '') + ' ' + ic(open ? 'chevron-down' : 'chevron-right') + '</button>' +
      '<div class="seg" role="group" aria-label="条件之间的逻辑关系">' +
      '<button type="button" class="seg-btn" data-action="filter-mode" data-mode="and" aria-pressed="' + (fl.mode === 'and') + '" title="所有包含条件同时满足">AND</button>' +
      '<button type="button" class="seg-btn" data-action="filter-mode" data-mode="or" aria-pressed="' + (fl.mode === 'or') + '" title="任一包含条件满足即可">OR</button>' +
      '</div>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="filter-add" title="新增一条筛选条件">' + ic('add') + ' 添加条件</button>' +
      '<label class="fa-check"><input type="checkbox" data-action="filter-only-selected" ' + (fl.onlySelected ? 'checked' : '') + '> 只看已选</label>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="clear-filter" title="清空全部筛选条件（勾选状态保留）">' + ic('clear-all') + ' 清除全部</button>' +
      '</div>' +
      (open ? '<div class="fa-body">' +
        (fl.rows.length ? fl.rows.map(condRowHtml).join('') : '<div class="fa-empty">暂无条件。点「添加条件」按路径、扩展名或状态逐级收敛范围。</div>') +
        '</div>' : '') +
      '</div>';
  }

  function chipsHtml() {
    const chips = ['*.yaml', '*.yml', '*.json', '*.env', '*.py', '*.md'];
    const tf = S.targetFormat;
    // 快捷片是「大概范围」：与当前目标格式固定扩展名同义的才算兼容（*.yaml ↔ *.yml）。
    const compatible = tf === 'json' ? ['*.json']
      : tf === 'yaml' ? ['*.yaml', '*.yml']
        : chips;
    return chips.map(function (c) {
      const disabled = compatible.indexOf(c) < 0;
      const why = disabled
        ? ('当前目标格式 ' + (tf === 'json' ? 'JSON 固定为 *.json / *.jsonc' : 'YAML 固定为 *.yaml / *.yml') + '，与 ' + c + ' 不兼容')
        : '';
      return '<button type="button" class="chip" data-action="chip" data-value="' + esc(c) + '"' +
        (disabled ? ' aria-disabled="true"' : '') + ' title="' + esc(why || ('点击填入筛选条件 ' + c)) + '">' + esc(c) + '</button>';
    }).join('');
  }
  function batchbarHtml() {
    return '<div class="batchbar" role="toolbar" aria-label="批量选择操作（仅作用于当前筛选视图）">' +
      '<span class="batch-group" role="group" aria-label="选择操作">' +
      '<span class="batch-label" aria-hidden="true">选择</span>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="batch" data-op="selectAll" title="勾选当前筛选视图内的全部文件（筛选外的已勾选项不受影响）">' + ic('check-all') + ' 全选命中</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="batch" data-op="deselectAll" title="仅取消当前筛选视图内文件的勾选">' + ic('circle-slash') + ' 取消命中</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="batch" data-op="invert" title="当前筛选视图内逐个取反">' + ic('sync') + ' 反选</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="batch" data-op="keepOnly" title="把选择集收敛为当前筛选视图（需二次确认）">' + ic('filter') + ' 仅保留</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="review-start" title="进入逐个审阅（依次选择）">' + ic('debug-step-over') + ' 依次选择</button>' +
      '</span>' +
      '<span class="batch-sep" aria-hidden="true"></span>' +
      '<span class="batch-group" role="group" aria-label="视图开关">' +
      '<span class="batch-label" aria-hidden="true">视图</span>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="batch" data-op="onlyApplicable" aria-pressed="' + S.onlyApplicable + '" title="只显示候选扩展名文件">' + ic('eye') + ' 只看适用</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="clear-filter" title="恢复全量视图，勾选状态原样保留">' + ic('clear-all') + ' 清除筛选</button>' +
      '</span>' +
      '</div>';
  }
  function treeToolbarHtml() {
    return '<button type="button" class="icon-btn" data-action="collapse-all" aria-label="折叠全部目录" title="折叠全部">' + ic('chevron-up') + '</button>' +
      '<button type="button" class="icon-btn" data-action="expand-all" aria-label="展开全部目录" title="展开全部">' + ic('chevron-down') + '</button>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="only-hits" aria-pressed="' + S.onlyHits + '" title="只看有命中的文件（审阅降噪）">' + ic('eye') + ' 只看命中</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="show-all" aria-pressed="' + S.showAll + '" title="临时显示其它后缀的文件（结构化模式下默认隐藏）">' + ic('list-flat') + ' 显示全部</button>';
  }
  function globPanelHtml() {
    const custom = S.globMode === 'summary' || S.customSelection;
    const open = !!S.globExpanded;   // 纯 UI 折叠态，默认折叠成紧凑摘要行
    const n = selectedUris().length;
    const globs = S.equivalentGlob.length ? S.equivalentGlob : ['（无）'];
    const lines = globs.map(function (g) {
      return '<div class="glob-line"><span class="g-tag">include</span><span>' + esc(g) + '</span></div>';
    }).join('');
    const summ = '<div class="glob-summary" aria-label="等效 glob 摘要（含扩展名表达式）">' + lines + '</div>';
    const toggleBtn = '<button type="button" class="icon-btn" data-action="glob-toggle" aria-expanded="' + open + '" aria-label="' + (open ? '折叠等效 glob 面板' : '展开查看或编辑 glob') + '" title="' + (open ? '折叠' : '展开查看/编辑') + '">' + ic(open ? 'chevron-up' : 'chevron-down') + '</button>';
    if (!open) {
      // 折叠态：一行紧凑摘要 + 保留 glob-reset / glob-show-edit 入口
      const joined = globs.join(' ');
      return '<div class="panel glob-panel">' +
        '<div class="panel-head"><span>' + ic('globe') + ' 等效 glob' +
        (custom ? ' <span class="badge badge-outline" title="当前为自定义勾选，glob 仅作只读摘要">自定义 ' + n + '</span>' : '') +
        '</span>' + toggleBtn + '</div>' +
        '<div class="panel-body">' +
        '<div class="glob-summary glob-compact" title="' + esc(joined) + '"><span class="g-tag">include</span><span class="g-text">' + esc(joined) + '</span></div>' +
        '<div class="glob-actions">' +
        '<button type="button" class="btn btn-sec btn-sm" data-action="glob-reset">' + ic('discard') + ' 重置' + (custom ? '为 glob' : '') + '</button>' +
        (custom ? '<button type="button" class="btn btn-sec btn-sm" data-action="glob-show-edit">查看等效 glob</button>' : '') +
        '</div></div></div>';
    }
    if (custom) {
      return '<div class="panel glob-panel">' +
        '<div class="panel-head"><span>' + ic('globe') + ' 等效 glob 摘要</span>' +
        '<span class="glob-head-actions">' +
        '<button type="button" class="icon-btn" data-action="glob-show-edit" aria-label="展开查看或编辑 glob" title="展开查看/编辑">' + ic('chevron-down') + '</button>' +
        toggleBtn + '</span></div>' +
        '<div class="panel-body">' +
        '<div class="glob-custom"><span>' + ic('edit') + ' 自定义选择（' + n + ' 个文件）</span><span class="badge badge-outline">只读摘要态</span></div>' +
        summ +
        '<div class="glob-actions">' +
        '<button type="button" class="btn btn-sec btn-sm" data-action="glob-reset">' + ic('discard') + ' 重置为 glob</button>' +
        '<button type="button" class="btn btn-sec btn-sm" data-action="glob-show-edit">查看等效 glob</button>' +
        '</div></div></div>';
    }
    return '<div class="panel glob-panel">' +
      '<div class="panel-head"><span>' + ic('globe') + ' 等效 glob（include / exclude）</span>' + toggleBtn + '</div>' +
      '<div class="panel-body">' +
      '<div class="glob-block"><span class="glob-block-title">include（目录 glob）</span>' + tagEditor('glob:include', S.selection.baseInclude, 'config/** ，回车添加') + '</div>' +
      '<div class="glob-block"><span class="glob-block-title">exclude（排除 glob）</span>' + tagEditor('glob:exclude', S.selection.baseExclude, '**/legacy/** ，回车添加') + '</div>' +
      '<div class="glob-block"><span class="glob-block-title">等效摘要（含扩展名表达式，只读）</span>' + summ + '</div>' +
      '<div class="glob-actions"><button type="button" class="btn btn-sec btn-sm" data-action="glob-reset">' + ic('discard') + ' 重置</button></div>' +
      '</div></div>';
  }

  function isExpanded(path, level) {
    if (Object.prototype.hasOwnProperty.call(S.expanded, path)) return S.expanded[path];
    if ((S.filter.raw || '').trim()) return true;     // 过滤态展开含命中的目录
    return true;                                      // 默认全部展开：否则两层以内的文件永远看不到（bug3）
  }
  const MAX_ROWS = 1500;
  function buildDirStats(vis) {
    dirStats = Object.create(null);
    for (const f of vis) {
      if (isLocked(f)) continue; // 不可选文件不参与目录三态，避免「全选」误判
      const parts = f.path.split('/');
      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? acc + '/' + parts[i] : parts[i];
        let st = dirStats[acc];
        if (!st) { st = dirStats[acc] = { tot: 0, sel: 0 }; }
        st.tot++;
        if (f.checked === true) st.sel++;
      }
    }
  }
  function countHitsUnder(dir) {
    const st = dirStats[dir];
    return st ? st.tot : 0;
  }
  function selText(dir) {
    const st = dirStats[dir];
    return st && st.tot ? (st.sel + '/' + st.tot + ' 已选(可见)') : '';
  }
  function dirCheckState(path) {
    const st = dirStats[path];
    if (!st || !st.tot || st.sel === 0) return false;
    if (st.sel === st.tot) return true;
    return 'mixed';
  }
  function truncatedHtml(shownCount, total) {
    return '<div class="tree-truncated">' + ic('info') +
      ' 仅显示前 ' + shownCount + ' 个文件（共 ' + total + ' 个）。请用筛选条件缩小范围，或在设置中调高 batchReplace.maxFiles。</div>';
  }
  function treeRowHtml(node, level, isDir, expanded, checked, visSet) {
    const pad = 6 + level * 14;
    const chevron = isDir
      ? '<button type="button" class="tree-chevron" data-action="toggle-dir" data-path="' + esc(node.path) + '" aria-label="' + (expanded ? '收起 ' : '展开 ') + esc(node.name) + '" aria-expanded="' + expanded + '">' + ic(expanded ? 'chevron-down' : 'chevron-right') + '</button>'
      : '<span class="tree-chevron" aria-hidden="true"></span>';
    const ico = ic(isDir ? 'folder' : 'file', 'tree-icon');
    const cnt = isDir ? countHitsUnder(node.path) : ((flatByPath[node.path] && flatByPath[node.path].changeCount) || node.changeCount || 0);
    const sel = isDir ? selText(node.path) : '';
    const nonCand = !node.applicable;
    const locked = !isDir && lockedByPath(node.path);
    // 0.2.2：结构化模式下树里显示的文件都是目标后缀（非目标已隐藏），一律按「可选」渲染。
    // applicable 仅作 tip 说明（当前启用指令可能不作用于它），不再灰显 —— 切换目标格式/Sed
    // 时宿主的 applicable 不变，若继续用它灰显会让可选文件看起来是置灰不可选。
    const tip = locked ? ('目标格式只支持 ' + (whitelistText() || '全部类型') + '，此后缀不可勾选')
      : (nonCand ? ('当前指令暂不作用于此文件' + (node.reason ? '：' + node.reason : '')) : '');
    return '<div class="tree-row ' + (isDir ? 'is-dir' : 'is-file') + (locked ? ' is-locked' : '') + '" ' +
      'role="treeitem" aria-level="' + (level + 1) + '" aria-selected="false" ' +
      (isDir ? 'aria-expanded="' + expanded + '" ' : '') +
      'tabindex="-1" data-path="' + esc(node.path) + '" data-kind="' + node.kind + '" ' +
      'style="padding-left:' + pad + 'px"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' +
      chevron + ico +
      '<span class="tri" role="checkbox" aria-checked="' + ariaChecked(locked ? false : checked) + '" ' +
      (locked ? 'aria-disabled="true" tabindex="-1" ' : 'tabindex="0" ') +
      'data-action="tri" data-path="' + esc(node.path) + '" data-kind="' + node.kind + '" aria-label="' + (locked ? '不可选择 ' : '选择 ') + esc(node.name) + '"></span>' +
      '<span class="tree-label">' + highlight(node.name, node.hitRanges) + '</span>' +
      (locked ? lockBadgeHtml() : '') +
      (cnt ? '<span class="row-badge"><span class="badge" aria-label="' + cnt + ' 处命中">●' + cnt + '</span></span>' : '') +
      (sel ? '<span class="row-badge"><span class="badge badge-outline">' + esc(sel) + '</span></span>' : '') +
      '<span class="row-actions">' +
      (isDir ? '<button type="button" class="icon-btn" data-action="focus-dir" data-path="' + esc(node.path) + '" aria-label="仅看此目录并逐级聚焦" title="逐级聚焦：仅看此目录">' + ic('target') + '</button>' : '') +
      (isDir ? '<button type="button" class="icon-btn" data-action="dir-menu" data-path="' + esc(node.path) + '" aria-label="目录批量操作" title="目录批量操作">' + ic('kebab-vertical') + '</button>' : '') +
      (!isDir ? '<button type="button" class="icon-btn" data-action="open-file" data-path="' + esc(node.path) + '" aria-label="在编辑器中查看 ' + esc(node.name) + '" title="在编辑器中查看">' + ic('go-to-file') + '</button>' : '') +
      '</span></div>';
  }
  function renderTreeNode(node, level, visSet, dirSet, rows) {
    if (rows.length >= MAX_ROWS) return;
    const isDir = node.kind === 'dir';
    if (isDir && !dirSet.has(node.path)) return;
    if (!isDir && !visSet.has(node.path)) return;
    const expanded = isDir ? isExpanded(node.path, level) : false;
    const checked = isDir ? dirCheckState(node.path)
      : (flatByPath[node.path] ? !!flatByPath[node.path].checked : !!node.checked);
    rows.push(treeRowHtml(node, level, isDir, expanded, checked, visSet));
    if (isDir && expanded && Array.isArray(node.children)) {
      for (const c of node.children) {
        if (rows.length >= MAX_ROWS) break;
        renderTreeNode(c, level + 1, visSet, dirSet, rows);
      }
    }
  }
  function flatRowHtml(f) {
    const nonCand = !f.applicable;
    const locked = isLocked(f);
    const tip = locked ? ('目标格式只支持 ' + (whitelistText() || '全部类型') + '，此后缀不可勾选')
      : (nonCand ? '当前指令暂不作用于此文件' : '');
    return '<div class="tree-row is-file' + (locked ? ' is-locked' : '') + '" role="treeitem" aria-level="1" aria-selected="false" tabindex="-1" ' +
      'data-path="' + esc(f.path) + '" data-kind="file"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' +
      '<span class="tree-chevron" aria-hidden="true"></span>' + ic('file', 'tree-icon') +
      '<span class="tri" role="checkbox" aria-checked="' + ariaChecked(locked ? false : !!f.checked) + '" ' +
      (locked ? 'aria-disabled="true" tabindex="-1" ' : 'tabindex="0" ') +
      'data-action="tri" data-path="' + esc(f.path) + '" data-kind="file" aria-label="' + (locked ? '不可选择 ' : '选择 ') + esc(f.path) + '"></span>' +
      '<span class="tree-label flat-path">' + highlight(f.path, f.hitRanges) + '</span>' +
      '<span class="row-badge"><span class="ext-badge">' + esc(f.ext || '') + '</span></span>' +
      (locked ? lockBadgeHtml() : '') +
      '<span class="row-badge"><span class="badge" aria-label="适用 ' + f.instructionCount + ' 条指令">' + f.instructionCount + ' 指令</span></span>' +
      (f.changeCount ? '<span class="row-badge"><span class="badge" aria-label="' + f.changeCount + ' 处变更">●' + f.changeCount + '</span></span>' : '') +
      '<span class="row-actions"><button type="button" class="icon-btn" data-action="open-file" data-path="' + esc(f.path) + '" aria-label="在编辑器中查看" title="在编辑器中查看">' + ic('go-to-file') + '</button></span>' +
      '</div>';
  }
  function renderTree() {
    rebuildMaps();
    const vis = visibleFlat();
    buildDirStats(vis);
    const visSet = new Set(vis.map(function (f) { return f.path; }));
    const dirSet = new Set();
    vis.forEach(function (f) {
      const p = f.path.split('/'); let acc = '';
      for (let i = 0; i < p.length - 1; i++) { acc = acc ? acc + '/' + p[i] : p[i]; dirSet.add(acc); }
    });
    const rows = [];
    S.tree.forEach(function (n) { if (rows.length < MAX_ROWS) renderTreeNode(n, 0, visSet, dirSet, rows); });
    if (rows.length >= MAX_ROWS && vis.length > rows.length) rows.push(truncatedHtml(rows.length, vis.length));
    return rows.length ? rows.join('') : emptyState('folder', '目录为空', '清除筛选条件', 'clear-filter');
  }
  function renderFlat() {
    rebuildMaps();
    const vis = visibleFlat();
    const shown = vis.slice(0, MAX_ROWS);
    const html = shown.map(flatRowHtml).join('');
    return html + (vis.length > shown.length ? truncatedHtml(shown.length, vis.length) : '');
  }
  function treeOrFlatHtml() {
    const vis = visibleFlat();
    if (!vis.length && S.flat.length === 0) {
      // 首屏懒加载：尚未扫描。引导直接指向上方唯一的过滤框（一件事的入口），
      // 不再重复一个「选择目录」按钮（主栏已有）。
      return '<div class="state-empty pk-empty">' +
        '<span class="codicon codicon-search empty-icon" aria-hidden="true"></span>' +
        '<span class="empty-text">在上方输入过滤条件即可自动载入文件（如 <b>*.yaml</b> 或 <b>config</b>）。载入后<b>默认全部不选中</b>，点「全选匹配」加入修改列表；换条件可多次追加。也可点左上角目录按钮更换扫描目录。</span>' +
        '</div>';
    }
    if (!vis.length) {
      return emptyState('search', '没有匹配文件。可清除筛选条件或扩大文件范围。', '清除筛选条件', 'clear-filter') +
        '<div style="padding:0 8px 8px 8px"><button type="button" class="btn btn-sec btn-sm" data-action="show-all">' + ic('eye') + ' 扩大文件范围（显示全部）</button></div>';
    }
    return S.view === 'flat' ? renderFlat() : renderTree();
  }
  function initRoving() {
    const tree = el('scope-tree'); if (!tree) return;
    const rows = Array.from(tree.querySelectorAll('[role="treeitem"]'));
    rows.forEach(function (r) { r.setAttribute('tabindex', '-1'); });
    if (rows.length) {
      let target = rows[0];
      if (S.focusPath) { const f = rows.find(function (r) { return r.getAttribute('data-path') === S.focusPath; }); if (f) target = f; }
      target.setAttribute('tabindex', '0');
    }
  }
  function setRoving(row) {
    const tree = el('scope-tree'); if (!tree) return;
    tree.querySelectorAll('[role="treeitem"]').forEach(function (r) { r.setAttribute('tabindex', '-1'); });
    row.setAttribute('tabindex', '0');
    S.focusPath = row.getAttribute('data-path');
  }
  function focusRow(path) {
    const tree = el('scope-tree'); if (!tree) return;
    const rows = Array.from(tree.querySelectorAll('[role="treeitem"]'));
    const r = rows.find(function (x) { return x.getAttribute('data-path') === path; });
    if (r) { setRoving(r); r.focus(); }
  }

  /* ── 第①步：单一「文件选择器」──────────────────────────────
   * 把「选目录 → 输入过滤条件 → 树里批量勾选 → 确认范围」合成一条连续动线。
   * 主区只保留：目录/格式主栏、一个过滤框、结果统计+全选、占满高度的树、确认条。
   * 其余次要控件收进默认折叠的「更多」面板（DOM 与 data-action 全部保留）。 */
  function renderScope() {
    const body = el('scope-body');
    if (!S.hasInit) { body.innerHTML = skeletonHtml(5); return; }
    const tf = S.targetFormat;
    const structured = tf !== 'sed';
    const sm = filterSummary();

    // 目标格式（决定可勾选后缀）：与「目录」同属"范围"，放主栏
    const fmtSeg = '<div class="seg pk-fmt" role="group" aria-label="目标格式，决定可勾选后缀">' +
      [['json', 'JSON'], ['yaml', 'YAML'], ['sed', 'Sed']].map(function (x) {
        return '<button type="button" class="seg-btn" data-action="target-format" data-format="' + x[0] + '" aria-pressed="' + (tf === x[0]) + '" title="' + (x[0] === 'sed' ? '文本模式：全部类型可选' : '仅 ' + (x[0] === 'json' ? '.json/.jsonc' : '.yaml/.yml') + ' 可勾选') + '">' + x[1] + '</button>';
      }).join('') + '</div>';
    const dirLabel = S.scopeRoot ? shortRoot(S.scopeRoot) : '工作区根目录';
    const pkBar = '<div class="pk-bar">' +
      '<button type="button" class="pk-dir" data-action="pick-directory" title="更换扫描目录（默认使用 VS Code 打开的工作区根目录，可选工作区外目录）">' +
      ic('root-folder') + '<span class="pk-dir-name">' + esc(dirLabel) + '</span>' + ic('chevron-down') + '</button>' +
      (S.scopeRoot
        ? '<span class="scope-root-badge" title="' + esc(S.scopeRoot) + '">' + ic('folder') + ' ' + esc(shortRoot(S.scopeRoot)) + '</span>' +
          '<button type="button" class="btn btn-sec btn-sm" data-action="reset-scope-root" title="' + esc(S.scopeRoot) + '">' + ic('discard') + ' 恢复</button>'
        : '') +
      '<span class="pk-sep" aria-hidden="true"></span>' +
      '<span class="pk-label">目标格式</span>' + fmtSeg +
      (S.candidateExtensions === 'all' ? '<span class="sec-note">全部文件类型</span>' : '') +
      '</div>';

    // 过滤框：这一步唯一的视觉焦点，输入即时过滤
    const pkSearch = '<div class="pk-search">' +
      '<span class="codicon codicon-search" aria-hidden="true"></span>' +
      '<input id="filter-input" class="filter-input pk-input" type="text" value="' + esc(S.filter.raw) + '" ' +
      'placeholder="输入路径 / 扩展名 / 关键词过滤文件，如 conf *.yaml !legacy" aria-label="过滤要修改的文件" aria-describedby="filter-echo" autocomplete="off" spellcheck="false">' +
      '<button type="button" class="icon-btn pk-clear" data-action="clear-filter" aria-label="清空筛选条件" title="清空筛选条件">' + ic('clear-all') + '</button>' +
      '<button type="button" class="btn btn-sec btn-sm pk-more-btn" data-action="toggle-more" aria-expanded="' + !!S.moreOpen + '" title="展开高级选项：视图、快捷片、多级条件、批量操作、等效 glob">' +
      ic('settings-gear') + ' 更多 ' + ic(S.moreOpen ? 'chevron-up' : 'chevron-down') + '</button>' +
      '</div>' +
      '<div class="filter-echo pk-echo" id="filter-echo">' + filterEchoHtml() + '</div>';

    // 结果条：统计 + 「全选匹配 / 取消全选」切换（每次筛选逻辑一致）+ 清空全部
    const vs = viewSelectState();
    const toggleOp = vs.allSelected ? 'deselectAll' : 'selectAll';
    const toggleLabel = vs.allSelected ? '取消全选' : '全选匹配';
    const toggleIco = vs.allSelected ? 'circle-slash' : 'check-all';
    const pkResult = '<div class="pk-result">' +
      '<span class="hit-count">匹配 <span class="num">' + sm.vis + '</span> / ' + sm.total +
      ' · 已选 <span class="num">' + sm.selected + '</span>' +
      (sm.outside ? ' <span class="outside-badge" title="这些文件已被勾选，但不在当前过滤视图内；换条件不会清空它们">' + sm.outside + ' 在视图外</span>' : '') + '</span>' +
      '<span class="row-spacer"></span>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="batch" data-op="' + toggleOp + '"' +
      (vs.total === 0 ? ' aria-disabled="true"' : '') +
      ' title="' + (vs.allSelected ? '取消当前筛选结果中全部文件的勾选' : '勾选当前筛选结果中的全部可选文件，可换条件多次追加') + '">' +
      ic(toggleIco) + ' ' + toggleLabel + ' ' + vs.total + '</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="batch" data-op="clearAll"' +
      (sm.selected === 0 ? ' aria-disabled="true"' : '') +
      ' title="清空全部已选文件，回到默认全不选">' + ic('clear-all') + ' 清空全部</button>' +
      '<label class="pk-chk"><input type="checkbox" data-action="filter-only-selected" ' + (S.filter.onlySelected ? 'checked' : '') + '> 只看已选</label>' +
      '</div>';

    // 树：这一步真正的主角，占满剩余高度
    const pkTree = '<div class="pk-tree"><div class="tree" id="scope-tree" role="tree" aria-label="要修改的文件">' + treeOrFlatHtml() + '</div></div>';

    // 确认条：把「范围已确认」显式化，直接通往第②步
    const wl = whitelistText();
    const pkConfirm = '<div class="pk-confirm">' +
      '<span class="pk-confirm-info">' + ic('check') + ' 只有勾选的文件会进入修改列表' +
      (wl ? ' · 仅 ' + esc(wl) + ' 可修改' : ' · 全部类型可选') + '</span>' +
      '</div>';

    // 更多：默认折叠，保留全部次要控件（视图/快捷片/层级/多级条件/批量/树工具/等效 glob/文本策略）
    const viewToggle = '<div class="seg view-toggle" role="group" aria-label="列表视图">' +
      '<button type="button" class="seg-btn" data-action="view" data-view="tree" aria-pressed="' + (S.view === 'tree') + '" title="树状视图">' + ic('list-tree') + ' 树状</button>' +
      '<button type="button" class="seg-btn" data-action="view" data-view="flat" aria-pressed="' + (S.view === 'flat') + '" title="跨目录扁平列表">' + ic('list-flat') + ' 扁平</button>' +
      '</div>';
    const pkMore = '<div class="pk-more" id="pk-more"' + (S.moreOpen ? '' : ' hidden') + '>' +
      '<div class="pk-more-row">' +
      '<span class="pk-more-label">显示</span>' + viewToggle +
      '<span class="pk-more-label">快捷</span><div class="filter-chips" role="group" aria-label="筛选快捷片">' + chipsHtml() + '</div>' +
      '</div>' +
      crumbHtml() +
      advancedFilterHtml() +
      batchbarHtml() +
      '<div class="tree-toolbar">' + treeToolbarHtml() + '</div>' +
      (structured ? '' : policyTextHtml()) +
      '<div class="pk-glob">' + globPanelHtml() + '</div>' +
      '</div>';

    const errHtml = S.errors.length ? errBox(S.errors[S.errors.length - 1].message) : '';
    body.innerHTML = '<div class="picker">' + errHtml + pkBar + pkSearch + pkMore + pkResult + pkTree + pkConfirm + '</div>';

    const v = validateGlob(composeRaw());
    const fi = el('filter-input');
    if (fi && !v.ok) { fi.classList.add('is-invalid'); fi.setAttribute('aria-invalid', 'true'); fi.setAttribute('title', 'glob 语法错误：' + v.msg); }
    const fe = el('filter-echo');
    if (fe) fe.classList.toggle('is-invalid', !v.ok);
    initRoving();
    applyDisabled();
  }
  function preserveFocus(fn) {
    const ae = document.activeElement;
    const id = ae && ae.id;
    const path = ae && ae.getAttribute ? ae.getAttribute('data-path') : null;
    let ss = null, se = null;
    try { if (ae && typeof ae.selectionStart === 'number') { ss = ae.selectionStart; se = ae.selectionEnd; } } catch (e) {}
    fn();
    let next = id ? document.getElementById(id) : null;
    if (!next && path) {
      const rows = document.querySelectorAll('[data-path]');
      for (const r of rows) { if (r.getAttribute('data-path') === path) { next = r; break; } }
    }
    if (next) {
      try { next.focus({ preventScroll: true }); } catch (e) { try { next.focus(); } catch (e2) {} }
      try { if (ss !== null && typeof next.setSelectionRange === 'function') next.setSelectionRange(ss, se); } catch (e) {}
    }
  }
  function renderScopePreserve() { preserveFocus(renderScope); }

  /* ── 结果区渲染 ─────────────────────────────────────────── */
  function opBadges() {
    const set = new Set();
    S.instructions.filter(function (i) { return i.enabled; }).forEach(function (i) {
      if (i.engine === 'structured') { if (i.kind) set.add(i.kind); } else set.add('sed');
    });
    const map = { set: 'op-set', delete: 'op-del', insert: 'op-ins', sed: 'op-sed' };
    const lab = { set: 'set', delete: 'del', insert: 'ins', sed: 'sed' };
    return Array.from(set).map(function (k) { return '<span class="badge badge-op ' + (map[k] || '') + '">' + (lab[k] || esc(k)) + '</span>'; }).join('');
  }
  function countGroup(id, label, n, ico, cls) {
    return '<div class="group" id="' + id + '"><summary class="' + (n > 0 ? cls : '') + '">' + ic(ico) + ' ' + label +
      ' <span class="g-count">' + n + '</span></summary><div class="group-body">' +
      (n > 0 ? '<div class="issue-line">' + ic(ico) + ' 共 ' + n + ' 项' + label + '，请逐条核对后应用。</div>' : '<div class="issue-line">无</div>') +
      '</div></div>';
  }
  function renderDiffLines(lines) {
    if (S.diffTextMode) {
      return '<pre class="diff-textmode">' + lines.map(function (l) {
        const t = esc(l.text);
        if (l.kind === 'remove') return '<span class="tm-del">− ' + t + '</span>';
        if (l.kind === 'add') return '<span class="tm-add">+ ' + t + '</span>';
        return '  ' + t;
      }).join('\n') + '</pre>';
    }
    return lines.map(function (l) {
      const oldNo = l.oldNo == null ? '' : l.oldNo;
      const newNo = l.newNo == null ? '' : l.newNo;
      const sign = l.kind === 'remove' ? '−' : (l.kind === 'add' ? '+' : ' ');
      const aria = l.kind === 'remove' ? ('删除第 ' + oldNo + ' 行：' + l.text)
        : (l.kind === 'add' ? ('新增第 ' + newNo + ' 行：' + l.text) : ('上下文第 ' + oldNo + ' 行：' + l.text));
      return '<div class="diff-line ' + (l.kind === 'remove' ? 'del' : (l.kind === 'add' ? 'add' : 'ctx')) + '" role="listitem" aria-label="' + esc(aria) + '">' +
        '<span class="gutter" aria-hidden="true"><span>' + esc(oldNo) + '</span><span>' + esc(newNo) + '</span></span>' +
        '<span class="sign" aria-hidden="true">' + sign + '</span>' +
        '<span class="text">' + esc(l.text) + '</span></div>';
    }).join('');
  }
  function diffPaneHtml() {
    if (!S.diffs.length) {
      return '<div class="diff-pane"><div class="diff-head"><span class="diff-title">Diff 预览</span></div>' +
        emptyState('diff-multiple', '尚无 Diff。点击「预览全部 Diff」查看逐条变更。', '预览全部 Diff', 'preview-all') + '</div>';
    }
    const cur = S.diffs.find(function (d) { return d.uri === S.activeDiff; }) || S.diffs[0];
    S.activeDiff = cur.uri;
    const opts = S.diffs.map(function (d) {
      return '<option value="' + esc(d.uri) + '"' + (d.uri === cur.uri ? ' selected' : '') + '>' + esc(d.path) + '</option>';
    }).join('');
    const warn = S.counts.warnings > 0
      ? '<div class="diff-warn">' + ic('warning') + ' 存在 ' + S.counts.warnings + ' 处警示，请逐条核对后再应用</div>' : '';
    return '<div class="diff-pane"><div class="diff-head">' +
      '<span class="diff-title">' + esc(cur.path) + '</span>' +
      '<select class="diff-file-select" id="diff-file-select" aria-label="选择查看的文件 Diff">' + opts + '</select>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="diff-mode" aria-pressed="' + S.diffTextMode + '" title="切换读屏可读的 −old / +new 文本模式">' + ic('notebook') + ' ' + (S.diffTextMode ? '表格模式' : '文本模式') + '</button>' +
      '<button type="button" class="icon-btn" data-action="open-file" data-uri="' + esc(cur.uri) + '" aria-label="在编辑器中查看 ' + esc(cur.path) + '" title="在编辑器中查看">' + ic('go-to-file') + '</button>' +
      '</div>' + warn +
      '<div class="diff-scroll" role="list" aria-label="' + esc(cur.path) + ' 的逐行 diff">' + renderDiffLines(cur.lines || []) + '</div></div>';
  }
  function reportPanelHtml(r) {
    const c = function (x) { return esc(x); };
    const skip = (r.skipped || []).map(function (s) { return '<div class="rl-item">' + ic('warning') + '<span>' + c(s.uri) + ' — ' + c(s.reason) + '</span></div>'; }).join('');
    const conf = (r.conflicts || []).map(function (s) { return '<div class="rl-item">' + ic('issues') + '<span>' + c(s.uri) + ' — ' + c((s.instructionIds || []).join(', ')) + '</span></div>'; }).join('');
    const det = (r.details || []).slice(0, 40).map(function (d) { return '<div class="rl-item">' + ic('file') + '<span>' + c(d.path) + ' · ' + c(d.changeCount) + ' 处</span></div>'; }).join('');
    return '<div class="report-panel"><div class="report-head">' + ic('pass') + ' <strong>执行报告</strong><span class="sec-note">' + c(r.appliedAt || '') + '</span></div>' +
      '<div class="report-grid">' +
      '<div class="report-cell"><div class="rc-n">' + c(r.changedFiles) + '</div><div class="rc-l">变更文件</div></div>' +
      '<div class="report-cell"><div class="rc-n">' + c(r.changes) + '</div><div class="rc-l">变更处数</div></div>' +
      '<div class="report-cell"><div class="rc-n">' + (r.skipped || []).length + '</div><div class="rc-l">跳过</div></div>' +
      '</div>' +
      (skip || conf || det ? '<div class="report-list">' + skip + conf + det + '</div>' : '') +
      '<div class="report-actions">' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="export-report">' + ic('cloud-upload') + ' 导出报告</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="history">' + ic('history') + ' 查看报告</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="report-close">' + ic('close') + ' 返回结果</button>' +
      '</div></div>';
  }
  /** 0.2.1：第③步「命中树」改为只读树状目录 —— 不可选择，只可展开/折叠，视觉与第①步统一。 */
  function resultTreeHtml() {
    rebuildMaps();
    const changedAll = S.flat.filter(function (f) { return f.changeCount > 0; });
    const changed = changedAll.slice(0, 500); // 分页保护；计数仍显示真实总数
    if (!changed.length) return '';

    // 由变更文件的相对路径构建目录树（仅包含有变更的分支，空目录天然不出现）
    const root = { dirs: new Map(), files: [] };
    changed.forEach(function (f) {
      const parts = f.path.split('/');
      let cur = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const seg = parts[i];
        let d = cur.dirs.get(seg);
        if (!d) {
          d = { dirs: new Map(), files: [], path: parts.slice(0, i + 1).join('/') };
          cur.dirs.set(seg, d);
        }
        cur = d;
      }
      cur.files.push({ name: parts[parts.length - 1], f: f });
    });

    const ops = opBadges();
    const MAX = 1500;
    const rows = [];
    function walk(node, level) {
      if (rows.length >= MAX) return;
      const pad = 6 + level * 14;
      // 目录：按名称排序
      const dirs = [...node.dirs.entries()].sort(function (a, b) { return a[0].localeCompare(b[0]); });
      dirs.forEach(function (pair) {
        if (rows.length >= MAX) return;
        const name = pair[0], d = pair[1];
        const isOpen = S.resultExpanded[d.path] !== false; // 默认展开
        const cnt = countChangedUnder(changed, d.path);
        rows.push('<div class="tree-row is-dir is-readonly" role="treeitem" aria-level="' + (level + 1) + '" ' +
          'aria-expanded="' + isOpen + '" data-rpath="' + esc(d.path) + '" style="padding-left:' + pad + 'px">' +
          '<button type="button" class="tree-chevron" data-action="result-toggle-dir" data-rpath="' + esc(d.path) + '" ' +
          'aria-label="' + (isOpen ? '收起 ' : '展开 ') + esc(name) + '" aria-expanded="' + isOpen + '">' +
          ic(isOpen ? 'chevron-down' : 'chevron-right') + '</button>' +
          ic('folder', 'tree-icon') +
          '<span class="tree-label">' + esc(name) + '</span>' +
          '<span class="row-badge"><span class="badge badge-outline" aria-label="' + cnt + ' 个变更文件">' + cnt + ' 个文件</span></span>' +
          '</div>');
        if (isOpen) walk(d, level + 1);
      });
      // 文件：只读，无勾选框
      node.files.sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (it) {
        if (rows.length >= MAX) return;
        const fUri = (flatByPath[it.f.path] && flatByPath[it.f.path].uri) || it.f.uri || '';
        rows.push('<div class="tree-row is-file is-readonly" role="treeitem" aria-level="' + (level + 1) + '" ' +
          'data-rpath="' + esc(it.f.path) + '" data-diff-uri="' + esc(fUri) + '" ' +
          'title="双击查看该文件的变更 Diff" style="padding-left:' + (pad + 14) + 'px">' +
          '<span class="tree-chevron" aria-hidden="true"></span>' + ic('file', 'tree-icon') +
          '<span class="tree-label" title="' + esc(it.f.path) + '">' + esc(it.name) + '</span>' +
          '<span class="row-badge"><span class="badge" aria-label="' + it.f.changeCount + ' 处变更">●' + it.f.changeCount + '</span></span>' +
          ops +
          '<span class="row-actions"><button type="button" class="icon-btn" data-action="open-file" data-path="' + esc(it.f.path) + '" ' +
          'aria-label="在编辑器中查看 ' + esc(it.f.path) + '" title="在编辑器中查看">' + ic('go-to-file') + '</button></span>' +
          '</div>');
      });
    }
    walk(root, 0);
    const truncated = changedAll.length > changed.length
      ? '<div class="tree-truncated">' + ic('info') + ' 仅列出前 ' + changed.length + ' 个变更文件（共 ' + changedAll.length + ' 个）。</div>'
      : '';
    return '<div class="result-tree-wrap"><div class="tree result-tree" id="group-changes" role="tree" aria-label="变更文件树（只读）">' +
      rows.join('') + truncated + '</div></div>';
  }
  function countChangedUnder(files, dir) {
    return files.filter(function (f) { return f.path.indexOf(dir + '/') === 0; }).length;
  }
  function groupsHtml() {
    rebuildMaps();
    const changedAll = S.flat.filter(function (f) { return f.changeCount > 0; });
    const ops = opBadges();
    const reasons = S.tree.filter(function (n) { return n.reason; });
    let html = '<div class="result-head"><span>' + ic('list-tree') + ' 变更文件 <span class="g-count">' + changedAll.length + '</span></span>' +
      '<span class="sec-note">只读目录树 · 点击目录展开 / 收起</span></div>';
    html += resultTreeHtml() || '<div class="issue-line">扫描后显示变更文件目录树</div>';
    html += countGroup('group-warnings', '警示', S.counts.warnings, 'warning', 'is-warn');
    html += countGroup('group-parseErrors', '解析失败', S.counts.parseErrors, 'error', 'is-bad');
    html += countGroup('group-conflicts', '冲突', S.counts.conflicts, 'issues', 'is-bad');
    if (reasons.length) {
      html += '<div class="group"><summary>' + ic('info') + ' 跳过说明 <span class="g-count">' + reasons.length + '</span></summary>' +
        '<div class="group-body">' + reasons.slice(0, 40).map(function (n) {
          return '<div class="group-item">' + ic(n.kind === 'dir' ? 'folder' : 'file') +
            '<span class="gi-path">' + esc(n.path) + '</span><span class="gi-reason" title="' + esc(n.reason) + '">' + esc(n.reason) + '</span></div>';
        }).join('') + '</div></div>';
    }
    if (!changedAll.length && !S.counts.warnings && !S.counts.parseErrors && !S.counts.conflicts && !S.report) {
      html = emptyState('search', '尚无结果。配置指令与文件范围后执行扫描，再预览 Diff。', '立即扫描', 'scan');
    }
    return html;
  }
  function renderResults() {
    const body = el('results-body');
    if (!S.hasInit) { body.innerHTML = skeletonHtml(4); return; }
    const errHtml = S.errors.length ? errBox(S.errors[S.errors.length - 1].message) : '';
    const reportHtml = (S.report && S.phase === 'report') ? reportPanelHtml(S.report) : '';
    body.innerHTML = errHtml + reportHtml +
      '<div class="results-grid"><div class="results-left">' +
      '<div class="results-tabs"><span class="field-label">变更文件目录树（只读）</span></div>' + groupsHtml() +
      '</div><div class="results-right">' + diffPaneHtml() + '</div></div>';
    applyDisabled();
  }

  /* ── 概览 / 错误条 / 审阅 / 底栏 ───────────────────────── */
  function renderOverview() {
    const c = S.counts;
    const stats = [
      { k: 'changes', label: '变更', v: c.changes, ico: 'edit' },
      { k: 'files', label: '文件', v: c.files, ico: 'file' },
      { k: 'warnings', label: '警示', v: c.warnings, ico: 'warning', bad: 'warn' },
      { k: 'parseErrors', label: '解析失败', v: c.parseErrors, ico: 'error', bad: 'bad' },
      { k: 'conflicts', label: '冲突', v: c.conflicts, ico: 'issues', bad: 'bad' },
    ];
    el('ov-stats').innerHTML = stats.map(function (s) {
      return '<button type="button" class="ov-stat ' + (s.v > 0 && s.bad ? ('is-' + s.bad) : '') + '" data-action="jump" data-group="' + s.k + '" ' +
        'aria-label="' + s.label + ' ' + s.v + '，点击跳转到结果分组" title="跳转到「' + s.label + '」分组">' +
        ic(s.ico) + '<span class="ov-label">' + s.label + '</span><span class="ov-num">' + s.v + '</span></button>';
    }).join('');
    // 0.1.7 反馈：删掉「就绪 N/M」数量对比与进度条（逐文件广播是性能大头）。
    // 只保留手动刷新 / 取消两个图标入口。
    const scanning = S.phase === 'scanning';
    el('ov-scan').innerHTML =
      '<button type="button" class="icon-btn" data-action="scan" aria-label="重新载入文件列表" title="重新载入文件列表">' + ic('refresh') + '</button>' +
      '<button type="button" class="icon-btn" data-action="cancel-scan" aria-label="取消扫描" ' + (scanning ? '' : 'aria-disabled="true" ') + 'title="' + (scanning ? '取消当前扫描' : '仅扫描进行中可取消') + '">' + ic('close') + '</button>';
  }
  function renderErrorStrip() {
    const box = el('error-strip');
    if (!S.errors.length) { box.hidden = true; box.innerHTML = ''; return; }
    const e = S.errors[S.errors.length - 1];
    box.hidden = false;
    box.innerHTML = ic('error') +
      '<div class="err-text"><strong>' + esc(e.message) + '</strong>' +
      (e.detail ? '<div class="err-detail">' + esc(e.detail) + '</div>' : '') + '</div>' +
      '<div class="err-actions">' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="retry-scan">' + ic('refresh') + ' 重试扫描</button>' +
      '<button type="button" class="icon-btn" data-action="dismiss-error" aria-label="关闭错误提示" title="关闭">' + ic('close') + '</button></div>';
  }
  function reviewActionsHtml() {
    return '<div class="review-actions">' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="review" data-ra="prev">' + ic('arrow-left') + ' 上一个</button>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="review" data-ra="selectNext">选中并下一个 ' + ic('arrow-right') + '</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="review" data-ra="skip">跳过</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="review" data-ra="selectRest">全选剩余</button>' +
      '<button type="button" class="btn btn-sec btn-sm" data-action="review" data-ra="end">结束审阅</button></div>';
  }
  function renderReview() {
    const card = el('review-card');
    if (!S.review.active) { card.hidden = true; card.innerHTML = ''; return; }
    card.hidden = false;
    const r = S.review, it = r.item;
    const pct = r.total ? Math.round((r.index + 1) / r.total * 100) : 0;
    let head = '<div class="review-head"><span class="review-progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + r.total + '" aria-valuenow="' + (r.index + 1) + '" aria-label="逐个审阅进度">' +
      (r.index + 1) + ' / ' + r.total + ' <span class="progressbar"><i style="width:' + pct + '%"></i></span></span>' +
      (r.message ? '<span class="review-msg">' + esc(r.message) + '</span>' : '') + '</div>';
    if (!it) { card.innerHTML = head + '<div class="review-msg">' + esc(r.message || '队列已结束') + '</div>' + reviewActionsHtml(); return; }
    card.innerHTML = head +
      '<div class="review-path">' + ic('file') + ' ' + esc(it.path) + '</div>' +
      '<div class="review-badges"><span class="ext-badge">' + esc(it.ext || '') + '</span>' +
      '<span class="badge">适用 ' + it.instructionCount + ' 条指令</span>' +
      '<span class="badge">预计 ' + it.changeCount + ' 处变更</span></div>' +
      (it.diff ? '<div class="review-diff">' + renderDiffLines(it.diff.lines || []) + '</div>' : '') +
      reviewActionsHtml();
  }
  /* ── 0.1.2 三步向导 ─────────────────────────────────────── */
  function renderWizard() {
    const w = el('wizard'); if (!w) return;
    // 每步实时状态徽标：① 已选 N ② 指令 N ③ 变更 N（不抢主色，tabular-nums）
    const badgeLabels = ['已选', '指令', '变更'];
    const badgeVals = [selectedUris().length, S.instructions.length, S.counts.changes || 0];
    const steps = STEPS.map(function (st, i) {
      return (i ? '<span class="wiz-sep" aria-hidden="true"></span>' : '') +
        '<button type="button" class="wiz-step' + (st.id < S.step ? ' is-done' : '') + '" data-action="wizard-step" data-step="' + st.id + '"' +
        (S.step === st.id ? ' aria-current="step"' : '') + ' title="跳到第 ' + st.id + ' 步：' + esc(st.label) + '">' +
        '<span class="wiz-n">' + (st.id < S.step ? ic('check') : st.id) + '</span>' + esc(st.label) +
        '<span class="wiz-badge"><span class="wb-label">' + badgeLabels[i] + '</span><span class="wb-n">' + badgeVals[i] + '</span></span>' +
        '</button>';
    }).join('');
    // 0.1.7 反馈：删除「扫描文件」按钮，改为设定目录/筛选条件后自动载入。
    // 0.1.9：前一步/后一步引导统一由底栏提供，向导条不再重复按钮（步骤本身可点跳转）。
    w.innerHTML = steps;
    const h = el('wiz-hint');
    if (h) {
      const hints = [
        '默认全部不选中，点「全选匹配」加入修改列表；换筛选条件不会清空已选，可多次追加（仅 ' + (whitelistText() || '全部类型') + ' 显示并可修改，其它后缀已隐藏）。',
        '添加指令：设置 / 删除 / 新增值，或切到文本 sed 做正则替换。',
        '核对 Diff 后点「应用」一次提交并保存，误改可一键回退。',
      ];
      h.innerHTML = ic('info') + '<span>' + esc(hints[S.step - 1] || hints[0]) + '</span>';
    }
    renderStepFooters();
  }
  /** 每步区块底部的「步骤落点」：左侧状态摘要 + 右侧下一步主 CTA（第③步落点是底栏，不加）。 */
  function renderStepFooters() {
    const sf = el('scope-footer');
    if (sf) sf.innerHTML = ''; // 第①步落点已合并进「文件选择器」底部的确认条（实时刷新）
    const inf = el('ins-footer');
    if (inf) inf.innerHTML = ''; // 下一步引导统一由底栏提供
  }
  /** 换步统一入口：先 flush 未落定编辑，再换步；进入第③步时按需自动预览一次。 */
  function gotoStep(st) {
    flushPending(); // 换步前先把未落定的编辑发给宿主，避免下一步拿到过期结果
    S.step = (st >= 1 && st <= 3) ? st : 1;
    renderWizard(); applyStep(); renderBottomBar(); renderResults(); applyDisabled();
    announce('已进入第 ' + S.step + ' 步：' + STEPS[S.step - 1].label);
    // 第③步提速：有变更但还没 Diff 时自动预览一次（仅换步触发，不循环；手动按钮保留）。
    // flushPending 已在上方执行，宿主 previewAll 前还会 flushRecompute，消息顺序安全。
    // 0.2.5：每次进入第③步都拉取最新 Diff（条件变化/第二轮后 S.diffs 可能过期）。
    if (S.step === 3 && S.phase !== 'applying' && S.phase !== 'scanning') {
      post({ type: 'previewAll' });
    }
  }
  function applyStep() {
    const shown = { 1: 'sec-scope', 2: 'sec-instructions', 3: 'sec-results' }[S.step] || 'sec-scope';
    ['sec-instructions', 'sec-scope', 'sec-results'].forEach(function (id) {
      const n = el(id); if (n) n.classList.toggle('wizard-hidden', shown !== id);
    });
  }

  /* ── 0.1.2 双击文件预览 ─────────────────────────────────── */
  function hidePreview() { const m = el('preview-modal'); if (m) m.hidden = true; }
  function onFileContent(p) {
    S.previewUri = p.uri || '';
    const title = el('preview-title');
    if (title) {
      title.innerHTML = ic('file') + '<span class="pv-path">' + esc(p.path || p.uri || '') + '</span>' +
        (p.ext ? '<span class="badge ext-badge">' + esc(p.ext) + '</span>' : '');
    }
    const tb = el('pv-toolbar');
    if (tb) tb.innerHTML = ic('info') + '<span>源文件只读预览 · 用于定位要修改的值，不会改动文件</span>';
    const body = el('preview-body');
    const note = el('pv-note-inline');
    if (note) note.innerHTML = '';
    if (body) {
      if (p.error) {
        body.innerHTML = '<div class="pv-error">' + ic('warning') + ' ' + esc(p.error) + '</div>';
      } else {
        const lines = String(p.text || '').split('\n');
        const shown = lines.slice(0, 1500);
        let html = '<div class="pv-code">';
        shown.forEach(function (ln, i) {
          html += '<div class="pv-line"><span class="pv-no">' + (i + 1) +
            '</span><span class="pv-text">' + esc(ln || ' ') + '</span></div>';
        });
        html += '</div>';
        body.innerHTML = html;
        if (note && (p.truncated || lines.length > shown.length)) {
          note.innerHTML = ic('warning') + ' 内容已截断，仅显示前 ' + shown.length + ' 行';
        }
      }
    }
    const m = el('preview-modal');
    if (m) { m.hidden = false; const b = m.querySelector('[data-action="preview-close"]'); if (b) b.focus(); }
  }

  function bottomBarNavHtml() {
    const step = S.step;
    const labels = ['', '写修改命令', '预览并应用'];
    const hints = [
      '',
      '第 ① 步：确认要修改的文件范围',
      '第 ② 步：写好要写入 / 删除的命令',
    ];
    const prev = step > 1
      ? '<button type="button" class="btn btn-sec" data-action="wizard-step" data-step="' + (step - 1) + '">' + ic('arrow-left') + ' 上一步</button>'
      : '';
    const next = '<button type="button" class="btn btn-primary" data-action="wizard-step" data-step="' + (step + 1) + '">' +
      '下一步：' + esc(labels[step]) + ' ' + ic('arrow-right') + '</button>';
    return '<div class="bb-nav">' +
      '<span class="bb-nav-hint">' + ic('info') + ' ' + esc(hints[step]) + '</span>' +
      '<span class="row-spacer"></span>' + prev + next + '</div>';
  }
  function bottomBarActionsHtml() {
    const n = S.counts.changes || 0, f = S.counts.files || 0;
    const sel = selectedUris().length;
    const disabled = sel === 0 || S.phase === 'applying';
    return '<div class="bb-stats">变更 <span class="bb-n">' + n + '</span> · 文件 <span class="bb-n">' + f + '</span> · 已选 <span class="bb-n">' + sel + '</span></div>' +
      '<div class="bb-actions">' +
      '<button type="button" class="btn btn-sec" data-action="preview-all">' + ic('preview') + ' 预览全部 Diff</button>' +
      '<button type="button" class="btn btn-primary" data-action="apply"' + (disabled ? ' aria-disabled="true"' : '') +
      ' title="' + (disabled ? '请先选择文件范围或等待应用完成' : '点击即保存所选变更（无需确认），误改可一键回退') + '">' +
      ic('check') + ' 应用 ' + n + ' 处变更 ' + ic('arrow-right') + '</button>' +
      '<button type="button" class="btn btn-sec" data-action="undo-last"' + (S.canUndo ? '' : ' aria-disabled="true"') +
      ' title="' + (S.canUndo ? '把上次应用过的 ' + S.undoFiles + ' 个文件整体还原并保存' : '暂无可回退的批量修改') + '">' +
      ic('discard') + ' 一键回退</button>' +
      '</div>' +
      '<div class="bb-hint">' + ic('info') + ' 应用即全部保存 · 误改可一键回退（Ctrl+Alt+Z）</div>';
  }
  function renderBottomBar() {
    const bb = el('bottombar');
    if (S.review.active) {
      bb.innerHTML = '<div class="bb-review">' +
        '<button type="button" class="btn btn-sec" data-action="review" data-ra="prev">' + ic('arrow-left') + ' 上一个</button>' +
        '<span class="review-progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + S.review.total + '" aria-valuenow="' + (S.review.index + 1) + '" aria-label="审阅进度">' + (S.review.index + 1) + ' / ' + S.review.total + '</span>' +
        '<button type="button" class="btn btn-primary" data-action="review" data-ra="selectNext">选中并下一个 ' + ic('arrow-right') + '</button>' +
        '<button type="button" class="btn btn-sec" data-action="review" data-ra="skip">跳过</button>' +
        '<button type="button" class="btn btn-sec" data-action="review" data-ra="selectRest">全选剩余</button>' +
        '<button type="button" class="btn btn-sec" data-action="review" data-ra="end">结束</button></div>';
      return;
    }
    // 0.1.9 反馈：前两步底栏只显示上一步/下一步引导；「预览/应用/回退」只在第③步出现。
    bb.innerHTML = S.step === 3 ? bottomBarActionsHtml() : bottomBarNavHtml();
  }

  /* ── 四态：禁用 ─────────────────────────────────────────── */
  // 只操作「本层标记为 busy」的元素，不触碰结构性禁用（🔒 徽标/不兼容快捷片）的 aria-disabled。
  // 同时设置原生 disabled，阻止键盘对已聚焦控件的输入；title 仅在原本没有时补，避免覆盖既有 tooltip。
  function markDisabled(c, on, reason) {
    if (on) {
      if (c.getAttribute('aria-disabled') !== 'true') {
        c.setAttribute('data-busy', '1');
        c.setAttribute('aria-disabled', 'true');
        if ('disabled' in c) c.disabled = true;
        if (!c.getAttribute('title')) { c.setAttribute('data-busy-title', '1'); c.setAttribute('title', reason); }
      }
    } else if (c.getAttribute('data-busy') === '1') {
      c.removeAttribute('aria-disabled'); c.removeAttribute('data-busy');
      if ('disabled' in c) c.disabled = false;
      if (c.getAttribute('data-busy-title') === '1') { c.removeAttribute('title'); c.removeAttribute('data-busy-title'); }
    }
  }
  function setSectionDisabled(secId, disabled, reason) {
    const sec = el(secId); if (!sec) return;
    sec.classList.toggle('is-disabled', disabled);
    const sbody = sec.querySelector('.sec-body');
    if (sbody) sbody.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    const head = sec.querySelector('.sec-head');
    if (head) {
      if (disabled) { if (!head.getAttribute('title')) { head.setAttribute('data-busy-title', '1'); head.setAttribute('title', reason); } }
      else if (head.getAttribute('data-busy-title') === '1') { head.removeAttribute('title'); head.removeAttribute('data-busy-title'); }
    }
    sec.querySelectorAll('.sec-head button, .sec-head input, .sec-head select, .sec-body button, .sec-body input, .sec-body select, .sec-body textarea, .sec-body [role="checkbox"], .step-footer button').forEach(function (c) {
      if (c.closest && c.closest('.batchbar')) return; // 批量条单独处理，避免两套逻辑互相覆盖
      markDisabled(c, disabled, reason);
    });
  }
  function applyDisabled() {
    const busy = S.phase === 'applying';
    const busyReason = '正在应用变更，请稍候';
    ['sec-instructions', 'sec-scope', 'sec-results'].forEach(function (id) { setSectionDisabled(id, busy, busyReason); });
    document.querySelectorAll('.toolbar .btn').forEach(function (b) { markDisabled(b, busy, busyReason); });
    const bar = document.querySelector('.batchbar');
    if (bar) {
      const noHits = hitUris().length === 0;
      const on = busy || noHits;
      const reason = busy ? busyReason : '当前无命中文件，请先设置文件范围或放宽筛选条件';
      bar.querySelectorAll('.btn').forEach(function (b) { markDisabled(b, on, reason); });
    }
  }

  /* ── 总渲染 ─────────────────────────────────────────────── */
  function renderAll() {
    renderOverview();
    renderErrorStrip();
    renderInstructions();
    renderScopePreserve();
    renderResults();
    renderReview();
    renderBottomBar();
    renderWizard();
    applyStep();
    applyDisabled();
  }

  /* ── 消息处理 ───────────────────────────────────────────── */
  function onInit(p) {
    S.hasInit = true;
    S.title = p.title || S.title;
    S.instructions = Array.isArray(p.instructions) ? p.instructions.map(normalizeIns) : [];
    S.selection = normalizeSelection(p.selection);
    // 多级筛选条件只存在前端：面板重开时优先保留本地持久化的条件，
    // 仅当本地完全没有条件时才采用宿主下发的 raw（兼容旧表达式）。
    if (!S.filter.rows.length && !S.filter.dirs.length && !S.filter.raw.trim()) {
      S.filter = normalizeFilter(p.filter);
    }
    S.view = S.filter.view;
    S.candidateExtensions = p.candidateExtensions || [];
    S.equivalentGlob = Array.isArray(p.equivalentGlob) ? p.equivalentGlob : [];
    S.tree = Array.isArray(p.tree) ? p.tree : [];
    S.flat = Array.isArray(p.flat) ? p.flat : [];
    bumpFlatVersion();
    S.counts = p.counts || zeroCounts();
    S.phase = p.phase || 'input';
    S.scopeRoot = ('scopeRoot' in p) ? (p.scopeRoot || null) : null;
    S.customSelection = (S.selection.overrides.add.length + S.selection.overrides.remove.length) > 0;
    S.globMode = S.customSelection ? 'summary' : 'edit';
    if (!S.activeInstructionId || !S.instructions.some(function (i) { return i.id === S.activeInstructionId; })) {
      S.activeInstructionId = S.instructions.length ? S.instructions[0].id : null;
    }
    el('app-title').textContent = S.title;
    document.title = S.title;
    persist();
    renderAll();
    // 面板重开时若恢复了持久化的过滤条件，补发一次 setFilter 触发宿主自动扫描，
    // 否则用户会看到「已恢复条件但树是空的」。
    if (S.filter.raw.trim() || S.filter.rows.length || S.filter.dirs.length) sendFilter(true);
  }
  function onTree(p) {
    if (!S.hasInit) return; // 初次扫描的 tree 早于 init 时丢弃，避免用空指令渲染
    if (Array.isArray(p.tree)) S.tree = p.tree;
    if (Array.isArray(p.flat)) S.flat = p.flat;
    bumpFlatVersion();
    if (p.counts) S.counts = p.counts;
    if (p.candidateExtensions) S.candidateExtensions = p.candidateExtensions;
    if (Array.isArray(p.equivalentGlob)) S.equivalentGlob = p.equivalentGlob;
    renderOverview(); renderScopePreserve(); renderResults(); renderBottomBar(); renderWizard(); applyDisabled();
  }
  function onState(p) {
    S.phase = p.phase || S.phase;
    if (p.counts) S.counts = p.counts;
    // 扫描根目录变化（选目录 / 恢复工作区根）→ 重渲染第 ① 步的根目录行
    if ('scopeRoot' in p) {
      const next = p.scopeRoot || null;
      if (next !== S.scopeRoot) { S.scopeRoot = next; renderScopePreserve(); }
    }
    if (p.message) toast(p.message);
    renderOverview(); renderBottomBar(); renderWizard(); applyDisabled();
  }
  function onPreview(p) {
    S.diffs = Array.isArray(p.diffs) ? p.diffs : [];
    if (!S.diffTextMode && (!S.activeDiff || !S.diffs.some(function (d) { return d.uri === S.activeDiff; }))) {
      S.activeDiff = S.diffs.length ? S.diffs[0].uri : null;
      persist();
    }
    renderResults(); renderInsStats();
  }
  function onReview(p) {
    S.review = { active: !!p.active, index: p.index || 0, total: p.total || 0, item: p.item || null, message: p.message || '' };
    renderReview(); renderBottomBar(); renderScopePreserve();
  }
  function onReport(p) { S.report = p; S.phase = 'report'; renderResults(); renderBottomBar(); renderOverview(); }
  function onUndoState(p) {
    S.canUndo = !!p.available;
    S.undoFiles = p.files || 0;
    renderBottomBar();
  }
  function onError(p) {
    S.errors.push({ message: p.message || '发生错误', detail: p.detail || '' });
    renderErrorStrip(); renderInstructions(); renderScopePreserve(); renderResults();
    announce('错误：' + (p.message || ''));
  }
  window.addEventListener('message', function (e) {
    const m = e.data; if (!m || !m.type) return;
    switch (m.type) {
      case 'init': onInit(m.payload); break;
      case 'tree': onTree(m.payload); break;
      case 'state': onState(m.payload); break;
      case 'preview': onPreview(m.payload); break;
      case 'review': onReview(m.payload); break;
      case 'report': onReport(m.payload); break;
      case 'error': onError(m.payload); break;
      case 'fileContent': onFileContent(m.payload); break;
      case 'undoState': onUndoState(m.payload); break;
    }
  });

  /* ── 审阅动作 / 批量二次确认 / toast ───────────────────── */
  function reviewAction(action) {
    const uri = S.review.item ? S.review.item.uri : undefined;
    const msg = { type: 'review', action: action };
    if (uri && (action === 'selectNext' || action === 'skip' || action === 'prev')) msg.uri = uri;
    post(msg);
  }
  function toggleReviewCurrent() {
    const it = S.review.item; if (!it) return;
    const f = S.flat.find(function (x) { return x.uri === it.uri || x.path === it.path; });
    const checked = f ? !!f.checked : false;
    post({ type: 'select', uri: it.uri, checked: !checked });
    announce(checked ? '已取消选择当前项' : '已选择当前项');
  }
  let confirmCallback = null;
  function showConfirm(title, body, cb) {
    el('confirm-title').textContent = title;
    el('confirm-body').innerHTML = body;
    confirmCallback = cb;
    el('confirm-modal').hidden = false;
    el('confirm-ok').focus();
  }
  function hideConfirm() { el('confirm-modal').hidden = true; confirmCallback = null; }
  function requestApply() {
    flushPending(); // 先把未落定的编辑交给宿主，再取当前范围/补丁
    const uris = selectedUris();
    if (!uris.length) { toast('请先选择文件范围'); return; }
    const n = S.counts.changes || 0;
    // 0.1.4 反馈：应用不再弹「逐条列明细」确认框——文件多时根本核对不过来。
    // 点击即提交并保存：diff 明细已在第 ③ 步预览里可见，应用后可一键回退整体还原。
    post({ type: 'apply', uris: uris });
    toast('正在应用 ' + n + ' 处变更（' + uris.length + ' 个文件）…');
  }
  function buildExpressionSet() {
    return {
      version: 3,
      name: 'Batch Replace 会话',
      selection: {
        include: S.selection.baseInclude.slice(),
        exclude: S.selection.baseExclude.slice(),
        treeFilter: S.filter.raw,
        overrides: { add: S.selection.overrides.add.slice(), remove: S.selection.overrides.remove.slice() },
      },
      instructions: S.instructions.map(function (i) { return JSON.parse(JSON.stringify(i)); }),
    };
  }
  let toastTimer = null;
  function toast(msg) {
    const t = el('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
    announce(msg);
  }
  function announce(msg) { const l = el('live'); if (l) l.textContent = msg; }

  /* ── 事件委托 ───────────────────────────────────────────── */
  function openDirMenu(anchor, path) {
    closeDirMenu();
    const m = document.createElement('div');
    m.className = 'dir-menu'; m.id = 'dir-menu'; m.setAttribute('role', 'menu');
    m.innerHTML =
      '<button type="button" role="menuitem" data-action="dir-op" data-op="selectDirHits" data-dir="' + esc(path) + '">' + ic('check-all') + ' 仅勾选本目录命中项</button>' +
      '<button type="button" role="menuitem" data-action="dir-op" data-op="deselectDirHits" data-dir="' + esc(path) + '">' + ic('circle-slash') + ' 取消本目录命中项</button>';
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left, Math.max(0, window.innerWidth - 190)) + 'px';
    m.style.top = (r.bottom + 2) + 'px';
  }
  function closeDirMenu() { const m = el('dir-menu'); if (m) m.remove(); }

  function onClick(e) {
    // 远程桌面 / VNC 常不派发 dblclick；用第二次 click 的 detail===2 兜底触发预览。
    if (e.detail === 2) {
      const prow = previewTargetFrom(e);
      if (prow) {
        e.preventDefault();
        if (switchDiffFromResultTree(prow)) return;
        openPreviewFor(prow); return;
      }
    }
    // 0.2.2：结果树行「单击」也立即切换右侧 Diff（远程桌面常不派发 dblclick，单击兜底更可靠）。
    const srow = e.target.closest ? e.target.closest('.result-tree .tree-row.is-file.is-readonly') : null;
    if (srow && !(e.target.closest('[data-action]'))) {
      switchDiffFromResultTree(srow);
      return;
    }
    const t = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!t) { closeDirMenu(); return; }
    if (t.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    const a = t.getAttribute('data-action');
    switch (a) {
      case 'wizard-step': {
        const st = parseInt(t.getAttribute('data-step'), 10);
        gotoStep(st);
        break;
      }
      case 'wizard-next': {
        // 步骤落点 CTA：复用 wizard-step 的换步逻辑（flushPending + 换步 + 按需自动预览）
        const st = parseInt(t.getAttribute('data-step'), 10);
        gotoStep(isNaN(st) ? S.step + 1 : st);
        break;
      }
      case 'pick-directory': post({ type: 'pickDirectory' }); break;
      case 'reset-scope-root': post({ type: 'resetScopeRoot' }); break;
      case 'preview-close': hidePreview(); break;
      case 'preview-open-editor': if (S.previewUri) post({ type: 'openFile', uri: S.previewUri }); break;

      case 'import': post({ type: 'importExpressionSet' }); break;
      case 'export': post({ type: 'exportExpressionSet', data: buildExpressionSet() }); toast('已发出导出请求'); break;
      case 'history': post({ type: 'showReport' }); break;
      case 'help': post({ type: 'help' }); break;
      case 'undo-last': {
        if (!S.canUndo) { toast('暂无可回退的批量修改'); break; }
        post({ type: 'undoLast' });
        toast('正在回退上次批量修改…');
        break;
      }

      case 'engine-tab': {
        const eng = t.getAttribute('data-engine');
        S.targetFormat = eng === 'text' ? 'sed' : (S.targetFormat === 'sed' ? 'json' : S.targetFormat);
        persist(); renderInstructions(); renderScopePreserve(); break;
      }
      case 'target-format':
        S.targetFormat = t.getAttribute('data-format'); persist();
        bumpFlatVersion(); // 白名单变化：勾选集 / 目录三态缓存失效
        renderInstructions(); renderScopePreserve(); break;
      case 'add-ins': {
        const ins = newInstruction(); S.instructions.push(ins); S.activeInstructionId = ins.id;
        commitInstructions(true); renderInstructions(); renderWizard(); announce('已添加指令'); break;
      }
      case 'del-ins': {
        const id = t.getAttribute('data-id');
        S.instructions = S.instructions.filter(function (i) { return i.id !== id; });
        if (S.activeInstructionId === id) S.activeInstructionId = S.instructions.length ? S.instructions[0].id : null;
        if (S.scopeEditId === id) S.scopeEditId = null;
        commitInstructions(true); renderInstructions(); renderWizard(); break;
      }
      case 'toggle-ins-scope': {
        const id = t.getAttribute('data-id');
        S.scopeEditId = S.scopeEditId === id ? null : id; renderInstructions(); break;
      }
      case 'ins-format': {
        const id = t.getAttribute('data-id'), fmt = t.getAttribute('data-format');
        const ins = S.instructions.find(function (i) { return i.id === id; }); if (!ins) return;
        ins.format = fmt; ins.fileScope = { mode: 'fixed', format: fmt };
        sendScope(ins); commitInstructions(true); renderInstructions(); break;
      }
      case 'ins-scope-mode': {
        const id = t.getAttribute('data-id'), mode = t.getAttribute('data-mode');
        const ins = S.instructions.find(function (i) { return i.id === id; }); if (!ins) return;
        ins.fileScope = mode === 'all' ? { mode: 'all' } : { mode: 'custom', include: [], exclude: [] };
        sendScope(ins); commitInstructions(true); renderInstructions(); break;
      }
      case 'tag-add': {
        const key = t.getAttribute('data-key'); const inp = findTagInput(key);
        const v = inp ? inp.value.trim() : '';
        if (!v) { if (inp) inp.focus(); return; }
        const tl = tagList(key); if (!tl.arr.includes(v)) tl.arr.push(v);
        if (inp) inp.value = '';
        tl.commit(); break;
      }
      case 'tag-del': {
        const key = t.getAttribute('data-key'), idx = parseInt(t.getAttribute('data-index'), 10);
        const tl = tagList(key);
        if (!isNaN(idx) && idx >= 0) tl.arr.splice(idx, 1);
        tl.commit(); break;
      }
      case 'policy-mode': {
        S.extPolicy = t.getAttribute('data-mode'); persist();
        applyPolicyToActive(); commitInstructions(true);
        renderScopePreserve(); renderInstructions(); break;
      }
      case 'toggle-more':
        S.moreOpen = !S.moreOpen; renderScopePreserve(); break;
      case 'filter-advanced':
        S.filter.advanced = !S.filter.advanced; persist(); renderScopePreserve(); break;
      case 'filter-add':
        S.filter.rows.push({ id: uid(), dim: 'path', op: 'include', value: '' });
        S.filter.advanced = true; S.moreOpen = true; sendFilter(true); renderScopePreserve(); persist(); break;
      case 'filter-row-del': {
        const rid = t.getAttribute('data-id');
        S.filter.rows = S.filter.rows.filter(function (r) { return r.id !== rid; });
        sendFilter(true); renderScopePreserve(); persist(); break;
      }
      case 'filter-mode':
        S.filter.mode = t.getAttribute('data-mode') === 'or' ? 'or' : 'and';
        sendFilter(true); renderScopePreserve(); persist(); break;
      case 'filter-crumb': {
        const idx = parseInt(t.getAttribute('data-index'), 10);
        S.filter.dirs = idx < 0 ? [] : S.filter.dirs.slice(0, idx + 1);
        sendFilter(true); renderScopePreserve(); persist(); break;
      }
      case 'filter-crumb-clear':
        S.filter.dirs = []; sendFilter(true); renderScopePreserve(); persist(); break;
      case 'focus-dir': {
        const dir = t.getAttribute('data-path');
        S.moreOpen = true;
        const dirs = S.filter.dirs;
        if (dirs.length && dir.indexOf(dirs[dirs.length - 1] + '/') === 0) dirs.push(dir);
        else S.filter.dirs = [dir];
        sendFilter(true); renderScopePreserve(); persist();
        toast('已逐级聚焦到「' + dir + '」，点面包屑可回退'); break;
      }
      case 'chip': S.filter.raw = t.getAttribute('data-value'); sendFilter(true); renderScopePreserve(); persist(); break;
      case 'view': S.view = t.getAttribute('data-view'); S.filter.view = S.view; sendFilter(true); renderScopePreserve(); persist(); break;
      case 'clear-filter':
        post({ type: 'batch', op: 'clearFilter', hits: hitUris() });
        S.filter.raw = ''; S.filter.include = []; S.filter.exclude = [];
        S.filter.rows = []; S.filter.dirs = []; S.filter.mode = 'and'; S.filter.onlySelected = false;
        sendFilter(true); renderScopePreserve(); persist(); break;
      case 'only-hits': S.onlyHits = !S.onlyHits; persist(); renderScopePreserve(); break;
      case 'show-all':
        S.showAll = !S.showAll; persist();
        post({ type: 'batch', op: S.showAll ? 'showAll' : 'onlyApplicable', hits: [] });
        renderScopePreserve(); break;
      case 'collapse-all':
        S.expanded = {};
        S.tree.forEach(function walk(n) { if (n.kind === 'dir') { S.expanded[n.path] = false; (n.children || []).forEach(walk); } });
        persist(); renderScopePreserve(); break;
      case 'expand-all':
        S.tree.forEach(function walk(n) { if (n.kind === 'dir') { S.expanded[n.path] = true; (n.children || []).forEach(walk); } });
        persist(); renderScopePreserve(); break;

      case 'batch': {
        const op = t.getAttribute('data-op'); const hits = hitUris();
        if (op === 'clearAll') {
          S.customSelection = false; S.globMode = 'edit'; persist();
          post({ type: 'batch', op: 'clearAll', hits: [] });
          renderBottomBar(); break;
        }
        if (op === 'keepOnly') {
          showConfirm('仅保留命中集',
            '<p>将把选择集收敛为当前筛选视图 <strong>' + hits.length + '</strong> 个文件，命中集之外的已勾选项会被取消。此操作可能大批量取消勾选。</p>',
            function () { post({ type: 'batch', op: 'keepOnly', hits: hits }); });
          return;
        }
        if (op === 'onlyApplicable') {
          S.onlyApplicable = !S.onlyApplicable; persist();
          post({ type: 'batch', op: S.onlyApplicable ? 'onlyApplicable' : 'showAll', hits: [] });
          renderScopePreserve(); return;
        }
        S.customSelection = true; S.globMode = 'summary'; persist();
        post({ type: 'batch', op: op, hits: hits });
        renderBottomBar(); break;
      }
      case 'tri': {
        const path = t.getAttribute('data-path'), kind = t.getAttribute('data-kind');
        if (kind === 'file' && lockedByPath(path)) {
          toast('此后缀不可勾选：当前目标格式只支持 ' + (whitelistText() || '全部类型'));
          break;
        }
        const next = t.getAttribute('aria-checked') !== 'true';
        if (kind === 'dir') {
          // 所见即所得：目录级联只作用于当前筛选视图内的后代
          const visibleUris = visibleFlat().filter(function (f) { return !isLocked(f) && f.path.indexOf(path + '/') === 0; }).map(function (f) { return f.uri; }).filter(Boolean);
          post({ type: 'selectFolder', path: path, checked: next, visibleUris: visibleUris });
          toast((next ? '已勾选' : '已取消') + '「' + path + '」下可见的 ' + visibleUris.length + ' 个文件（筛选外不受影响）');
          lastTriPath = path;
        } else if (e.shiftKey && lastTriPath) {
          const vis = visibleFlat();
          const a = vis.findIndex(function (f) { return f.path === lastTriPath; });
          const b = vis.findIndex(function (f) { return f.path === path; });
          let targets = (a >= 0 && b >= 0 && a !== b)
            ? vis.slice(Math.min(a, b), Math.max(a, b) + 1)
            : [flatByPath[path]].filter(Boolean);
          targets = targets.filter(function (f) { return !isLocked(f); });
          targets.forEach(function (f) { if (f.uri) post({ type: 'select', uri: f.uri, checked: next }); });
          toast('范围' + (next ? '勾选' : '取消') + ' ' + targets.length + ' 个文件（Shift 连续选择）');
          lastTriPath = path;
        } else {
          const f = flatByPath[path]; if (f && f.uri) post({ type: 'select', uri: f.uri, checked: next });
          lastTriPath = path;
        }
        S.customSelection = true; S.globMode = 'summary'; persist();
        break;
      }
      case 'result-toggle-dir': {
        const rp = t.getAttribute('data-rpath');
        S.resultExpanded[rp] = t.getAttribute('aria-expanded') !== 'true';
        renderResults(); break;
      }
      case 'toggle-dir': {
        const path = t.getAttribute('data-path');
        S.expanded[path] = t.getAttribute('aria-expanded') !== 'true';
        persist(); renderScopePreserve(); focusRow(path); break;
      }
      case 'dir-menu': openDirMenu(t, t.getAttribute('data-path')); break;
      case 'dir-op': {
        const op = t.getAttribute('data-op'), dir = t.getAttribute('data-dir');
        const hits = visibleFlat().filter(function (f) { return !isLocked(f) && f.path.indexOf(dir + '/') === 0; }).map(function (f) { return f.uri; }).filter(Boolean);
        post({ type: 'batch', op: op, hits: hits, dir: dir });
        S.customSelection = true; S.globMode = 'summary'; persist();
        closeDirMenu(); break;
      }
      case 'open-file': {
        let uri = t.getAttribute('data-uri');
        if (!uri) { const p = t.getAttribute('data-path'); const f = flatByPath[p]; uri = f ? f.uri : null; }
        if (uri) post({ type: 'openFile', uri: uri });
        break;
      }
      case 'glob-toggle':
        // 纯 UI 折叠/展开，不触碰 globMode / customSelection，也不发消息
        S.globExpanded = !S.globExpanded; renderScopePreserve(); break;
      case 'glob-show-edit':
        S.globMode = 'edit'; S.customSelection = false; persist();
        post({ type: 'setGlob', include: S.selection.baseInclude.slice(), exclude: S.selection.baseExclude.slice() });
        renderScopePreserve(); break;
      case 'glob-reset':
        post({ type: 'resetToGlob' });
        S.globMode = 'edit'; S.customSelection = false; persist(); renderScopePreserve(); break;

      case 'review-start': post({ type: 'review', action: 'start' }); break;
      case 'review': reviewAction(t.getAttribute('data-ra')); break;

      case 'scan': flushPending(); post({ type: 'scan' }); toast('已发出重新扫描请求'); break;
      case 'cancel-scan': post({ type: 'cancelScan' }); break;
      case 'preview-all': flushPending(); post({ type: 'previewAll' }); break;
      case 'apply': requestApply(); break;
      case 'diff-mode': S.diffTextMode = !S.diffTextMode; renderResults(); break;
      case 'jump': {
        const g = t.getAttribute('data-group');
        const target = el('group-' + g);
        if (target) {
          target.open = true;
          target.scrollIntoView({ block: 'center' });
          target.style.borderColor = 'var(--c-focus)';
          setTimeout(function () { target.style.borderColor = ''; }, 1200);
        }
        break;
      }
      case 'confirm-cancel': hideConfirm(); break;
      case 'confirm-ok': { const cb = confirmCallback; hideConfirm(); if (cb) cb(); break; }
      case 'retry-scan': flushPending(); post({ type: 'scan' }); break;
      case 'dismiss-error':
        S.errors = []; renderErrorStrip(); renderInstructions(); renderScopePreserve(); renderResults(); break;
      case 'export-report': post({ type: 'exportReport' }); break;
      case 'report-close': S.report = null; S.phase = 'results'; renderResults(); break;
    }
  }

  function onInput(e) {
    const t = e.target;
    if (t.id === 'filter-input') {
      S.filter.raw = t.value;
      renderFilterEcho(); renderScopePreserve();
      sendFilter();
      return;
    }
    if (t.matches && t.matches('[data-filter-field="value"]') && t.tagName === 'INPUT') {
      const row = S.filter.rows.find(function (r) { return r.id === t.getAttribute('data-id'); });
      if (row) {
        row.value = t.value;
        renderFilterEcho(); renderScopePreserve();
        sendFilter(); persist();
      }
      return;
    }
    if (t.matches && t.matches('[data-ins-field]')) {
      const row = t.closest('[data-ins-row]'); if (!row) return;
      const ins = S.instructions.find(function (i) { return i.id === row.getAttribute('data-id'); }); if (!ins) return;
      const field = t.getAttribute('data-ins-field');
      if (field === 'enabled' || t.type === 'checkbox') return;
      ins[field] = t.value;
      if (field === 'flags') t.classList.toggle('is-invalid', !/^[gim]*$/.test(t.value));
      commitInstructions();
    }
  }
  function onChange(e) {
    const t = e.target;
    if (t.id === 'diff-file-select') { S.activeDiff = t.value; persist(); preserveFocus(renderResults); return; }
    if (t.getAttribute && t.getAttribute('data-action') === 'filter-only-selected') {
      S.filter.onlySelected = !!t.checked;
      sendFilter(true); renderScopePreserve(); persist(); return;
    }
    if (t.matches && t.matches('[data-filter-field]')) {
      const row = S.filter.rows.find(function (r) { return r.id === t.getAttribute('data-id'); });
      if (!row) return;
      const field = t.getAttribute('data-filter-field');
      if (field === 'dim') {
        row.dim = t.value === 'ext' || t.value === 'state' ? t.value : 'path';
        if (row.dim === 'state' && ['selected', 'hits', 'applicable'].indexOf(row.value) < 0) row.value = 'selected';
      } else if (field === 'op') row.op = t.value === 'exclude' ? 'exclude' : 'include';
      else row.value = t.value;
      sendFilter(true); renderScopePreserve(); persist(); return;
    }
    if (t.matches && t.matches('[data-ins-field]')) {
      const row = t.closest('[data-ins-row]'); if (!row) return;
      const ins = S.instructions.find(function (i) { return i.id === row.getAttribute('data-id'); }); if (!ins) return;
      const field = t.getAttribute('data-ins-field');
      ins[field] = (field === 'enabled') ? t.checked : t.value;
      commitInstructions(true);
      renderInstructions();
    }
  }
  function onFocusIn(e) {
    const row = e.target.closest && e.target.closest('[data-ins-row]');
    if (row) { S.activeInstructionId = row.getAttribute('data-id'); persist(); }
  }
  function handleTreeKey(e, row) {
    const tree = el('scope-tree'); if (!tree) return;
    const rows = Array.from(tree.querySelectorAll('[role="treeitem"]'));
    const idx = rows.indexOf(row);
    const lvl = parseInt(row.getAttribute('aria-level'), 10);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (rows[idx + 1]) { setRoving(rows[idx + 1]); rows[idx + 1].focus(); }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows[idx - 1]) { setRoving(rows[idx - 1]); rows[idx - 1].focus(); }
      return;
    }
    if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Space') {
      e.preventDefault(); const tri = row.querySelector('.tri'); if (tri) tri.click(); return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const kind = row.getAttribute('data-kind'), path = row.getAttribute('data-path');
      if (kind === 'dir') {
        if (!isExpanded(path, lvl - 1)) { S.expanded[path] = true; persist(); renderScopePreserve(); focusRow(path); }
        else if (rows[idx + 1]) { setRoving(rows[idx + 1]); rows[idx + 1].focus(); }
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const kind = row.getAttribute('data-kind'), path = row.getAttribute('data-path');
      if (kind === 'dir' && isExpanded(path, lvl - 1)) { S.expanded[path] = false; persist(); renderScopePreserve(); focusRow(path); }
      else {
        for (let j = idx - 1; j >= 0; j--) {
          if (parseInt(rows[j].getAttribute('aria-level'), 10) < lvl) { setRoving(rows[j]); rows[j].focus(); break; }
        }
      }
    }
  }
  function onKeyDown(e) {
    const pv = el('preview-modal');
    if (pv && !pv.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); hidePreview(); }
      return;
    }
    if (!el('confirm-modal').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); hideConfirm(); }
      return;
    }
    if (S.review.active) {
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); reviewAction('selectNext'); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); reviewAction('prev'); return; }
      if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Space') { e.preventDefault(); toggleReviewCurrent(); return; }
      if (e.key === 'Escape') { e.preventDefault(); reviewAction('end'); return; }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault(); const i = el('filter-input'); if (i) { i.focus(); i.select(); } return;
    }
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); requestApply(); return; }
    if (e.key === 'Escape') { closeDirMenu(); return; }
    if (e.key === 'Enter' && e.target.matches && e.target.matches('input[data-tagkey]')) {
      e.preventDefault();
      const key = e.target.getAttribute('data-tagkey');
      const btns = document.querySelectorAll('[data-action="tag-add"]');
      for (const b of btns) { if (b.getAttribute('data-key') === key) { b.click(); break; } }
      return;
    }
    const ae = document.activeElement;
    if (ae && ae.matches && ae.matches('[role="treeitem"]')) { handleTreeKey(e, ae); return; }
    if (e.key === 'Enter' && !(ae && ae.matches && ae.matches('input,select,textarea,button,[role="tab"],[role="checkbox"],summary,a'))) {
      e.preventDefault(); post({ type: 'previewAll' });
    }
  }

  /** 文件行双击 → 只读预览源文件（不改动文件、不影响单击勾选）。 */
  let lastPreviewPath = '', lastPreviewAt = 0;
  function openPreviewFor(row) {
    const path = row.getAttribute('data-path'); if (!path) return;
    const now = Date.now();
    // dblclick 与 click(detail===2) 兜底可能各触发一次，400ms 内同文件只发一次。
    if (path === lastPreviewPath && now - lastPreviewAt < 400) return;
    lastPreviewPath = path; lastPreviewAt = now;
    const f = flatByPath[path];
    const uri = (f && f.uri) ? f.uri : path;
    post({ type: 'previewFile', uri: uri, path: path });
  }
  function previewTargetFrom(e) {
    if (!e.target.closest) return null;
    if (e.target.closest('[data-action]')) return null;      // 勾选框/按钮双击不触发
    return e.target.closest('.tree-row.is-file');
  }
  /** 0.2.2：第③步结果树行双击 → 切换右侧 Diff 视图；返回 true 表示已处理。 */
  function switchDiffFromResultTree(row) {
    if (!row || !row.classList.contains('is-readonly')) return false;
    const uri = row.getAttribute('data-diff-uri');
    if (!uri) return false;
    if (S.activeDiff !== uri) {
      S.activeDiff = uri;
      persist();
      renderResults();
    }
    return true;
  }
  function onDblClick(e) {
    const row = previewTargetFrom(e);
    if (!row) return;
    e.preventDefault();
    if (switchDiffFromResultTree(row)) return;
    openPreviewFor(row);
  }

  document.addEventListener('click', onClick);
  document.addEventListener('dblclick', onDblClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('focusin', onFocusIn);
  window.addEventListener('keydown', onKeyDown);

  // 首屏：通知宿主已就绪，等待 init 下发全部初始状态
  post({ type: 'ready' });
})();
