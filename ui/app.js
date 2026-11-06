/* dsh-market-info panel app — vanilla JS, no dependencies. */
(function () {
  'use strict';
  var API = '/market-info/api';
  var state = { tab: 'feed', feed: null, article: null, keywords: [], category: '', source: '', sources: [], presets: [], feeds: [], settings: null, quotes: null, watchlist: [], quoteRefreshSec: 5, quoteTimer: null, quoteLoading: false, detailId: null, detailRange: '1d', detailPoints: null, historyTimer: null };

  function api(path, options) {
    var opts = options || {};
    var headers = Object.assign({ 'x-market-info': '1' }, opts.headers || {});
    if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
    var ctrl = null;
    var timer = null;
    if (opts.timeoutMs) {
      ctrl = new AbortController();
      timer = setTimeout(function () { ctrl.abort(); }, opts.timeoutMs);
    }
    return fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.body, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.json().catch(function () { return { ok: false, error: 'HTTP ' + res.status }; });
    }).catch(function (error) {
      if (timer) clearTimeout(timer);
      throw error;
    });
  }
  function el(id) { return document.getElementById(id); }
  function esc(text) {
    return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('zh-CN', { monthly: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function hostOf(url) { try { return new URL(url).hostname; } catch (e) { return ''; } }
  function fmtPrice(n) {
    if (n == null || isNaN(n)) return '—';
    var abs = Math.abs(n);
    var digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : 4;
    try { return Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }); } catch (e) { return String(n); }
  }
  function fmtPct(n) {
    if (n == null || isNaN(n)) return '—';
    return (n > 0 ? '+' : '') + Number(n).toFixed(2) + '%';
  }
  function trendClass(n) { return n == null || isNaN(n) ? 'flat' : n > 0.0001 ? 'up' : n < -0.0001 ? 'down' : 'flat'; }
  function fmtClock(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  function parseKeywords(text) { return String(text || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
  function setTab(name) {
    state.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (s) {
      s.classList.toggle('active', s.id === 'tab-' + name);
    });
    if (name === 'fav') loadFavorites();
    if (name === 'settings') loadSettings();
    if (name === 'quotes') loadQuotes(false);
  }

  // ---------- feed ----------
  function renderCatChips(sources) {
    var box = el('catChips');
    box.innerHTML = '';
    var cats = [];
    (sources || []).forEach(function (s) {
      if (s.category && cats.indexOf(s.category) < 0) cats.push(s.category);
    });
    var all = document.createElement('button');
    all.textContent = '全部';
    all.className = state.category === '' ? 'active' : '';
    all.addEventListener('click', function () { state.category = ''; loadFeed(false); });
    box.appendChild(all);
    cats.forEach(function (cat) {
      var b = document.createElement('button');
      b.textContent = cat;
      b.className = state.category === cat ? 'active' : '';
      b.addEventListener('click', function () { state.category = cat; loadFeed(false); });
      box.appendChild(b);
    });
  }
  function renderSourceOptions(sources) {
    var sel = el('srcSelect');
    var current = state.source || '';
    sel.innerHTML = '<option value="">全部来源</option>';
    (sources || []).forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name + (s.ok ? '' : ' ⚠') + (s.count ? ' (' + s.count + ')' : '');
      if (s.id === current) o.selected = true;
      sel.appendChild(o);
    });
  }
  function renderFeed(data) {
    var list = el('feedList');
    list.innerHTML = '';
    var items = (data && data.items) || [];
    var kw = (data && data.keywords) || [];
    var extra = [];
    if (kw.length) extra.push('关键词: ' + kw.join(' / '));
    if (state.category) extra.push('分类: ' + state.category);
    if (state.source) extra.push('来源: ' + state.source);
    el('feedStatus').textContent = items.length
      ? '共 ' + items.length + ' 条 · ' + (data.cached ? '缓存' : '实时') + (extra.length ? ' · ' + extra.join(' · ') : '')
      : '没有匹配的头条';
    items.forEach(function (item) {
      var li = document.createElement('li');
      li.innerHTML = '<div class="title">' + esc(item.title) + '</div>' +
        '<div class="meta"><span class="src">' + esc(item.source) + '</span>' + (item.category ? '<span class="source-tag">' + esc(item.category) + '</span>' : '') +
        '<span class="ts">' + esc(fmtDate(item.date)) + '</span>' + (item.creator ? '<span>' + esc(item.creator) + '</span>' : '') + '</div>' +
        (item.summary ? '<div class="summary">' + esc(item.summary) + '</div>' : '');
      li.addEventListener('click', function () { openArticle(item.url, false, item.readHint || item.title || '', item.summary || '', item.source || ''); });
      list.appendChild(li);
    });
  }
  function loadFeed(refresh) {
    el('feedStatus').textContent = '加载中…';
    var q = '/feed?kw=' + encodeURIComponent(state.keywords.join(',')) +
      '&cat=' + encodeURIComponent(state.category) +
      '&src=' + encodeURIComponent(state.source) +
      (refresh ? '&refresh=1' : '');
    api(q).then(function (data) {
      if (!data.ok) { el('feedStatus').textContent = '加载失败: ' + (data.error || '未知错误'); return; }
      state.feed = data;
      state.sources = data.sources || [];
      renderCatChips(state.sources);
      renderSourceOptions(state.sources);
      renderFeed(data);
    }).catch(function (e) { el('feedStatus').textContent = '网络错误: ' + e; });
  }
  function applyKeywordFilter() {
    state.keywords = parseKeywords(el('kwInput').value);
    api('/settings', { method: 'POST', body: JSON.stringify({ keywords: state.keywords }) }).then(function () { loadFeed(true); });
  }
  function clearKeywordFilter() {
    state.keywords = [];
    el('kwInput').value = '';
    api('/settings', { method: 'POST', body: JSON.stringify({ keywords: [] }) }).then(function () { loadFeed(true); });
  }

  // ---------- quotes ----------
  function renderTicker(quotes) {
    var track = el('tickerTrack');
    track.innerHTML = '';
    (quotes || []).forEach(function (q) {
      var b = document.createElement('button');
      b.className = 'tick';
      b.title = q.label + ' · ' + q.symbol + ' · 来自 ' + q.source + ' · ' + fmtClock(q.ts);
      var cls = trendClass(q.changePct);
      b.innerHTML = '<span class="tlabel">' + esc(q.label) + '</span><span class="tprice ' + cls + '">' + esc(fmtPrice(q.price)) + '</span>' +
        '<span class="tchg ' + cls + '">' + esc(fmtPct(q.changePct)) + '</span>';
      b.addEventListener('click', function () { openQuoteDetail(q.id); });
      track.appendChild(b);
    });
    if (!(quotes || []).length) {
      track.innerHTML = '<span class="muted" style="padding:6px 4px">行情加载中…</span>';
    }
  }
  function renderQuoteCards(quotes) {
    var grid = el('quoteGrid');
    grid.innerHTML = '';
    (quotes || []).forEach(function (q) {
      var cls = trendClass(q.changePct);
      var div = document.createElement('div');
      div.className = 'qcard';
      div.setAttribute('role', 'button');
      div.tabIndex = 0;
      div.addEventListener('click', function () { openQuoteDetail(q.id); });
      div.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openQuoteDetail(q.id); } });
      div.innerHTML = '<div class="qtop"><span class="qname">' + esc(q.label) + '</span><span class="qsym">' + esc(q.symbol) + '</span></div>' +
        '<div class="qprice ' + cls + '">' + esc(fmtPrice(q.price)) + '</div>' +
        '<div class="qchg ' + cls + '"><span class="' + cls + '">' + esc(fmtPct(q.changePct)) + '</span>' +
        (q.changeAbs == null ? '' : '<span class="muted">' + esc((q.changeAbs > 0 ? '+' : '') + Number(q.changeAbs).toFixed(2)) + '</span>') + '</div>' +
        '<div class="qfoot"><span class="qsrc">' + esc(q.source) + '</span><span>' + esc(fmtClock(q.ts)) + (q.currency ? ' · ' + esc(q.currency) : '') + '</span></div>';
      grid.appendChild(div);
    });
    if (!(quotes || []).length) {
      grid.innerHTML = '<div class="qcard"><div class="qname">暂时没有行情</div><div class="muted">切到设置 → 自选行情，检查代码或稍后重试</div></div>';
    }
  }
  function renderQuoteSources(sources) {
    var box = el('quoteSources');
    box.innerHTML = '';
    (sources || []).forEach(function (s) {
      var chip = document.createElement('span');
      chip.className = 'chips-chip';
      chip.style.cssText = 'padding:4px 10px;border:1px solid var(--line);border-radius:999px;font-size:12px;color:' + (s.ok ? 'var(--muted)' : 'var(--danger)');
      chip.textContent = s.name + ' ' + (s.ok ? (s.count + ' 个 · ' + s.ms + 'ms') : '失败');
      box.appendChild(chip);
    });
  }
  function loadQuotes(refresh) {
    if (state.quoteLoading && !refresh) return;
    state.quoteLoading = true;
    el('quoteStatus').textContent = '加载中…';
    api('/quotes' + (refresh ? '?refresh=1' : '')).then(function (data) {
      if (!data.ok) { el('quoteStatus').textContent = '行情加载失败: ' + (data.error || ''); return; }
      state.quotes = data;
      var quotes = data.quotes || [];
      renderTicker(quotes);
      renderQuoteCards(quotes);
      renderQuoteSources(data.sources || []);
      var when = data.cached ? '缓存' : '实时';
      el('quoteStatus').textContent = quotes.length + ' 个标的 · ' + when + ' · ' + fmtClock(data.fetchedAt) +
        (data.missing && data.missing.length ? ' · 缺 ' + data.missing.length + ' 个' : '') +
        (data.degraded ? ' · 降频保护中' : '');
      el('quotePolicy').textContent = '批量单请求 · ' + (state.quoteRefreshSec || 5) + 's 刷新 · 多源兜底 · 隐藏页面自动暂停';
    }).catch(function (e) { el('quoteStatus').textContent = '网络错误: ' + e; }).then(function () { state.quoteLoading = false; });
  }
  function renderWatchList(items) {
    var list = el('watchList');
    list.innerHTML = '';
    (items || []).forEach(function (item) {
      var li = document.createElement('li');
      var syms = [item.tv, item.yahoo, item.tencent, item.coingecko].filter(Boolean).join(' / ');
      li.innerHTML = '<span class="name">' + esc(item.label) + '</span><span class="url sym">' + esc(syms || item.id) + '</span><button class="del">删除</button>';
      li.querySelector('.del').addEventListener('click', function () {
        var next = (items || []).filter(function (x) { return x.id !== item.id; });
        saveWatchlist(next);
      });
      list.appendChild(li);
    });
    if (!(items || []).length) list.innerHTML = '<li><span class="muted">还没有自选，添加一个 TradingView 代码即可</span></li>';
  }
  function saveWatchlist(next) {
    api('/settings', { method: 'POST', body: JSON.stringify({ watchlist: next }) }).then(function (data) {
      el('quoteSettingsStatus').textContent = data.ok ? '已保存自选' : ('失败: ' + (data.error || ''));
      if (data.ok) { state.watchlist = next; renderWatchList(next); loadQuotes(true); }
    });
  }
  function addQuote() {
    var label = el('newQuoteLabel').value.trim();
    var tv = el('newQuoteTv').value.trim();
    var yahoo = el('newQuoteYahoo').value.trim();
    var tencent = el('newQuoteTencent').value.trim();
    if (!label || (!tv && !yahoo && !tencent)) { el('quoteAddStatus').textContent = '至少填名称和一个代码（TradingView 优先）'; return; }
    var id = label.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || ('q' + Date.now());
    var entry = { id: id, label: label };
    if (tv) entry.tv = tv;
    if (yahoo) entry.yahoo = yahoo;
    if (tencent) entry.tencent = tencent;
    if ((state.watchlist || []).some(function (x) { return x.id === id; })) { el('quoteAddStatus').textContent = '这个 id 已存在，换个名称'; return; }
    var next = (state.watchlist || []).concat([entry]);
    api('/settings', { method: 'POST', body: JSON.stringify({ watchlist: next }) }).then(function (data) {
      el('quoteAddStatus').textContent = data.ok ? '已添加' : ('失败: ' + (data.error || ''));
      if (!data.ok) return;
      el('newQuoteLabel').value = ''; el('newQuoteTv').value = ''; el('newQuoteYahoo').value = ''; el('newQuoteTencent').value = '';
      loadSettings(); loadQuotes(true);
    });
  }
  function saveQuoteRefresh() {
    var sec = Math.max(3, Math.min(300, Number(el('quoteRefreshSec').value) || 5));
    api('/settings', { method: 'POST', body: JSON.stringify({ quoteRefreshSec: sec }) }).then(function (data) {
      el('quoteSettingsStatus').textContent = data.ok ? '已保存刷新频率' : ('失败: ' + (data.error || ''));
      if (data.ok) { state.quoteRefreshSec = sec; scheduleQuoteTimer(); loadQuotes(false); }
    });
  }
  function scheduleQuoteTimer() {
    if (state.quoteTimer) { clearTimeout(state.quoteTimer); state.quoteTimer = null; }
    var sec = Math.max(3, Math.min(300, state.quoteRefreshSec || 5));
    var jitter = sec * 1000 * (0.9 + Math.random() * 0.2);
    state.quoteTimer = setTimeout(function tick() {
      state.quoteTimer = null;
      if (document.visibilityState === 'visible' && !state.quoteLoading) loadQuotes(false);
      scheduleQuoteTimer();
    }, Math.round(jitter));
  }

  // ---------- article ----------
  function renderArticle(payload) {
    var box = el('article');
    var art = payload.article;
    if (!art) {
      box.classList.add('hidden');
      el('candidates').classList.remove('hidden');
      var list = el('candidateList');
      list.innerHTML = '';
      ((payload.candidates) || []).forEach(function (c) {
        var li = document.createElement('li');
        li.innerHTML = '<div class="title">' + esc(c.title || c.url) + '</div><div class="meta"><span>' + esc(c.url) + '</span></div>';
        li.addEventListener('click', function () { openArticle(c.url); });
        list.appendChild(li);
      });
      return;
    }
    el('candidates').classList.add('hidden');
    box.classList.remove('hidden');
    var paras = String(art.body || '').split(/\n{2,}/).filter(Boolean).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    var fallbackNote = '';
    if (art.summaryFallback === 'timeout') fallbackNote = '<div class="partial-note">全文查找超时，先显示这条摘要；正文可能还在后台继续缓存，稍后点「换副本」再试，或打开原文。</div>';
    else if (art.summaryFallback) fallbackNote = '<div class="partial-note">这一类快讯源没有独立正文页，下面显示的是资讯流里的摘要；完整内容看原文链接。</div>';
    var partialNote = art.partial ? '<div class="partial-note">只抓到开头（可能受付费墙 / JS 渲染限制），可试试候选副本或原文链接。</div>' : '';
    box.innerHTML = '<h1>' + esc(art.title) + '</h1>' +
      '<div class="ameta"><span>转载: ' + esc(art.sourceHost || '') + '</span><span>' + (payload.cached ? '本地缓存' : '实时抓取') + '</span><span>' + esc(fmtDate(art.fetchedAt ? new Date(art.fetchedAt).toISOString() : '')) + '</span></div>' +
      fallbackNote + partialNote + '<div class="body">' + paras + '</div>' +
      '<div class="actions"><a href="' + esc(art.sourceUrl) + '" target="_blank" rel="noopener">原文链接</a>' +
      '<button id="btnReread">换副本</button><button id="btnFav">收藏</button><button id="btnExport">导出 Markdown</button><button id="btnCopy">复制 Markdown</button></div>';
    el('btnReread').addEventListener('click', function () { openArticle(art.original, true, art.originalTitle || ''); });
    el('btnFav').addEventListener('click', function () {
      api('/favorites', { method: 'POST', body: JSON.stringify({ article: art }) }).then(function (data) {
        el('btnFav').textContent = data.added ? '已收藏' : '已取消收藏';
      });
    });
    el('btnExport').addEventListener('click', function () { exportArticle(art); });
    el('btnCopy').addEventListener('click', function () {
      var md = '# ' + art.title + '\n\n- 转载来源: ' + art.sourceUrl + '\n- 原始链接: ' + art.original + '\n\n' + art.body;
      navigator.clipboard.writeText(md).then(function () { el('btnCopy').textContent = '已复制'; }).catch(function () {});
    });
  }
  function exportArticle(art) {
    fetch(API + '/export?u=' + encodeURIComponent(art.original), { headers: { 'x-market-info': '1' } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var disp = res.headers.get('content-disposition') || '';
      var m = disp.match(/filename="?([^";]+)"?/);
      return res.text().then(function (text) { return { text: text, name: m ? m[1] : 'article.md' }; });
    }).then(function (r) {
      var blob = new Blob([r.text], { type: 'text/markdown;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    }).catch(function (e) { alert('导出失败: ' + e.message); });
  }
  function showSummaryFallback(url, titleHint, summary, why) {
    var host = '';
    try { host = new URL(url).hostname; } catch (e) {}
    var art = {
      title: titleHint || host || url,
      body: summary,
      sourceUrl: url,
      sourceHost: host,
      original: url,
      summaryFallback: why || 'summary',
      fetchedAt: Date.now()
    };
    renderArticle({ article: art, candidates: [], cached: false });
    el('readStatus').textContent = '';
  }
  function openArticle(url, refresh, titleHint, summaryHint, sourceHint) {
    if (!url) return;
    var flashSource = /快讯|见闻|快报|7x24/i.test(String(sourceHint || ''));
    if (flashSource && summaryHint && !refresh) {
      setTab('read');
      el('urlInput').value = url;
      showSummaryFallback(url, titleHint, summaryHint, 'summary');
      el('readStatus').textContent = '快讯源，已显示摘要；正在后台尝试补全正文…';
      api('/read?u=' + encodeURIComponent(url) + (titleHint ? '&t=' + encodeURIComponent(titleHint) : ''), { timeoutMs: 45000 }).then(function (data) {
        if (data && data.ok && data.article && data.article.body) {
          state.article = data.article;
          renderArticle(data);
          el('readStatus').textContent = '已补全正文';
        } else {
          el('readStatus').textContent = '这条快讯没有独立正文，以上是资讯流摘要。';
        }
      }).catch(function () { el('readStatus').textContent = '这条快讯暂时没有可读正文，以上是资讯流摘要。'; });
      return;
    }
    setTab('read');
    el('urlInput').value = url;
    el('readStatus').textContent = summaryHint
      ? '抓取中…（超过 20 秒仍未拿到全文，会先显示这条摘要）'
      : '抓取中…（首次可能需要 5-30 秒）';
    el('article').classList.add('hidden');
    el('candidates').classList.add('hidden');
    var t = titleHint ? '&t=' + encodeURIComponent(titleHint) : '';
    api('/read?u=' + encodeURIComponent(url) + t + (refresh ? '&refresh=1' : ''), { timeoutMs: summaryHint ? 20000 : 60000 }).then(function (data) {
      if (!data.ok) {
        if (summaryHint) {
          showSummaryFallback(url, titleHint, summaryHint, 'summary');
          return;
        }
        el('readStatus').innerHTML = '没抓到全文（可能被付费墙拦住，或还没被搜索收录）。下面的候选副本可以点；也可以 <a href="' + esc(url) + '" target="_blank" rel="noopener">在浏览器打开原文</a>。';
        renderArticle({ article: null, candidates: data.candidates || [] });
        return;
      }
      el('readStatus').textContent = '';
      state.article = data.article;
      renderArticle(data);
    }).catch(function (e) {
      if (summaryHint) {
        showSummaryFallback(url, titleHint, summaryHint, e && e.name === 'AbortError' ? 'timeout' : 'summary');
        return;
      }
      el('readStatus').innerHTML = '网络错误或超时。可以 <a href="' + esc(url) + '" target="_blank" rel="noopener">在浏览器打开原文</a>，或再点一次重试。';
    });
  }

  // ---------- search ----------
  function doSearch() {
    var q = el('searchInput').value.trim();
    if (!q) return;
    el('searchStatus').textContent = '搜索中…（可能需要 5-20 秒）';
    el('searchList').innerHTML = '';
    api('/search?q=' + encodeURIComponent(q)).then(function (data) {
      if (!data.ok) { el('searchStatus').textContent = '搜索失败: ' + (data.error || ''); return; }
      var results = data.results || [];
      el('searchStatus').textContent = results.length ? '找到 ' + results.length + ' 个候选，点一条直接阅读' : '没有找到候选';
      results.forEach(function (r) {
        var li = document.createElement('li');
        li.innerHTML = '<div class="title">' + esc(r.title || r.url) + '</div><div class="meta"><span>' + esc(hostOf(r.url)) + '</span><span>评分 ' + esc(r.score) + '</span></div>';
        li.addEventListener('click', function () { openArticle(r.url); });
        el('searchList').appendChild(li);
      });
    }).catch(function (e) { el('searchStatus').textContent = '网络错误: ' + e; });
  }

  // ---------- favorites ----------
  function loadFavorites() {
    api('/favorites').then(function (data) {
      var list = el('favList');
      list.innerHTML = '';
      var items = (data && data.items) || [];
      el('favStatus').textContent = items.length ? '共 ' + items.length + ' 条' : '还没有收藏';
      items.forEach(function (f) {
        var li = document.createElement('li');
        li.innerHTML = '<div class="row"><div class="grow"><div class="title">' + esc(f.title || f.url) + '</div><div class="meta"><span>' + esc(f.sourceHost || '') + '</span><span>' + esc(fmtDate(new Date(f.ts).toISOString())) + '</span></div></div><button class="del">移除</button></div>';
        li.querySelector('.grow').addEventListener('click', function () { openArticle(f.url); });
        li.querySelector('.del').addEventListener('click', function (ev) {
          ev.stopPropagation();
          api('/favorites', { method: 'POST', body: JSON.stringify({ remove: true, url: f.url }) }).then(function () { loadFavorites(); });
        });
        list.appendChild(li);
      });
    });
  }

  // ---------- settings ----------
  function loadSettings() {
    api('/status').then(function (data) {
      if (!data.ok) return;
      state.settings = data.settings;
      state.feeds = data.settings.feeds || [];
      state.keywords = data.settings.keywords || [];
      var c = data.cache;
      var s = data.settings;
      el('version').textContent = 'v' + (data.version || '');
      el('cacheInfo').textContent = '数据目录: ' + c.dataDir + '\n篇数: ' + c.items + '\n占用: ' + (c.bytes / 1024 / 1024).toFixed(2) + ' MB / 上限 ' + (c.maxBytes / 1024 / 1024).toFixed(0) + ' MB\n保留: ' + c.ttlHours + ' 小时 / 最多 ' + c.maxItems + ' 篇';
      el('statusInfo').textContent = '代理: ' + (s.proxy || '直连') + '\n关键词: ' + ((s.keywords || []).join(', ') || '(无)') + '\n数据源: ' + (s.feeds || []).length + ' 个 · ' + (s.feeds || []).map(function (f) { return f.name; }).join(' / ');
      el('cachehint').textContent = c.items + ' 篇 · ' + (c.bytes / 1024 / 1024).toFixed(1) + ' MB';
      el('capMb').value = Math.round(c.maxBytes / 1024 / 1024);
      el('capItems').value = c.maxItems;
      el('capTtl').value = c.ttlHours;
      el('kwSettings').value = (s.keywords || []).join(', ');
      if (!el('kwInput').value) el('kwInput').value = (s.keywords || []).join(', ');
      el('rsshubBase').value = s.rsshubBase || '';
      renderFeedSources(s.feeds || []);
      renderAntiBlock(s.antiBlock || {});
      state.watchlist = s.watchlist || [];
      state.quoteRefreshSec = s.quoteRefreshSec || 60;
      el('quoteRefreshSec').value = state.quoteRefreshSec;
      renderWatchList(state.watchlist);
      scheduleQuoteTimer();
      loadPresets();
      loadHealth();
    });
  }
  function loadPresets() {
    api('/presets').then(function (data) {
      var box = el('presetChips');
      box.innerHTML = '';
      var presets = (data && data.presets) || [];
      presets.forEach(function (p) {
        var b = document.createElement('button');
        b.textContent = '＋ ' + p.name + (p.category ? '（' + p.category + '）' : '');
        b.addEventListener('click', function () {
          var exists = state.feeds.some(function (f) { return f.type === p.type && (f.url || f.query) === (p.url || p.query); });
          if (exists) { el('feedSourceStatus').textContent = '已存在'; return; }
          var entry = { id: p.id, name: p.name, type: p.type };
          for (var k of ['url', 'query', 'route', 'hl', 'gl', 'ceid', 'category', 'filterSources']) { if (p[k] !== undefined) entry[k] = p[k]; }
          var next = state.feeds.concat([entry]);
          api('/feeds', { method: 'POST', body: JSON.stringify({ feeds: next }) }).then(function (r) {
            el('feedSourceStatus').textContent = r.ok ? '已添加 ' + p.name : ('失败: ' + (r.error || ''));
            loadSettings();
          });
        });
        box.appendChild(b);
      });
    });
  }
  function saveCaps() {
    var patch = { maxBytes: Number(el('capMb').value) * 1024 * 1024, maxItems: Number(el('capItems').value), ttlHours: Number(el('capTtl').value) };
    api('/settings', { method: 'POST', body: JSON.stringify(patch) }).then(function (data) {
      el('capsStatus').textContent = data.ok ? '已保存' : ('失败: ' + (data.error || ''));
      loadSettings();
    });
  }
  function saveKeywords() {
    var keywords = parseKeywords(el('kwSettings').value);
    api('/settings', { method: 'POST', body: JSON.stringify({ keywords: keywords }) }).then(function (data) {
      el('kwStatus').textContent = data.ok ? '已保存' : ('失败: ' + (data.error || ''));
      state.keywords = keywords;
      el('kwInput').value = keywords.join(', ');
      loadSettings();
    });
  }
  function renderFeedSources(feeds) {
    var list = el('feedSources');
    list.innerHTML = '';
    if (!feeds.length) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="url">使用内置默认源（16 个：通讯社 / 美股 / 国际 / 深度 / 中文）</span>';
      list.appendChild(li);
      return;
    }
    feeds.forEach(function (f) {
      var li = document.createElement('li');
      var detail = (f.type || 'rss') + (f.category ? ' · ' + f.category : '') + ' · ' + (f.url || f.query || '内置接口');
      li.innerHTML = '<span class="name">' + esc(f.name) + '</span><span class="url">' + esc(detail) + '</span><button class="del">删除</button>';
      li.querySelector('.del').addEventListener('click', function () {
        var next = feeds.filter(function (x) { return !(x.type === f.type && (x.url || x.query) === (f.url || f.query)); });
        api('/feeds', { method: 'POST', body: JSON.stringify({ feeds: next }) }).then(function () { loadSettings(); });
      });
      list.appendChild(li);
    });
  }
  function addFeed() {
    var type = el('newFeedType').value;
    var name = el('newFeedName').value.trim();
    var value = el('newFeedUrl').value.trim();
    var category = el('newFeedCat').value.trim();
    if (type === 'rss' && !/^https?:\/\//i.test(value)) { el('feedSourceStatus').textContent = 'RSS 需要 http(s) URL'; return; }
    if ((type === 'bing-news' || type === 'google-news') && !value) { el('feedSourceStatus').textContent = '新闻搜索源需要搜索词'; return; }
    if (type === 'rsshub' && !value) { el('feedSourceStatus').textContent = 'RSSHub 需要路由，如 /36kr/newsflashes'; return; }
    var entry = { id: 'feed-' + Date.now(), name: name || value || type, type: type, category: category };
    if (type === 'rss') entry.url = value;
    if (type === 'bing-news' || type === 'google-news') entry.query = value;
    if (type === 'rsshub') entry.route = value;
    var next = state.feeds.concat([entry]);
    api('/feeds', { method: 'POST', body: JSON.stringify({ feeds: next }) }).then(function (data) {
      el('feedSourceStatus').textContent = data.ok ? '已添加' : ('失败: ' + (data.error || ''));
      el('newFeedName').value = '';
      el('newFeedUrl').value = '';
      el('newFeedCat').value = '';
      loadSettings();
    });
  }

  // ---------- anti-block ----------
  function renderAntiBlock(ab) {
    el('abEnabled').checked = ab.enabled !== false;
    el('abRetries').value = ab.retries === undefined ? 1 : ab.retries;
    el('abInterval').value = ab.hostIntervalMs === undefined ? 0 : ab.hostIntervalMs;
    el('abAutoFallback').checked = ab.autoFallback !== false;
    el('abProxyPool').value = (ab.proxyPool || []).join('\n');
    el('abReaderProxy').value = ab.readerProxy || '';
  }
  function saveAntiBlock() {
    var pool = el('abProxyPool').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    var payload = {
      enabled: el('abEnabled').checked,
      rotateUA: el('abEnabled').checked,
      retries: Number(el('abRetries').value),
      hostIntervalMs: Number(el('abInterval').value),
      autoFallback: el('abAutoFallback').checked,
      proxyPool: pool,
      readerProxy: el('abReaderProxy').value.trim()
    };
    api('/settings', { method: 'POST', body: JSON.stringify({ antiBlock: payload }) }).then(function (data) {
      el('abStatus').textContent = data.ok ? '已保存' : ('失败: ' + (data.error || ''));
      loadSettings();
    });
  }
  function runNetTest() {
    var u = el('netTestUrl').value.trim();
    if (!u) return;
    el('netTestResult').textContent = '测试中…';
    api('/net/test?u=' + encodeURIComponent(u)).then(function (data) {
      el('netTestResult').textContent = JSON.stringify(data, null, 2);
    }).catch(function (e) { el('netTestResult').textContent = '失败: ' + e; });
  }

  // ---------- health / import-export ----------
  function loadHealth() {
    api('/health').then(function (data) {
      var body = el('healthBody');
      body.innerHTML = '';
      var rows = (data && data.sources) || [];
      el('healthStatus').textContent = rows.length ? '共 ' + rows.length + ' 个源的统计（本次进程）' : '还没有统计，先去资讯流刷新一次';
      rows.forEach(function (s) {
        var tr = document.createElement('tr');
        var badge = '<span class="badge ' + (s.status || 'unknown') + '">' + esc(s.status || 'unknown') + '</span>';
        var rate = s.attempts ? Math.round(s.successRate * 100) + '%' : '—';
        tr.innerHTML = '<td>' + esc(s.name) + '</td><td>' + esc(s.type) + '</td><td>' + badge + '</td>' +
          '<td>' + rate + ' (' + s.ok + '/' + s.attempts + ')</td>' +
          '<td>' + (s.avgMs ? s.avgMs + ' ms' : '—') + '</td>' +
          '<td>' + (s.lastMs ? s.lastMs + ' ms' : '—') + '</td>' +
          '<td class="err" title="' + esc(s.lastError || '') + '">' + esc((s.lastError || '').slice(0, 60)) + '</td>';
        body.appendChild(tr);
      });
    }).catch(function (e) { el('healthStatus').textContent = '健康度加载失败: ' + e; });
  }
  function exportFeeds() {
    fetch(API + '/feeds/export', { headers: { 'x-market-info': '1' } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob().then(function (blob) { return { blob: blob }; });
    }).then(function (r) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(r.blob);
      a.download = 'market-info-feeds.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    }).catch(function (e) { el('importStatus').textContent = '导出失败: ' + e.message; });
  }
  function importFeeds(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      api('/feeds/import', { method: 'POST', body: text }).then(function (data) {
        el('importStatus').textContent = data.ok ? ('已导入 ' + data.imported + ' 个源') : ('导入失败: ' + (data.error || ''));
        loadSettings();
      });
    };
    reader.readAsText(file);
  }
  function saveRsshub() {
    var base = el('rsshubBase').value.trim();
    api('/settings', { method: 'POST', body: JSON.stringify({ rsshubBase: base }) }).then(function (data) {
      el('rsshubStatus').textContent = data.ok ? '已保存' : ('失败: ' + (data.error || ''));
      loadSettings();
    });
  }

  // ---------- detail drawer + history chart ----------
  function openQuoteDetail(id) {
    var quote = null;
    var all = (state.quotes && state.quotes.quotes) || [];
    for (var i = 0; i < all.length; i += 1) if (all[i].id === id) { quote = all[i]; break; }
    if (!quote) return;
    state.detailId = id;
    state.detailRange = '1d';
    el('quoteDetail').classList.remove('hidden');
    document.body.classList.add('drawer-open');
    el('detailLabel').textContent = quote.label;
    el('detailSym').textContent = quote.symbol;
    el('detailPrice').textContent = fmtPrice(quote.price);
    el('detailPrice').className = 'detail-price ' + trendClass(quote.changePct);
    el('detailChg').textContent = fmtPct(quote.changePct) + (quote.changeAbs == null ? '' : '  ' + (quote.changeAbs > 0 ? '+' : '') + Number(quote.changeAbs).toFixed(2));
    el('detailChg').className = 'detail-chg ' + trendClass(quote.changePct);
    renderDetailStats(quote);
    Array.prototype.forEach.call(el('detailRanges').querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-range') === '1d');
    });
    loadHistory('1d', false);
    el('detailClose').focus();
  }
  function closeQuoteDetail() {
    el('quoteDetail').classList.add('hidden');
    document.body.classList.remove('drawer-open');
    if (state.historyTimer) { clearTimeout(state.historyTimer); state.historyTimer = null; }
    state.detailId = null;
  }
  function renderDetailStats(quote) {
    var rows = [];
    if (quote.open != null) rows.push(['开盘', fmtPrice(quote.open)]);
    if (quote.high != null) rows.push(['最高', fmtPrice(quote.high)]);
    if (quote.low != null) rows.push(['最低', fmtPrice(quote.low)]);
    if (quote.prevClose != null) rows.push(['昨收', fmtPrice(quote.prevClose)]);
    if (quote.volume != null) rows.push(['成交量', fmtVolume(quote.volume)]);
    if (quote.currency) rows.push(['币种', quote.currency]);
    rows.push(['来源', quote.source]);
    el('detailStats').innerHTML = rows.map(function (r) {
      return '<span class="stat"><em>' + esc(r[0]) + '</em><b>' + esc(r[1]) + '</b></span>';
    }).join('');
  }
  function fmtVolume(n) {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(Math.round(n));
  }
  function loadHistory(range, refresh) {
    var id = state.detailId;
    if (!id) return;
    state.detailRange = range;
    el('chartEmpty').classList.remove('hidden');
    el('chartEmpty').textContent = '图表加载中…';
    el('detailSource').textContent = '';
    api('/history?id=' + encodeURIComponent(id) + '&range=' + encodeURIComponent(range) + (refresh ? '&refresh=1' : '')).then(function (data) {
      if (!data || !data.ok) {
        el('detailChart').innerHTML = '';
        el('chartEmpty').classList.remove('hidden');
        el('chartEmpty').textContent = '这个标的暂时没有历史数据（可换范围或稍后重试）';
        el('detailSource').textContent = '';
        return;
      }
      state.detailPoints = data.points;
      renderChart(data);
      el('detailSource').textContent = '数据: ' + data.source + ' · ' + (data.cached ? '缓存' : '实时') + ' · ' + fmtClock(data.fetchedAt);
    }).catch(function (e) {
      el('chartEmpty').classList.remove('hidden');
      el('chartEmpty').textContent = '图表加载失败: ' + e;
    });
  }
  function renderChart(data) {
    var points = data.points || [];
    if (points.length < 2) {
      el('detailChart').innerHTML = '';
      el('chartEmpty').classList.remove('hidden');
      el('chartEmpty').textContent = '点太少了，画不出走势';
      return;
    }
    el('chartEmpty').classList.add('hidden');
    var W = 720, H = 260, padTop = 18, padBottom = 26, padX = 4;
    var high = data.high != null ? data.high : Math.max.apply(null, points.map(function (p) { return p.price; }));
    var low = data.low != null ? data.low : Math.min.apply(null, points.map(function (p) { return p.price; }));
    if (high === low) { high += 1; low -= 1; }
    var range = high - low;
    var t0 = points[0].t, t1 = points[points.length - 1].t;
    var span = t1 - t0 || 1;
    var xy = points.map(function (p) {
      var x = padX + ((p.t - t0) / span) * (W - padX * 2);
      var y = padTop + (1 - (p.price - low) / range) * (H - padTop - padBottom);
      return { x: x, y: y, t: p.t, price: p.price };
    });
    var first = points[0].price, last = points[points.length - 1].price;
    var up = last >= first;
    var color = up ? 'var(--pos)' : 'var(--neg)';
    var baseY = H - padBottom;
    var line = xy.map(function (p, i) { return (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' ');
    var area = line + ' L ' + xy[xy.length - 1].x.toFixed(1) + ' ' + baseY + ' L ' + xy[0].x.toFixed(1) + ' ' + baseY + ' Z';
    var gid = 'grad' + (up ? 'Up' : 'Down');
    var xLabels = '<text x="' + padX + '" y="' + (H - 6) + '" class="axis">' + esc(fmtAxisTime(t0, data.range)) + '</text>' +
      '<text x="' + (W - padX) + '" y="' + (H - 6) + '" class="axis end">' + esc(fmtAxisTime(t1, data.range)) + '</text>';
    var yLabels = '<text x="' + padX + '" y="' + (padTop + 4) + '" class="axis">' + esc(fmtPrice(high)) + '</text>' +
      '<text x="' + padX + '" y="' + (baseY - 4) + '" class="axis">' + esc(fmtPrice(low)) + '</text>';
    el('detailChart').innerHTML =
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + (up ? '#2fbf71' : '#e05252') + '" stop-opacity="0.28"/>' +
      '<stop offset="100%" stop-color="' + (up ? '#2fbf71' : '#e05252') + '" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + xy[xy.length - 1].x.toFixed(1) + '" cy="' + xy[xy.length - 1].y.toFixed(1) + '" r="3.2" fill="' + color + '"/>' +
      xLabels + yLabels +
      '<line id="chartCross" x1="0" y1="' + padTop + '" x2="0" y2="' + baseY + '" class="cross hidden"/>';
    bindChartHover(data, xy, W, H);
  }
  function fmtAxisTime(ts, range) {
    var d = new Date(ts);
    if (range === '1d') return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  }
  function bindChartHover(data, xy, W, H) {
    var wrap = el('detailChartWrap');
    var tip = el('chartTip');
    if (wrap._chartMove) wrap.removeEventListener('mousemove', wrap._chartMove);
    if (wrap._chartLeave) wrap.removeEventListener('mouseleave', wrap._chartLeave);
    wrap._chartMove = function (ev) {
      var rect = wrap.getBoundingClientRect();
      var ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      var idx = Math.round(ratio * (xy.length - 1));
      var p = xy[idx];
      tip.classList.remove('hidden');
      tip.style.left = Math.min(rect.width - 96, Math.max(4, (p.x / W) * rect.width - 44)) + 'px';
      tip.innerHTML = '<b>' + esc(fmtPrice(p.price)) + '</b><span>' + esc(fmtAxisTime(p.t, data.range)) + '</span>';
      var cross = el('detailChart').querySelector('#chartCross');
      if (cross) { cross.setAttribute('x1', p.x); cross.setAttribute('x2', p.x); cross.classList.remove('hidden'); }
    };
    wrap._chartLeave = function () {
      tip.classList.add('hidden');
      var cross = el('detailChart').querySelector('#chartCross');
      if (cross) cross.classList.add('hidden');
    };
    wrap.addEventListener('mousemove', wrap._chartMove);
    wrap.addEventListener('mouseleave', wrap._chartLeave);
  }
  function bindQuoteDetail() {
    el('detailClose').addEventListener('click', closeQuoteDetail);
    el('detailBackdrop').addEventListener('click', closeQuoteDetail);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !el('quoteDetail').classList.contains('hidden')) closeQuoteDetail();
    });
    el('detailRefresh').addEventListener('click', function () { loadHistory(state.detailRange, true); });
    el('detailRanges').addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('button[data-range]') : null;
      if (!b) return;
      var range = b.getAttribute('data-range');
      Array.prototype.forEach.call(el('detailRanges').querySelectorAll('button'), function (x) { x.classList.toggle('active', x === b); });
      loadHistory(range, false);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        if (!state.quoteLoading) loadQuotes(false);
        if (state.detailId && state.detailPoints) loadHistory(state.detailRange, false);
      }
    });
  }

  // ---------- boot ----------
  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
    });
    el('refreshFeed').addEventListener('click', function () { loadFeed(true); });
    el('refreshQuotes').addEventListener('click', function () { loadQuotes(true); });
    el('addQuote').addEventListener('click', addQuote);
    el('saveQuoteRefresh').addEventListener('click', saveQuoteRefresh);
    bindQuoteDetail();
    el('newQuoteTv').addEventListener('keydown', function (e) { if (e.key === 'Enter') addQuote(); });
    el('applyKw').addEventListener('click', applyKeywordFilter);
    el('clearKw').addEventListener('click', clearKeywordFilter);
    el('kwInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') applyKeywordFilter(); });
    el('srcSelect').addEventListener('change', function () { state.source = el('srcSelect').value; loadFeed(false); });
    el('openUrl').addEventListener('click', function () { openArticle(el('urlInput').value.trim()); });
    el('urlInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') openArticle(el('urlInput').value.trim()); });
    el('doSearch').addEventListener('click', doSearch);
    el('searchInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
    el('clearCache').addEventListener('click', function () { api('/cache', { method: 'POST' }).then(function () { loadSettings(); }); });
    el('saveCaps').addEventListener('click', saveCaps);
    el('saveKw').addEventListener('click', saveKeywords);
    el('addFeed').addEventListener('click', addFeed);
    el('resetFeeds').addEventListener('click', function () {
      api('/feeds', { method: 'POST', body: JSON.stringify({ feeds: [] }) }).then(function () { loadSettings(); });
    });
    el('refreshHealth').addEventListener('click', loadHealth);
    el('exportFeeds').addEventListener('click', exportFeeds);
    el('importFeeds').addEventListener('click', function () { el('feedsFile').click(); });
    el('feedsFile').addEventListener('change', function () { importFeeds(el('feedsFile').files && el('feedsFile').files[0]); });
    el('saveRsshub').addEventListener('click', saveRsshub);
    el('saveAntiBlock').addEventListener('click', saveAntiBlock);
    el('runNetTest').addEventListener('click', runNetTest);
    el('netTestUrl').addEventListener('keydown', function (e) { if (e.key === 'Enter') runNetTest(); });
    api('/status').then(function (data) {
      if (!data || !data.ok) return;
      el('version').textContent = 'v' + (data.version || '');
      state.settings = data.settings;
      state.keywords = data.settings.keywords || [];
      state.feeds = data.settings.feeds || [];
      state.watchlist = data.settings.watchlist || [];
      state.quoteRefreshSec = data.settings.quoteRefreshSec || 5;
      el('quoteRefreshSec').value = state.quoteRefreshSec;
      scheduleQuoteTimer();
      if (state.keywords.length) el('kwInput').value = state.keywords.join(', ');
      var c = data.cache;
      el('cachehint').textContent = c.items + ' 篇 · ' + (c.bytes / 1024 / 1024).toFixed(1) + ' MB';
    }).catch(function () {});
    loadFeed(false);
    loadQuotes(false);
    scheduleQuoteTimer();
  });
})();
