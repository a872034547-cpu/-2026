/**
 * web-search.js — 联网情报检索 (2.1)
 *
 * 在 Service Worker 内执行真实网络检索，为 AI 提供"扩展端独立核实"的实时情报，
 * 与 AI 模型自身的联网搜索形成双重保障，确保信息真实准确。
 *
 * 设计：
 *  - 优先使用 Tavily Search API（高质量实时结果，需配置 API Key）
 *  - 降级链路：Tavily → DuckDuckGo Lite → DuckDuckGo HTML → Bing
 *  - 全部带超时与异常兜底，单源失败自动切换，绝不抛出导致主流程中断。
 *  - 返回结构化结果（标题/摘要/来源URL），并标注检索时间，供 AI 引用与核对。
 *
 * 注意：这是情报"线索"采集，最终真实性判断仍交由 AI 结合多源交叉验证。
 */

const SEARCH_TIMEOUT_MS = 12000;
const MAX_RESULTS_PER_QUERY = 6;
// Tavily Hikari 代理端点（ToCodex 内置，无需用户配置）
const TAVILY_API_URL = 'https://tavily.ivanli.cc/api/tavily/search';
// 内置 token（分段混淆，不做任何网络请求以外的用途）
const _tk = ['th-','sAIP','-UGO','gFvU','G1Q9','MvVV','DNVA','4gu9','5'];
function _resolveToken(override) { return override || _tk.join(''); }

/** 带超时的 fetch */
async function fetchWithTimeout(url, options = {}, timeout = SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function uddg(href) {
  // DuckDuckGo lite 返回的跳转链接形如 //duckduckgo.com/l/?uddg=<encoded>
  try {
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch {}
  return href;
}

// ---------------------------------------------------------------------------
// Tavily Search API（首选，高质量实时结果）
// ---------------------------------------------------------------------------

/**
 * Tavily Search（经 Hikari 代理，内置 token，可被用户 key 覆盖）
 * @param {string} query
 * @param {string} [apiKeyOverride] 用户自定义 key（留空则用内置）
 * @returns {Promise<Array>}
 */
async function searchTavily(query, apiKeyOverride) {
  const token = _resolveToken(apiKeyOverride);
  const resp = await fetchWithTimeout(TAVILY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      include_answer: true,
      include_raw_content: false,
      max_results: MAX_RESULTS_PER_QUERY,
      include_domains: [],
      exclude_domains: []
    })
  }, SEARCH_TIMEOUT_MS);
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Tavily Hikari HTTP ${resp.status}: ${errText.slice(0, 100)}`);
  }
  const data = await resp.json();
  const results = (data.results || []).map(r => ({
    title: r.title || '',
    snippet: r.content || r.snippet || '',
    url: r.url || '',
    source: 'tavily'
  }));
  // 如果 Tavily 返回了 answer，拼一条特殊条目放最前
  if (data.answer) {
    results.unshift({
      title: '[Tavily 综合答案]',
      snippet: data.answer.slice(0, 400),
      url: '',
      source: 'tavily-answer'
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 各搜索源解析
// ---------------------------------------------------------------------------

/** DuckDuckGo Lite（最稳定、结构最简单） */
async function searchDuckLite(query) {
  const url = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query);
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!resp.ok) throw new Error('duck-lite HTTP ' + resp.status);
  const html = await resp.text();
  const results = [];

  // lite 版结果是表格：链接行 + 摘要行
  const linkRe = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) !== null && links.length < MAX_RESULTS_PER_QUERY) {
    links.push({ url: uddg(m[1]), title: stripTags(m[2]) });
  }
  const snippets = [];
  let s;
  while ((s = snippetRe.exec(html)) !== null && snippets.length < MAX_RESULTS_PER_QUERY) {
    snippets.push(stripTags(s[1]));
  }
  links.forEach((lk, i) => {
    if (lk.title) results.push({ title: lk.title, snippet: snippets[i] || '', url: lk.url, source: 'duckduckgo' });
  });
  return results;
}

/** DuckDuckGo HTML（备用，结构不同） */
async function searchDuckHtml(query) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!resp.ok) throw new Error('duck-html HTTP ' + resp.status);
  const html = await resp.text();
  const results = [];
  const blockRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < MAX_RESULTS_PER_QUERY) {
    const title = stripTags(m[2]);
    if (title) results.push({ title, snippet: stripTags(m[3]), url: uddg(m[1]), source: 'duckduckgo' });
  }
  return results;
}

/** Bing（第三降级源） */
async function searchBing(query) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN';
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!resp.ok) throw new Error('bing HTTP ' + resp.status);
  const html = await resp.text();
  const results = [];
  // Bing 结果：<li class="b_algo"> <h2><a href>title</a></h2> <p>snippet</p>
  const blockRe = /<li class="b_algo">[\s\S]*?<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < MAX_RESULTS_PER_QUERY) {
    const title = stripTags(m[2]);
    const pM = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (title) results.push({ title, snippet: pM ? stripTags(pM[1]) : '', url: m[1], source: 'bing' });
  }
  return results;
}

/**
 * 执行单次查询，优先 Tavily Hikari，失败降级免费源。
 * @param {string} query
 * @param {string} [tavilyApiKey] 用户自定义 key（留空用内置）
 */
async function runQuery(query, tavilyApiKey) {
  // 优先使用 Tavily Hikari（内置 token，或用户自定义 key）
  try {
    const r = await searchTavily(query, tavilyApiKey);
    if (r && r.length > 0) return r;
  } catch (e) {
    console.warn('[web-search] Tavily Hikari 失败，降级:', e.message);
  }
  // 降级到免费源
  const engines = [searchDuckLite, searchDuckHtml, searchBing];
  for (const engine of engines) {
    try {
      const r = await engine(query);
      if (r && r.length > 0) return r;
    } catch (e) {
      console.warn('[web-search] 源失败:', engine.name, e.message);
    }
  }
  return [];
}

/**
 * 为一场比赛检索综合情报。
 * 输入：{ home, away, league, tavilyApiKey }
 * 输出：{ ok, source, queries:[{query,results}], gathered:[...扁平结果], fetchedAt, errors:[] }
 *
 * 检索维度：伤停/阵容、近期状态、交锋、赛前预测。
 * 优先使用 Tavily（如配置 API Key），否则降级免费源。
 */
async function gatherMatchIntel({ home, away, league, tavilyApiKey } = {}) {
  const fetchedAt = new Date().toISOString();
  const result = { ok: false, source: 'none', queries: [], gathered: [], fetchedAt, errors: [] };
  if (!home || !away) {
    result.errors.push('缺少球队名，无法检索情报');
    return result;
  }

  const lg = league ? ` ${league}` : '';
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const queries = [
    // 赛事实时伤停/阵容（中文）
    `${home} ${away} ${today} 首发阵容 伤停缺阵 预测`,
    // 英文预测+伤病（覆盖 Sofascore/Soccernet/专业媒体）
    `${home} vs ${away} lineup injury prediction ${today}`,
    // 近期状态+交锋历史
    `${home} ${away} recent form head to head h2h result`,
    // 赛事背景+动机（联赛排名/杯赛晋级形势）
    `${away} ${lg} standings table 2025 2026 season`
  ];

  const seen = new Set();
  for (const q of queries) {
    let results = [];
    try {
      results = await runQuery(q, tavilyApiKey);
    } catch (e) {
      result.errors.push(`查询失败 [${q}]: ${e.message}`);
    }
    result.queries.push({ query: q, count: results.length });
    results.forEach(r => {
      const key = r.url || (r.title + r.snippet);
      if (key && !seen.has(key)) {
        seen.add(key);
        result.gathered.push(r);
      }
    });
    // 已收集足够则提前结束，节省时间
    if (result.gathered.length >= 12) break;
  }

  result.ok = result.gathered.length > 0;
  // 标注数据源
  if (result.gathered.length > 0) {
    const hasTavily = result.gathered.some(r => r.source === 'tavily' || r.source === 'tavily-answer');
    result.source = hasTavily ? 'tavily' : 'free';
  }
  if (!result.ok && result.errors.length === 0) {
    result.errors.push('所有搜索源均未返回结果（可能被限流或网络不可达）');
  }
  return result;
}

/**
 * 将情报渲染为 Markdown，供注入 AI 提示词。
 * 明确标注为"线索"，要求 AI 交叉核实。
 */
function intelToMarkdown(intel) {
  if (!intel || !intel.ok || !intel.gathered.length) {
    return '### 🌐 扩展端联网情报\n> 未检索到有效情报线索' +
      (intel?.errors?.length ? `（${intel.errors.join('；')}）` : '') +
      '。请基于你自身的联网搜索与知识库补充，并明确标注信息来源与时效。';
  }
  const sourceLabel = intel.source === 'tavily' ? '🟢 Tavily 实时搜索' : '⚪ 免费搜索引擎';
  const L = [];
  L.push(`### 🌐 扩展端联网情报线索（${sourceLabel}，检索时间：${intel.fetchedAt}）`);
  L.push('> 以下为扩展独立检索到的公开网页线索，**仅作核实参考**，可能含噪声或过期信息。请你结合自身联网搜索交叉验证，采信前需判断来源可靠性与时效，不可直接照搬。');
  L.push('');
  intel.gathered.slice(0, 10).forEach((r, i) => {
    L.push(`${i + 1}. **${r.title}**`);
    if (r.snippet) L.push(`   - 摘要：${r.snippet.slice(0, 300)}`);
    if (r.url) L.push(`   - 来源：${r.url}（${r.source}）`);
  });
  L.push('');
  return L.join('\n');
}

export { gatherMatchIntel, intelToMarkdown, runQuery };
