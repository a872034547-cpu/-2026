// popup.js - 弹窗逻辑控制

const PLUGIN_PASSWORD = '2026';
const PLUGIN_UNLOCK_KEY = 'pluginUnlocked_v1';
let appInitialized = false;
let currentMatchId = null;
let currentReport = null;
let currentData = null;

// 提示音（Web Audio API）
function playAlert(type = 'high') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    if (type === 'high') {
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
    } else {
      osc.frequency.setValueAtTime(660, ctx.currentTime);
    }
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch(e) {}
}

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', initUnlockGate);

async function initUnlockGate() {
  const input = document.getElementById('pluginPasswordInput');
  const btn = document.getElementById('pluginUnlockBtn');
  const saved = await chrome.storage.local.get(PLUGIN_UNLOCK_KEY);

  btn?.addEventListener('click', unlockPlugin);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') unlockPlugin();
  });

  if (saved[PLUGIN_UNLOCK_KEY] === true) {
    await showAppAndInit();
  } else {
    document.getElementById('unlockScreen').style.display = 'flex';
    document.getElementById('appShell').style.display = 'none';
    setTimeout(() => input?.focus(), 50);
  }
}

async function unlockPlugin() {
  const input = document.getElementById('pluginPasswordInput');
  const err = document.getElementById('pluginUnlockError');
  const password = (input?.value || '').trim();
  if (password !== PLUGIN_PASSWORD) {
    err.textContent = '密码不正确，请关注公众号发送“足球”获取插件密码。';
    input?.focus();
    input?.select();
    return;
  }
  err.textContent = '';
  await chrome.storage.local.set({ [PLUGIN_UNLOCK_KEY]: true });
  await showAppAndInit();
}

async function showAppAndInit() {
  document.getElementById('unlockScreen').style.display = 'none';
  document.getElementById('appShell').style.display = 'block';
  if (appInitialized) return;
  appInitialized = true;
  await initializeApp();
}

async function initializeApp() {
  initTabs();
  initButtons();
  await loadMonitorList();

  // 管理员才显示同步按钮
  try {
    const perm = await sendMsg({ type: 'GET_BET_RECORDS' });
    if (perm?.isAdmin) {
      const syncBtn = document.getElementById('syncServerBtn');
      if (syncBtn) syncBtn.style.display = 'inline-flex';
      const uploadBtn = document.getElementById('uploadLocalRecordsBtn');
      if (uploadBtn) uploadBtn.style.display = 'inline-flex';
    }
  } catch (e) { /* 非关键，忽略 */ }

  // 从 storage 恢复上次使用的 matchId
  const saved = await chrome.storage.local.get('lastMatchId');
  if (saved.lastMatchId) {
    document.getElementById('matchIdInput').value = saved.lastMatchId;
    currentMatchId = saved.lastMatchId;
    await loadDataForMatch(currentMatchId);
  }
}

// ===== Tab 切换 =====
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = `tab-${tab.dataset.tab}`;
      document.getElementById(panelId).classList.add('active');
      // 切换到今日赛事 Tab 时，若列表为空则自动从服务器加载
      if (tab.dataset.tab === 'daily' && todayMatchItems.length === 0) {
        loadServerMatchesToDaily();
      }
    });
  });
}

// 从服务器直接加载比赛列表（无需先采集）
async function loadServerMatchesToDaily() {
  try {
    const resp = await sendMsg({ type: 'LOAD_SERVER_MATCHES' });
    if (!resp?.ok || !resp.matches?.length) return;
    todayMatchItems = resp.matches.map(m => ({
      match: {
        id: m.matchId,
        league: m.league || '',
        home: m.home || '',
        away: m.away || '',
        time: m.matchTime || '',
        score: '',
        status: 'upcoming',
        leagueTier: m.leagueTier || '其他',
        leaguePriority: m.leaguePriority || 0
      },
      matchData: m.data || null,
      profitability: m.profitability || null,
      checked: false
    }));
    showAlert(`☁️ 已从服务器加载 ${todayMatchItems.length} 场比赛数据`, 'success', 3000);
    renderDailyList();
    document.getElementById('collectSelectedBtn').style.display = 'inline-flex';
  } catch(e) { /* 静默失败 */ }
}

// ===== 按钮绑定 =====
function initButtons() {
  document.getElementById('startMonitorBtn').addEventListener('click', startMonitor);
  document.getElementById('fetchOnceBtn').addEventListener('click', fetchOnce);
  document.getElementById('localPredBtn').addEventListener('click', runLocalPredict);
  document.getElementById('aiPredBtn').addEventListener('click', runAIPredict);
  document.getElementById('aiDeepBtn')?.addEventListener('click', runDeepAIPredict);
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    if (currentMatchId) await loadDataForMatch(currentMatchId);
    await loadMonitorList();
  });
  document.getElementById('settingsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('copyReportBtn').addEventListener('click', () => {
    if (currentReport) copyToClipboard(currentReport.markdown);
  });
  document.getElementById('copyMdBtn').addEventListener('click', () => {
    if (currentReport) copyToClipboard(currentReport.markdown);
  });
  document.getElementById('copyTxtBtn').addEventListener('click', () => {
    if (currentReport) copyToClipboard(currentReport.text);
  });
  // 历史记录Tab点击时加载
  document.querySelector('[data-tab="history"]').addEventListener('click', loadHistory);
  // 今日赛事
  document.getElementById('fetchTodayBtn').addEventListener('click', fetchTodayMatches);
  document.getElementById('collectAllBtn').addEventListener('click', collectAll);
  document.getElementById('stopCollectBtn').addEventListener('click', () => { collectAborted = true; showAlert('正在停止采集...', 'info', 2000); });
  document.getElementById('selectAllBtn').addEventListener('click', selectAll);
  document.getElementById('invertSelectBtn').addEventListener('click', invertSelect);
  document.getElementById('collectSelectedBtn').addEventListener('click', collectSelected);
  document.getElementById('batchAIBtn').addEventListener('click', runBatchAI);
  document.getElementById('syncServerBtn')?.addEventListener('click', () => syncAllToServer('syncServerBtn'));
  document.getElementById('uploadLocalRecordsBtn')?.addEventListener('click', () => syncAllToServer('uploadLocalRecordsBtn'));
  document.getElementById('recordsModeSwitch')?.addEventListener('change', loadDailyRecords);
  document.getElementById('dailyFilterTier').addEventListener('change', renderDailyList);
  // 复选框事件委托
  document.getElementById('dailyMatchList').addEventListener('change', (e) => {
    if (!e.target.classList.contains('daily-check')) return;
    const id = e.target.dataset.id;
    const item = todayMatchItems.find(it => it.match.id === id);
    if (item) item.checked = e.target.checked;
  });
  // 战绩Tab点击时加载
  document.querySelector('[data-tab="dailyrecords"]').addEventListener('click', loadDailyRecords);
  document.getElementById('loadRecordsBtn').addEventListener('click', loadDailyRecords);
  document.getElementById('recordsDateFilter').addEventListener('change', renderDailyRecords);
  document.getElementById('recordsSortMode').addEventListener('change', renderDailyRecords);
  // verifyAllBtn 由事件委托处理，只需设 data-action 即可
  document.getElementById('verifyAllBtn').dataset.action = 'verifyAllPending';
  document.getElementById('recordsResultFilter').addEventListener('change', renderDailyRecords);

  // AI 对话按钮
  document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage);
  document.getElementById('clearChatBtn').addEventListener('click', clearChat);
  // Enter发送（Shift+Enter换行）
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  document.getElementById('debugBtn').addEventListener('click', async () => {
    const matchId = currentMatchId || getMatchId();
    if (!matchId) return;
    // 显示已存储的原始数据结构
    const resp = await sendMsg({ type: 'GET_STORED_DATA', matchId });
    const rawJson = JSON.stringify(resp.data?.data || {}, null, 2);
    // 把 analysis 部分放前面
    const analysis = resp.data?.data?.analysis || {};
    const debugText = `=== DEBUG INFO ===
title: ${analysis._debug?.title || 'N/A'}
textLen: ${analysis._debug?.textLen || 'N/A'}
tables: ${analysis._debug?.tables || 'N/A'}

=== trendTables ===
${JSON.stringify(analysis._debug?.trendTables || [], null, 2)}

=== matchInfo ===
${JSON.stringify(analysis.matchInfo, null, 2)}

=== homeStats ===
${JSON.stringify(analysis.homeStats, null, 2)}

=== awayStats ===
${JSON.stringify(analysis.awayStats, null, 2)}

=== handicapTrend ===
${JSON.stringify(analysis.handicapTrend, null, 2)}

=== preBriefing ===
${analysis.preBriefing || '(空)'}

=== injuries ===
${JSON.stringify(analysis.injuries, null, 2)}

=== winDrawWin summary ===
${JSON.stringify(resp.data?.data?.winDrawWin?.summary, null, 2)}

=== winDrawWin companies[0] ===
${JSON.stringify(resp.data?.data?.winDrawWin?.companies?.[0], null, 2)}

=== asian companies[0] ===
${JSON.stringify(resp.data?.data?.asian?.companies?.[0], null, 2)}`;

    document.getElementById('reportContent').innerHTML = `<div class="ai-output" style="font-size:10px;font-family:monospace">${escapeHtml(debugText)}</div>`;
    switchTab('report');
    copyToClipboard(debugText);
    showAlert('调试信息已复制', 'info', 2000);
  });
}

// ===== 获取当前输入的 matchId =====
function getMatchId() {
  const input = document.getElementById('matchIdInput').value.trim();
  if (!input) { showAlert('请输入比赛ID', 'warn'); return null; }
  // 支持输入完整URL，自动提取ID
  const urlMatch = input.match(/(\d{6,8})/);
  return urlMatch ? urlMatch[1] : input;
}

// ===== 开始监控 =====
async function startMonitor() {
  const matchId = getMatchId();
  if (!matchId) return;
  const intervalMin = parseInt(document.getElementById('intervalSelect').value);
  currentMatchId = matchId;
  await chrome.storage.local.set({ lastMatchId: matchId });

  showAlert(`正在启动监控 ID: ${matchId}...`, 'info');
  const resp = await sendMsg({ type: 'START_MONITOR', matchId, intervalMin });
  if (resp.ok) {
    showAlert(`✅ 监控已启动，每 ${intervalMin} 分钟更新一次`, 'success');
    await loadMonitorList();
    switchTab('monitor');
  } else {
    showAlert(`启动失败: ${resp.error}`, 'error');
  }
}

// ===== 管理员一键全量同步到服务器（本地战绩 + 本地比赛数据） =====
async function syncAllToServer(btnId) {
  const btn = document.getElementById(btnId || 'syncServerBtn');
  if (btn) { btn.disabled = true; btn.textContent = '☁️ 同步中...'; }
  try {
    const resp = await sendMsg({ type: 'SYNC_ALL_TO_SERVER' });
    if (resp?.ok) {
      showAlert(`✅ ${resp.message || '同步完成'}`, 'success', 5000);
      // 刷新战绩显示
      await loadDailyRecords();
    } else {
      showAlert(`☁️ 同步失败：${resp?.error || '未知错误'}`, 'error', 5000);
    }
  } catch (e) {
    showAlert(`☁️ 同步出错：${e.message}`, 'error', 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.id === 'uploadLocalRecordsBtn' ? '☁️ 上传本地' : '☁️ 同步'; }
  }
}

// ===== 单次采集 =====
async function fetchOnce() {
  const matchId = getMatchId();
  if (!matchId) return;
  currentMatchId = matchId;
  await chrome.storage.local.set({ lastMatchId: matchId });

  setLoading('fetchOnceBtn', true);
  showAlert(`正在采集 ID: ${matchId}...`, 'info');
  try {
    const resp = await sendMsg({ type: 'FETCH_NOW', matchId });
    if (resp.ok) {
      currentData = { matchId, fetchTime: Date.now(), data: resp.data };
      showAlert(`✅ 数据采集成功`, 'success');
      await renderDataPanel(resp.data);
      await generateAndShowReport();
      switchTab('data');
    } else {
      showAlert(`采集失败: ${resp.error}`, 'error');
    }
  } catch (e) {
    showAlert(`错误: ${e.message}`, 'error');
  } finally {
    setLoading('fetchOnceBtn', false);
  }
}

// ===== 加载已存数据 =====
async function loadDataForMatch(matchId) {
  const resp = await sendMsg({ type: 'GET_STORED_DATA', matchId });
  if (resp.ok && resp.data) {
    currentData = resp.data;
    await renderDataPanel(resp.data.data);
    await generateAndShowReport();
  }
}

// ===== 本地预测 =====
async function runLocalPredict() {
  const matchId = currentMatchId || getMatchId();
  if (!matchId) return;
  setLoading('localPredBtn', true);
  try {
    const resp = await sendMsg({ type: 'LOCAL_PREDICT', matchId });
    if (resp.ok) {
      renderLocalPrediction(resp.prediction);
      switchTab('local');
      // 检查高信心提示
      const highAlert = resp.prediction.alerts?.find(a => a.playSound);
      if (highAlert) playAlert('high');
    } else {
      showAlert(resp.error, 'warn');
    }
  } catch (e) {
    showAlert(e.message, 'error');
  } finally {
    setLoading('localPredBtn', false);
  }
}

// ===== 加载预测历史记录 =====
async function loadHistory() {
  const resp = await sendMsg({ type: 'GET_PRED_HISTORY' });
  const el = document.getElementById('historyContent');
  const history = resp.history || [];

  if (history.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="emoji">🕐</div><p>暂无预测记录<br>运行本地预测后自动保存</p></div>`;
    return;
  }

  let html = `<div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
    <span style="font-size:11px;color:#8b949e">${history.length} 条记录</span>
    <button class="btn btn-sm" style="background:#21262d;border:1px solid #f85149;color:#f85149" data-action="clearHistory">清除记录</button>
  </div>`;

  history.slice(0, 30).forEach(h => {
    const confClass = h.confidence >= 65 ? '' : h.confidence >= 55 ? 'medium' : 'low';
    const matchName = h.matchInfo?.home ? `${h.matchInfo.home} vs ${h.matchInfo.away}` : `ID:${h.matchId}`;
    const timeStr = new Date(h.generatedAt).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });

    html += `<div class="data-section" style="margin-bottom:8px">
      <div class="section-header" style="cursor:default">
        <span>${matchName}</span>
        <span class="confidence-badge ${confClass}" style="font-size:10px">${h.confidence}%</span>
      </div>
      <div class="section-body" style="padding:8px 12px">
        <div class="stat-row"><span class="stat-label">时间</span><span class="stat-value">${timeStr}${h.isLive ? ' 🔴滚球' : ' 赛前'}</span></div>
        <div class="stat-row"><span class="stat-label">结论</span><span class="stat-value" style="color:#58a6ff">${h.summary || '-'}</span></div>
        ${h.recommendations?.length > 0 ? `<div class="stat-row"><span class="stat-label">推荐</span><span class="stat-value" style="font-size:11px">${h.recommendations.map(r=>r.suggestion).join(' | ')}</span></div>` : ''}
        ${h.actualResult ? `<div class="stat-row"><span class="stat-label" style="color:#3fb950">实际结果</span><span class="stat-value" style="color:#3fb950">${h.actualResult}</span></div>` : ''}
        <div style="margin-top:6px;display:flex;gap:4px">
          <input type="text" placeholder="填写实际结果复盘..." id="review_${h.id}"
            style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#e6edf3;padding:3px 6px;font-size:11px"
            value="${h.actualResult || ''}">
          <button class="btn btn-sm" style="background:#238636;color:#fff" data-action="saveReview" data-id="${h.id}">保存</button>
        </div>
      </div>
    </div>`;
  });

  el.innerHTML = html;
}

// 事件委托：处理动态生成的按钮点击
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  switch (action) {
    case 'saveReview': {
      const input = document.getElementById(`review_${id}`);
      if (!input) return;
      await sendMsg({ type: 'UPDATE_REVIEW', id: Number(id), actualResult: input.value, review: '' });
      showAlert('✅ 复盘记录已保存', 'success', 2000);
      break;
    }
    case 'clearHistory': {
      if (!confirm('确定清除所有预测记录？')) return;
      await chrome.storage.local.remove('pred_history');
      loadHistory();
      break;
    }
    case 'selectMatch': {
      currentMatchId = id;
      document.getElementById('matchIdInput').value = id;
      await loadDataForMatch(id);
      switchTab('data');
      break;
    }
    case 'stopMonitor': {
      await sendMsg({ type: 'STOP_MONITOR', matchId: id });
      showAlert('已停止监控', 'info', 2000);
      await loadMonitorList();
      break;
    }
    case 'fetchLive': {
      await fetchLiveAndPredict(id);
      break;
    }
  }
});

// ===== AI 对话聊天系统 =====
let chatHistory = [];       // [{role, content}]
let chatReportMarkdown = ''; // 报告上下文（首次预测后存储）

function appendChatMsg(role, content, meta) {
  const el = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  const metaText = meta ? `<div class="chat-meta">${meta}</div>` : '';
  div.innerHTML = `<div class="chat-bubble">${escapeHtml(content)}</div>${metaText}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function appendTyping() {
  const el = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'chat-msg assistant';
  div.id = 'chatTyping';
  div.innerHTML = `<div class="chat-typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span style="margin-left:4px">AI 思考中...</span></div>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function removeTyping() {
  document.getElementById('chatTyping')?.remove();
}

async function runAIPredict() {
  const matchId = currentMatchId || getMatchId();
  if (!matchId) { showAlert('请先输入比赛ID', 'warn'); return; }
  setLoading('aiPredBtn', true);
  appendTyping();
  try {
    const resp = await sendMsg({ type: 'AI_PREDICT', matchId });
    removeTyping();
    if (resp.ok) {
      chatReportMarkdown = resp.reportMarkdown || '';
      chatHistory = [{ role: 'assistant', content: resp.prediction.content }];
      const model = resp.prediction.model || resp.prediction.provider || 'AI';
      const tokens = resp.prediction.tokens ? ` | ${resp.prediction.tokens} tokens` : '';
      appendChatMsg('assistant', resp.prediction.content, `${model}${tokens} · ${new Date().toLocaleTimeString('zh-CN')}`);
    } else if (resp.error?.includes('API Key')) {
      appendChatMsg('assistant', '⚠️ 请先在设置页面配置 AI API Key\n点击右上角 ⚙ 进行配置');
    } else {
      appendChatMsg('assistant', `❌ ${resp.error || 'AI预测失败'}`);
    }
  } catch (e) {
    removeTyping();
    appendChatMsg('assistant', `❌ ${e.message}`);
  } finally {
    setLoading('aiPredBtn', false);
  }
}

// ===== 深度预测 2.0：量化模型 + 联网情报 + AI综合裁决 =====
async function runDeepAIPredict() {
  const matchId = currentMatchId || getMatchId();
  if (!matchId) { showAlert('请先输入比赛ID', 'warn'); return; }
  setLoading('aiDeepBtn', true);
  appendChatMsg('user', '🧠 深度预测：本地量化建模 + 联网情报检索 + AI综合裁决');
  appendDeepTyping();
  try {
    const resp = await sendMsg({ type: 'AI_PREDICT_DEEP', matchId });
    removeTyping();
    if (resp.ok) {
      chatReportMarkdown = resp.reportMarkdown || '';
      // 先展示量化与情报来源摘要（让用户看到结论从何而来）
      const steps = resp.steps || {};
      const stepNote = `量化模型 ${steps.quant ? '✅' : '⚠️未生成'} · 联网情报 ${steps.intel ? '✅' : '⚠️未检索到'}`;
      if (resp.quantMarkdown) appendChatMsg('assistant', resp.quantMarkdown, '📐 本地量化参考（确定性数学，供AI参考非照抄）');
      if (resp.intel) {
        const errors = resp.intel.errors || [];
        const isQuotaExceeded = errors.some(e => e.includes('TAVILY_QUOTA_EXCEEDED'));
        const sourceLabel = resp.intel.source === 'tavily' ? '🟢 Tavily 实时搜索'
          : isQuotaExceeded ? '🔴 Tavily 额度已用完'
          : resp.intel.source === 'free' ? '⚪ 免费搜索引擎（Tavily降级）' : '❌ 未检索到情报';
        let errNote = '';
        if (isQuotaExceeded) {
          errNote = '\n\n⚠️ **内置 Tavily 额度已用完**\n请前往 [设置页面] 配置您自己的 Tavily API Key，免费注册 tavily.com 即可获得每月 1000 次免费额度，填入后立即生效。';
        } else if (errors.length) {
          errNote = `\n⚠️ ${errors.join('；')}`;
        }
        const srcLines = resp.intel.ok
          ? (resp.intel.gathered || []).slice(0, 8).map((r, i) =>
              `${i + 1}. **${r.title}**\n   摘要: ${(r.snippet || '').slice(0, 150)}\n   来源: ${r.url}`
            ).join('\n')
          : '（未获取到情报，已降级使用免费搜索引擎）';
        appendChatMsg('assistant', srcLines + errNote, `🌐 扩展端联网情报 (${sourceLabel})`);
        if (isQuotaExceeded) {
          showAlert('⚠️ Tavily 内置额度已用完，请在设置页配置自己的 API Key（tavily.com 免费注册）', 'warn', 8000);
        }
      }
      // AI 最终裁决
      chatHistory = [{ role: 'assistant', content: resp.prediction.content }];
      const model = resp.prediction.model || resp.prediction.provider || 'AI';
      const tokens = resp.prediction.tokens ? ` | ${resp.prediction.tokens} tokens` : '';
      appendChatMsg('assistant', resp.prediction.content, `🧠 ${model}${tokens} · ${stepNote} · ${new Date().toLocaleTimeString('zh-CN')}`);
    } else if (resp.error?.includes('API Key')) {
      appendChatMsg('assistant', '⚠️ 请先在设置页面配置 AI API Key\n点击右上角 ⚙ 进行配置');
    } else {
      appendChatMsg('assistant', `❌ ${resp.error || 'AI深度预测失败'}`);
    }
  } catch (e) {
    removeTyping();
    appendChatMsg('assistant', `❌ ${e.message}`);
  } finally {
    setLoading('aiDeepBtn', false);
  }
}

function appendDeepTyping() {
  const el = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'chat-msg assistant';
  div.id = 'chatTyping';
  div.innerHTML = `<div class="chat-typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span style="margin-left:4px">量化建模 → 联网检索情报 → AI综合分析中（约需20-60秒）...</span></div>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (chatHistory.length === 0 && !chatReportMarkdown) {
    showAlert('请先点击"开始AI预测分析"', 'warn'); return;
  }
  input.value = '';
  appendChatMsg('user', text);
  chatHistory.push({ role: 'user', content: text });
  appendTyping();
  document.getElementById('chatSendBtn').disabled = true;
  try {
    const resp = await sendMsg({ type: 'AI_CHAT', messages: chatHistory, reportMarkdown: chatReportMarkdown });
    removeTyping();
    if (resp.ok && resp.reply) {
      chatHistory.push({ role: 'assistant', content: resp.reply.content });
      const model = resp.reply.model || resp.reply.provider || 'AI';
      const tokens = resp.reply.tokens ? ` | ${resp.reply.tokens} tokens` : '';
      appendChatMsg('assistant', resp.reply.content, `${model}${tokens} · ${new Date().toLocaleTimeString('zh-CN')}`);
    } else {
      appendChatMsg('assistant', `❌ ${resp.error || '对话失败'}`);
      chatHistory.pop(); // 回滚
    }
  } catch (e) {
    removeTyping();
    appendChatMsg('assistant', `❌ ${e.message}`);
    chatHistory.pop();
  } finally {
    document.getElementById('chatSendBtn').disabled = false;
  }
}

function clearChat() {
  chatHistory = [];
  chatReportMarkdown = '';
  document.getElementById('chatMessages').innerHTML = '';
}

// ===== 渲染盘口数据 =====
async function renderDataPanel(data) {
  if (!data) return;
  const el = document.getElementById('dataContent');
  const { analysis, winDrawWin, asian, overunder, corner } = data;
  const home = analysis?.matchInfo?.home || '主队';
  const away = analysis?.matchInfo?.away || '客队';
  const time = analysis?.matchInfo?.time || '';

  let html = '';

  // 比赛信息
  html += `<div class="data-section">
    <div class="section-header">ℹ️ 比赛信息</div>
    <div class="section-body">
      <div class="stat-row"><span class="stat-label">对阵</span><span class="stat-value highlight">${home} vs ${away}</span></div>
      ${time ? `<div class="stat-row"><span class="stat-label">时间</span><span class="stat-value">${time}</span></div>` : ''}
      ${analysis?.matchInfo?.weather ? `<div class="stat-row"><span class="stat-label">天气</span><span class="stat-value">${analysis.matchInfo.weather} ${analysis.matchInfo.temperature || ''}</span></div>` : ''}
      <div class="stat-row"><span class="stat-label">数据更新</span><span class="stat-value">${new Date().toLocaleTimeString('zh-CN')}</span></div>
    </div>
  </div>`;

// 胜平负 / 欧赔
if (winDrawWin && !winDrawWin.error) {
  const sum = winDrawWin.summary || {};
  const companies = winDrawWin.companies || [];
  const stats = winDrawWin.statistics;
  const kellyCell = (v, risk) => risk ? `<span style="color:#f85149;font-weight:700">${v || '-'}⚠️</span>` : `${v || '-'}`;
  html += `<div class="data-section">
    <div class="section-header">
      🏆 胜平负盘口（欧赔）
      <span style="color:#a371f7;font-size:11px">公司:${sum.count || companies.length}${sum.impliedAverage ? ' | 概率 '+sum.impliedAverage.win+'/'+sum.impliedAverage.draw+'/'+sum.impliedAverage.loss : ''}${sum.averageReturnRate ? ' | 返还 '+sum.averageReturnRate : ''}</span>
    </div>
    <div class="section-body">`;

  if (sum.averageCurrent || sum.averageInitial) {
    html += `<table class="odds-table">
      <tr><th>类型</th><th>主胜</th><th>平局</th><th>客胜</th><th>返还率</th></tr>
      ${sum.averageInitial ? `<tr><td class="company">初盘平均</td><td>${sum.averageInitial.win}</td><td>${sum.averageInitial.draw}</td><td>${sum.averageInitial.loss}</td><td>-</td></tr>` : ''}
      ${sum.averageCurrent ? `<tr><td class="company">即时平均</td><td class="handicap">${sum.averageCurrent.win}</td><td class="handicap">${sum.averageCurrent.draw}</td><td class="handicap">${sum.averageCurrent.loss}</td><td>${sum.averageReturnRate || '-'}</td></tr>` : ''}
    </table>`;
  }

  if (stats?.rows?.length > 0) {
    html += `<div style="margin-top:8px;color:#8b949e;font-size:11px;margin-bottom:4px">${stats.company || '36*(英国)'}欧指统计表</div>
    <table class="odds-table"><tr><th>类型</th><th>主</th><th>平</th><th>客</th><th>返还</th><th>样本</th></tr>`;
    stats.rows.forEach(r => {
      const sample = r.total ? `${r.total}/${r.winCount || 0}/${r.drawCount || 0}/${r.lossCount || 0}` : '-';
      html += `<tr><td class="company">${r.label || r.type}</td><td>${r.win || '-'}</td><td>${r.draw || '-'}</td><td>${r.loss || '-'}</td><td>${r.returnRate || '-'}</td><td>${sample}</td></tr>`;
    });
    html += `</table>`;
    if (stats.recent30?.length > 0) html += `<div style="margin-top:6px;color:#8b949e;font-size:11px">近30场: <span style="color:#f85149">${stats.recent30.join(' ')}</span></div>`;
  }

  const top3wdw = companies.slice(0, 3);
  if (top3wdw.length > 0) {
    html += `<div style="margin-top:8px;color:#8b949e;font-size:11px;margin-bottom:4px">主要公司胜平负</div>
    <table class="odds-table">
      <tr><th>公司</th><th>初主</th><th>初平</th><th>初客</th><th>即主</th><th>即平</th><th>即客</th><th>返还</th><th>凯利</th><th>时间</th></tr>`;
    top3wdw.forEach(c => {
      const changed = c.initialWin && (c.initialWin !== c.currentWin || c.initialDraw !== c.currentDraw || c.initialLoss !== c.currentLoss);
      const kelly = c.kelly ? `${kellyCell(c.kelly.win, c.kellyRisk?.win)}/${kellyCell(c.kelly.draw, c.kellyRisk?.draw)}/${kellyCell(c.kelly.loss, c.kellyRisk?.loss)}` : '-';
      const timeStyle = c.recent30 ? 'color:#f85149;font-weight:700' : '';
      html += `<tr>
        <td class="company">${c.name}</td>
        <td>${c.initialWin || '-'}</td><td>${c.initialDraw || '-'}</td><td>${c.initialLoss || '-'}</td>
        <td class="handicap${changed?' changed':''}">${c.currentWin || '-'}${changed?'⚠️':''}</td><td>${c.currentDraw || '-'}</td><td>${c.currentLoss || '-'}</td>
        <td>${c.currentReturnRate || c.returnRate || '-'}</td><td>${kelly}</td><td style="${timeStyle}">${c.changeTime || '-'}</td>
      </tr>`;
    });
    html += `</table>`;
  }

  if (companies.length > 3) {
    html += `<div style="margin-top:8px;color:#8b949e;font-size:11px;margin-bottom:4px">所有公司即时胜平负（${companies.length}家）</div>
    <table class="odds-table"><tr><th>公司</th><th>主胜</th><th>平局</th><th>客胜</th><th>返还</th><th>概率</th></tr>`;
    companies.forEach(c => {
      const prob = c.currentProbabilities ? `${c.currentProbabilities.win}/${c.currentProbabilities.draw}/${c.currentProbabilities.loss}` : '-';
      html += `<tr><td class="company" style="font-size:10px">${c.name}</td><td>${c.currentWin || '-'}</td><td>${c.currentDraw || '-'}</td><td>${c.currentLoss || '-'}</td><td>${c.currentReturnRate || c.returnRate || '-'}</td><td>${prob}</td></tr>`;
    });
    html += `</table>`;
  }
  html += `</div></div>`;
}

// 亚让盘
if (asian && !asian.error) {
  const sum = asian.summary || {};
  const companies = asian.companies || [];
  html += `<div class="data-section">
    <div class="section-header">
      🎯 亚让盘口
      <span style="color:#3fb950;font-size:11px">升↑${sum.up||0} 降↓${sum.down||0} | 高水:${sum.highWater||0} 低水:${sum.lowWater||0}${sum.mainLine ? ' | 主流:'+sum.mainLine : ''}</span>
    </div>
    <div class="section-body">`;

  // 主要公司展示（前3家完整，其余简略）
  const top3 = companies.slice(0, 3);
  if (top3.length > 0) {
    html += `<table class="odds-table">
      <tr><th>公司</th><th>初主水</th><th>初盘口</th><th>初客水</th><th>即主水</th><th>即盘口</th><th>即客水</th></tr>`;
    top3.forEach(c => {
      const ml = c.mainLine || c;
      const changed = ml.initialHandicap !== ml.currentHandicap;
      html += `<tr>
        <td class="company">${c.name}</td>
        <td>${ml.initialHome}</td><td class="handicap">${ml.initialHandicap}</td><td>${ml.initialAway}</td>
        <td>${ml.currentHome}</td><td class="handicap${changed?' changed':''}">${ml.currentHandicap}${changed?'⚠️':''}</td><td>${ml.currentAway}</td>
      </tr>`;
    });
    html += `</table>`;
  }

  // 所有公司即时盘简表
  if (companies.length > 3) {
    html += `<div style="margin-top:8px;color:#8b949e;font-size:11px;margin-bottom:4px">所有公司即时盘口（${companies.length}家）</div>
    <table class="odds-table">
      <tr><th>公司</th><th>主队水</th><th>盘口</th><th>客队水</th></tr>`;
    companies.forEach(c => {
      const ml = c.mainLine || c;
      html += `<tr><td class="company" style="font-size:10px">${c.name}</td><td>${ml.currentHome}</td><td class="handicap">${ml.currentHandicap}</td><td>${ml.currentAway}</td></tr>`;
    });
    html += `</table>`;
  }
  html += `</div></div>`;
}

// 大小球
if (overunder && !overunder.error) {
  const sum = overunder.summary || {};
  const companies = overunder.companies || [];
  html += `<div class="data-section">
    <div class="section-header">
      ⚽ 大小球（进球数）
      <span style="color:#d29922;font-size:11px">升↑${sum.up||0} 降↓${sum.down||0}${sum.mainLine ? ' | 主流:'+sum.mainLine : ''}</span>
    </div>
    <div class="section-body">`;

  const top3ou = companies.slice(0, 3);
  if (top3ou.length > 0) {
    html += `<table class="odds-table">
      <tr><th>公司</th><th>初大水</th><th>初线</th><th>初小水</th><th>即大水</th><th>即线</th><th>即小水</th></tr>`;
    top3ou.forEach(c => {
      const ml = c.mainLine || c;
      const changed = ml.initialLine !== ml.currentLine;
      html += `<tr>
        <td class="company">${c.name}</td>
        <td>${ml.initialOver}</td><td class="handicap">${ml.initialLine}</td><td>${ml.initialUnder}</td>
        <td>${ml.currentOver}</td><td class="handicap${changed?' changed':''}">${ml.currentLine}${changed?'⚠️':''}</td><td>${ml.currentUnder}</td>
      </tr>`;
    });
    html += `</table>`;
  }
  if (companies.length > 3) {
    html += `<div style="margin-top:8px;color:#8b949e;font-size:11px;margin-bottom:4px">所有公司（${companies.length}家）</div>
    <table class="odds-table"><tr><th>公司</th><th>大水</th><th>线</th><th>小水</th></tr>`;
    companies.forEach(c => {
      const ml = c.mainLine || c;
      html += `<tr><td class="company" style="font-size:10px">${c.name}</td><td>${ml.currentOver}</td><td class="handicap">${ml.currentLine}</td><td>${ml.currentUnder}</td></tr>`;
    });
    html += `</table>`;
  }
  html += `</div></div>`;
}

  // 角球
  if (corner && !corner.error && (corner.companies?.length > 0 || corner.mainLine)) {
    const companies = corner.companies || [];
    html += `<div class="data-section">
      <div class="section-header">🔢 角球盘口</div>
      <div class="section-body">`;
    if (companies.length > 0) {
      html += `<table class="odds-table">
        <tr><th>公司</th><th>初大水</th><th>初线</th><th>初小水</th><th>即大水</th><th>即线</th><th>即小水</th></tr>`;
      companies.slice(0, 5).forEach(c => {
        const changed = c.initialLine !== c.currentLine;
        html += `<tr>
          <td class="company">${c.name}</td>
          <td>${c.initialOver || '-'}</td><td class="handicap">${c.initialLine || '-'}</td><td>${c.initialUnder || '-'}</td>
          <td>${c.currentOver || '-'}</td><td class="handicap${changed?' changed':''}">${c.currentLine || '-'}${changed?'⚠️':''}</td><td>${c.currentUnder || '-'}</td>
        </tr>`;
      });
      html += `</table>`;
    } else {
      html += `<div class="stat-row"><span class="stat-label">主流角球线</span><span class="stat-value highlight">${corner.mainLine} 个</span></div>
        ${corner.mainOver ? `<div class="stat-row"><span class="stat-label">大角球水位</span><span class="stat-value">${corner.mainOver}</span></div>` : ''}
        ${corner.mainUnder ? `<div class="stat-row"><span class="stat-label">小角球水位</span><span class="stat-value">${corner.mainUnder}</span></div>` : ''}`;
    }
    html += `</div></div>`;
  }

  // 战绩
  if (analysis?.homeStats?.total || analysis?.awayStats?.total) {
    html += `<div class="data-section">
      <div class="section-header">📈 联赛战绩</div>
      <div class="section-body">`;
    if (analysis.homeStats?.total) {
      const t = analysis.homeStats.total;
      html += `<div style="color:#58a6ff;font-size:11px;margin-bottom:6px;font-weight:600">🏠 ${home}</div>
        <div class="stat-row"><span class="stat-label">全场战绩</span><span class="stat-value">${t.played}场 ${t.win}胜${t.draw}平${t.loss}负</span></div>
        <div class="stat-row"><span class="stat-label">胜率/排名</span><span class="stat-value">${t.winRate} / 第${t.rank}名</span></div>`;
    }
    if (analysis.awayStats?.total) {
      const t = analysis.awayStats.total;
      html += `<div style="color:#f0883e;font-size:11px;margin:8px 0 6px;font-weight:600">✈️ ${away}</div>
        <div class="stat-row"><span class="stat-label">全场战绩</span><span class="stat-value">${t.played}场 ${t.win}胜${t.draw}平${t.loss}负</span></div>
        <div class="stat-row"><span class="stat-label">胜率/排名</span><span class="stat-value">${t.winRate} / 第${t.rank}名</span></div>`;
    }
    html += `</div></div>`;
  }

  el.innerHTML = html;
}

// ===== 渲染本地预测 =====
function renderLocalPrediction(pred) {
  if (!pred || pred.error) {
    document.getElementById('localPredContent').innerHTML = `<div class="alert alert-warn">${pred?.error || '预测失败'}</div>`;
    return;
  }

  const conf = pred.confidence;
  const confClass = conf >= 65 ? '' : conf >= 55 ? 'medium' : 'low';

  let html = '';

  // 警报提示
  if (pred.alerts?.length > 0) {
    pred.alerts.forEach(a => {
      const alertType = a.level === 'high' ? 'success' : 'warn';
      html += `<div class="alert alert-${alertType}" style="margin-bottom:8px">${a.level === 'high' ? '⚡ ' : '⚠️ '}${a.msg}</div>`;
    });
  }

  html += `<div class="pred-card">
    <div class="pred-header">
      <div class="pred-title">🤖 ${pred.isLive ? '🔴 滚球预测' : '赛前预测'}</div>
      <div class="confidence-badge ${confClass}">信心 ${conf}%</div>
    </div>
    <div class="alert alert-info" style="margin-bottom:10px">${pred.summary || '分析完成'}</div>`;

  // 赛前推荐
  if (pred.recommendations?.length > 0) {
    html += `<ul class="rec-list">`;
    pred.recommendations.forEach(rec => {
      const marketClass = rec.market?.includes('大小') ? 'ou' : rec.market?.includes('角') ? 'corner' : '';
      html += `<li class="rec-item">
        <span class="rec-market ${marketClass}">${rec.market || rec.type || '推荐'}</span>
        <div class="rec-content">
          <div>${rec.suggestion}</div>
          ${rec.line ? `<div class="rec-hint">盘口: ${rec.line}${rec.homePay ? ` | 主水:${rec.homePay} 客水:${rec.awayPay}` : ''}</div>` : ''}
        </div>
      </li>`;
    });
    html += `</ul>`;
  }
  html += `</div>`;

  // 滚球实时推荐
  if (pred.isLive && pred.liveRecommendations?.length > 0) {
    html += `<div class="data-section">
      <div class="section-header" style="color:#f85149">🔴 滚球实时建议</div>
      <div class="section-body"><div class="signal-list">`;
    pred.liveRecommendations.forEach(r => {
      const alertClass = r.alert ? 'positive' : 'neutral';
      html += `<div class="signal-item" style="${r.alert ? 'background:#1a2d1a' : ''}">
        <div class="signal-dot ${alertClass}"></div>
        <span style="color:#8b949e;margin-right:4px">${r.timing}</span>
        ${r.suggestion}
        ${r.confidence ? `<span style="color:#484f58;font-size:10px;margin-left:4px">(${r.confidence}%)</span>` : ''}
      </div>`;
    });
    html += `</div></div></div>`;
  }

  // 盘口信号分析
  if (pred.analysis) {
    const allSignals = [
      ...(pred.analysis.asian?.signals || []),
      ...(pred.analysis.overunder?.signals || [])
    ];
    if (allSignals.length > 0) {
      html += `<div class="data-section">
        <div class="section-header">🔍 盘口信号</div>
        <div class="section-body"><div class="signal-list">`;
      allSignals.forEach(s => {
        const dotClass = s.weight > 0 ? 'positive' : s.weight < 0 ? 'negative' : 'neutral';
        html += `<div class="signal-item"><div class="signal-dot ${dotClass}"></div>${s.desc}</div>`;
      });
      html += `</div></div></div>`;
    }
  }

  // 统计信息
  if (pred.analysis?.stats?.valid) {
    const s = pred.analysis.stats;
    html += `<div class="data-section">
      <div class="section-header">📈 战绩对比</div>
      <div class="section-body">`;
    if (s.homeWinRate) html += `<div class="stat-row"><span class="stat-label">主队胜率</span><span class="stat-value">${s.homeWinRate} | 近6场: ${s.homeForm || '-'}</span></div>`;
    if (s.awayWinRate) html += `<div class="stat-row"><span class="stat-label">客队胜率</span><span class="stat-value">${s.awayWinRate} | 近6场: ${s.awayForm || '-'}</span></div>`;
    if (s.homeInjuries || s.awayInjuries) html += `<div class="stat-row"><span class="stat-label">伤停</span><span class="stat-value">主队${s.homeInjuries}人 / 客队${s.awayInjuries}人</span></div>`;
    html += `</div></div>`;
  }

  document.getElementById('localPredContent').innerHTML = html;
}

// ===== 生成报告 =====
async function generateAndShowReport() {
  if (!currentMatchId) return;
  const resp = await sendMsg({ type: 'GET_REPORT', matchId: currentMatchId });
  if (resp.ok && resp.report) {
    currentReport = resp.report;
    document.getElementById('reportContent').innerHTML = `
      <div class="ai-output" style="font-size:11px">${escapeHtml(resp.report.markdown)}</div>`;
  }
}

// ===== 监控列表 =====
async function loadMonitorList() {
  const resp = await sendMsg({ type: 'LIST_MONITORS' });
  const el = document.getElementById('monitorList');
  if (!resp.ok || resp.tasks.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="emoji">📡</div><p>暂无监控任务<br>输入比赛ID并点击"监控"开始</p></div>`;
    return;
  }

  let html = '';
  for (const matchId of resp.tasks) {
    const dataResp = await sendMsg({ type: 'GET_STORED_DATA', matchId });
    const matchInfo = dataResp?.data?.data?.analysis?.matchInfo || {};
    const home = matchInfo.home || matchId;
    const away = matchInfo.away || '';
    const fetchTime = dataResp?.data?.fetchTime ? new Date(dataResp.data.fetchTime).toLocaleTimeString('zh-CN') : '未知';

    html += `<div class="monitor-item" data-id="${matchId}">
      <div class="monitor-info">
        <div class="monitor-title">${home}${away ? ` vs ${away}` : ''} <span class="monitor-badge">监控中</span></div>
        <div class="monitor-meta">ID: ${matchId} | 最后更新: ${fetchTime}</div>
      </div>
      <div class="monitor-actions">
        <button class="btn btn-blue btn-sm" data-action="selectMatch" data-id="${matchId}">查看</button>
        <button class="btn btn-sm" style="background:#2d1a1a;border:1px solid #f85149;color:#f85149;padding:4px 6px" data-action="fetchLive" data-id="${matchId}">🔴 滚球</button>
        <button class="btn btn-sm" style="background:#2d1a1a;border:1px solid #f85149;color:#f85149" data-action="stopMonitor" data-id="${matchId}">停止</button>
      </div>
    </div>`;
  }
  el.innerHTML = html;
}

// ===== 工具函数 =====
function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp || {});
    });
  });
}

function showAlert(msg, type = 'info', duration = 3000) {
  const area = document.getElementById('alertArea');
  const el = document.createElement('div');
  el.className = `alert alert-${type}`;
  el.style.cssText = 'margin: 0 16px 0; font-size:12px;';
  el.textContent = msg;
  area.innerHTML = '';
  area.appendChild(el);
  if (duration > 0) setTimeout(() => el.remove(), duration);
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  if (loading) btn.dataset.origText = btn.textContent;
  btn.textContent = loading ? '⏳ 处理中...' : (btn.dataset.origText || btn.textContent);
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `tab-${tabName}`);
  });
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showAlert('✅ 已复制到剪贴板', 'success', 2000);
  }).catch(() => {
    // 降级方案
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showAlert('✅ 已复制', 'success', 2000);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =============================================
// 今日赛事分析
// =============================================

let todayMatchItems = []; // { match, matchData, profitability }
let batchAIResult = null; // AI批量分析结果

let collectAborted = false; // 停止采集标志

// 加载今日比赛列表（只获取赛事/队名，不采集盘口）
async function fetchTodayMatches() {
  setLoading('fetchTodayBtn', true);
  showAlert('正在加载今日比赛列表，需等待约15-30秒...', 'info', 30000);
  try {
    const resp = await sendMsg({ type: 'FETCH_TODAY_MATCHES' });
    if (!resp.ok || !resp.matches?.length) {
      showAlert('未获取到今日比赛。提示：请确保已登录球探网，或手动打开 live.titan007.com 后重试', 'warn', 8000);
      return;
    }
    const allMatches = resp.matches;
    todayMatchItems = allMatches.map(m => ({ match: m, matchData: null, profitability: null, checked: false }));

    // 从服务器加载已有盘口数据
    let serverLoadedCount = 0;
    try {
      const pubResp = await sendMsg({ type: 'LOAD_PUBLIC_MATCH_LIST' });
      if (pubResp?.ok && pubResp.serverEnabled && pubResp.matchIds?.length) {
        const serverIdSet = new Set(pubResp.matchIds.map(String));
        for (const item of todayMatchItems) {
          if (serverIdSet.has(String(item.match.id))) {
            const loadResp = await sendMsg({ type: 'FETCH_MATCH_QUICK_DATA', matchId: item.match.id, preferServer: true });
            if (loadResp?.ok && loadResp.data) {
              item.matchData = loadResp.data;
              item.profitability = loadResp.profitability;
              serverLoadedCount++;
            }
          }
        }
      }
    } catch (e) {}

    showAlert(`✅ 已加载 ${allMatches.length} 场比赛${serverLoadedCount > 0 ? `，☁️ 服务器已有 ${serverLoadedCount} 场数据` : ''}`, 'success', 4000);
    renderDailyList();
    switchTab('daily');
    // 显示操作按钮
    document.getElementById('collectAllBtn').style.display = 'inline-flex';
    document.getElementById('collectSelectedBtn').style.display = 'inline-flex';
    document.getElementById('selectAllBtn').style.display = 'inline-flex';
    document.getElementById('invertSelectBtn').style.display = 'inline-flex';
    document.getElementById('batchAIBtn').disabled = false;
  } catch (e) {
    showAlert(`加载失败: ${e.message}`, 'error');
  } finally {
    setLoading('fetchTodayBtn', false);
  }
}

// 全部采集（对所有未采集的比赛采集盘口数据）
async function collectAll() {
  const targets = todayMatchItems.filter(it => !it.matchData &&
    it.match.status !== 'finished' && !(it.match.score && /^\d+[-:]\d+$/.test(it.match.score.trim())));
  if (!targets.length) { showAlert('所有比赛已采集或已结束', 'info'); return; }
  collectAborted = false;
  document.getElementById('stopCollectBtn').style.display = 'inline-flex';
  document.getElementById('collectAllBtn').disabled = true;
  showAlert(`正在采集全部 ${targets.length} 场比赛盘口数据...`, 'info', 60000);
  let doneCount = 0;
  for (let i = 0; i < targets.length; i++) {
    if (collectAborted) break;
    const item = targets[i];
    try {
      const dataResp = await sendMsg({ type: 'FETCH_MATCH_QUICK_DATA', matchId: item.match.id, league: item.match.league, home: item.match.home, away: item.match.away, matchTime: item.match.time });
      if (dataResp.ok) {
        item.matchData = dataResp.data;
        item.profitability = dataResp.profitability;
        doneCount++;
      }
    } catch (e) {}
    if (i % 5 === 4 || i === targets.length - 1) renderDailyList();
    if (i % 2 === 1) await new Promise(r => setTimeout(r, 800));
  }
  document.getElementById('stopCollectBtn').style.display = 'none';
  document.getElementById('collectAllBtn').disabled = false;
  showAlert(collectAborted ? `⏹ 已停止，完成 ${doneCount} 场` : `✅ 全部采集完成：${doneCount} 场`, 'success', 4000);
  collectAborted = false;
}

// 全选
function selectAll() {
  todayMatchItems.forEach(it => it.checked = true);
  renderDailyList();
}

// 反选
function invertSelect() {
  todayMatchItems.forEach(it => it.checked = !it.checked);
  renderDailyList();
}

async function collectSelected() {
  const selected = todayMatchItems.filter(it => it.checked);
  if (!selected.length) { showAlert('请先勾选要采集的比赛', 'warn'); return; }
  collectAborted = false;
  document.getElementById('stopCollectBtn').style.display = 'inline-flex';
  document.getElementById('collectSelectedBtn').disabled = true;
  showAlert(`正在采集选中的 ${selected.length} 场比赛...`, 'info');
  let doneCount = 0;
  for (let i = 0; i < selected.length; i++) {
    if (collectAborted) break;
    const item = selected[i];
    try {
      const dataResp = await sendMsg({ type: 'FETCH_MATCH_QUICK_DATA', matchId: item.match.id, league: item.match.league, home: item.match.home, away: item.match.away, matchTime: item.match.time });
      if (dataResp.ok) {
        item.matchData = dataResp.data;
        item.profitability = dataResp.profitability;
        doneCount++;
      }
    } catch (e) {}
    renderDailyList();
    if (i % 2 === 1) await new Promise(r => setTimeout(r, 800));
  }
  document.getElementById('batchAIBtn').disabled = false;
  document.getElementById('collectSelectedBtn').disabled = false;
  document.getElementById('stopCollectBtn').style.display = 'none';
  showAlert(collectAborted ? `⏹ 已停止，完成 ${doneCount} 场` : `✅ 选中 ${doneCount} 场采集完成`, 'success', 3000);
  collectAborted = false;
}

function renderDailyList() {
  const el = document.getElementById('dailyMatchList');
  const filterTier = document.getElementById('dailyFilterTier').value;
  let items = todayMatchItems;
  if (filterTier) items = items.filter(it => it.match.leagueTier === filterTier);

  if (!items.length) {
    el.innerHTML = `<div class="empty-state"><div class="emoji">📅</div>
      <p style="line-height:1.8">暂无今日比赛数据<br>
      <span style="color:#8b949e;font-size:11px">① 点击"今日比赛"采集当天比赛列表<br>
      ② 勾选感兴趣的比赛，点"采集选中"获取盘口数据<br>
      ③ 勾选已采集的比赛，点"AI批量预测"获取AI分析</span></p></div>`;
    return;
  }

  // 排序：已勾选+已采集 > 已采集未勾选 > 其余；同组内按联赛优先级+价值评分
  items = [...items].sort((a, b) => {
    const rankA = (a.checked ? 2 : 0) + (a.matchData ? 1 : 0);
    const rankB = (b.checked ? 2 : 0) + (b.matchData ? 1 : 0);
    if (rankB !== rankA) return rankB - rankA;
    const pa = (b.match.leaguePriority || 0) * 10 + (b.profitability?.score || 0);
    const pb = (a.match.leaguePriority || 0) * 10 + (a.profitability?.score || 0);
    return pa - pb;
  });

  const tierColors = { '顶级赛事': '#f85149', '五大联赛': '#f0883e', '热门联赛': '#3fb950', '其他': '#8b949e' };
  let html = `<div style="font-size:11px;color:#8b949e;margin-bottom:6px">共 ${items.length} 场 | 按联赛热门度+价值排序</div>`;

  items.forEach((item, idx) => {
    const m = item.match;
    const prof = item.profitability;
    const tierColor = tierColors[m.leagueTier] || '#8b949e';
    const scoreColor = prof?.score >= 65 ? '#3fb950' : prof?.score >= 45 ? '#f0883e' : '#8b949e';
    const isFinished = m.status === 'finished' || (m.score && /^\d+[-:]\d+$/.test(m.score.trim()));
    const collectingLabel = !item.matchData
      ? (isFinished
          ? '<span class="pill-text" style="color:#484f58;font-size:10px;background:#21262d;padding:1px 5px;border-radius:3px">已结束</span>'
          : '<span class="pill-text" style="color:#484f58;font-size:10px">未采集</span>')
      : '';
    const checked = item.checked ? 'checked' : '';
    const rowBg = isFinished ? 'background:#0d1117;opacity:0.55;' : '';

    html += `<div class="data-section" style="margin-bottom:6px;${rowBg}" data-match-id="${m.id}">
      <div class="section-header daily-row" style="cursor:default;padding:6px 8px">
        <div class="daily-main">
          <input type="checkbox" class="daily-check" data-id="${m.id}" ${checked} ${isFinished ? 'disabled title="比赛已结束，无需采集"' : ''} style="accent-color:#58a6ff;cursor:${isFinished?'not-allowed':'pointer'};flex-shrink:0">
          <span class="pill-text" style="color:${tierColor};font-size:10px;background:${tierColor}22;padding:1px 5px;border-radius:3px">${escapeHtml(m.leagueTier)}</span>
          <span class="pill-text" style="color:#484f58;font-size:9px;font-family:monospace;letter-spacing:0.3px">ID:${escapeHtml(m.id)}</span>
          <span class="clip-text" style="font-size:11px;color:#8b949e;max-width:76px" title="${escapeHtml(m.league)}">${escapeHtml(m.league)}</span>
          <span class="clip-text" style="font-weight:600;font-size:12px;color:#e6edf3;flex:1 1 160px" title="${escapeHtml(m.home)} vs ${escapeHtml(m.away)}">${escapeHtml(m.home)} vs ${escapeHtml(m.away)}</span>
          ${m.time ? `<span class="pill-text" style="color:#484f58;font-size:10px">${escapeHtml(m.time)}</span>` : ''}
          ${m.score ? `<span class="pill-text" style="color:#f0883e;font-weight:700;font-size:12px">${escapeHtml(m.score)}</span>` : ''}
        </div>
        <div class="daily-actions">
          ${prof ? `<span class="pill-text" style="color:${scoreColor};font-size:11px;font-weight:700">${prof.score}分</span>` : collectingLabel}
          <button class="btn btn-sm" style="background:#1f6feb22;border:1px solid #1f6feb;color:#58a6ff;font-size:10px" data-action="dailyViewMatch" data-id="${m.id}">盘口</button>
          <button class="btn btn-sm" style="background:#23863622;border:1px solid #238636;color:#3fb950;font-size:10px" data-action="dailyStartMonitor" data-id="${m.id}" data-home="${escapeHtml(m.home)}" data-away="${escapeHtml(m.away)}">监控</button>
        </div>
      </div>`;

    if (prof?.signals?.length > 0 || item.matchData) {
      html += `<div class="section-body" style="padding:6px 10px">`;
      // 盘口摘要
      if (item.matchData) {
        const { winDrawWin, asian, overunder } = item.matchData;
        const parts = [];
        if (winDrawWin?.summary?.averageCurrent) {
          const s = winDrawWin.summary.averageCurrent;
          parts.push(`欧赔 主${s.win}/平${s.draw}/客${s.loss}`);
        }
        if (asian?.keyOdds?.ao) {
          const ao = asian.keyOdds.ao;
          parts.push(`亚盘 ${ao.currentHandicap ?? ao.initialHandicap} 主水${ao.currentHomePay ?? ao.initialHomePay}`);
        }
        if (overunder?.keyOdds?.ao) {
          const ao = overunder.keyOdds.ao;
          parts.push(`大小 ${ao.currentLine ?? ao.initialLine}`);
        }
        if (parts.length) html += `<div style="font-size:11px;color:#8b949e;margin-bottom:4px">${parts.join(' | ')}</div>`;
      }
      if (prof?.recommendation) {
        const recColor = prof.recommendation === '强烈推荐' ? '#3fb950' : prof.recommendation === '推荐' ? '#58a6ff' : '#8b949e';
        html += `<div style="font-size:11px;color:${recColor};font-weight:600">初步判断: ${prof.recommendation}</div>`;
      }
      html += `</div>`;
    }

    // AI详细分析结果（单场详细）
    if (item.aiResult?.content) {
      const shortContent = item.aiResult.content.length > 300
        ? item.aiResult.content.slice(0, 300) + '...'
        : item.aiResult.content;
      html += `<div style="padding:6px 10px 8px;border-top:1px solid #21262d">
        <div style="font-size:10px;color:#58a6ff;font-weight:600;margin-bottom:4px">🤖 AI详细分析</div>
        <div style="font-size:11px;color:#d29922;white-space:pre-wrap;line-height:1.5">${escapeHtml(shortContent)}</div>
        ${item.aiResult.content.length > 300 ? `<button class="btn btn-sm" style="margin-top:4px;font-size:10px;background:#21262d;border:1px solid #30363d;color:#8b949e" data-action="showFullAI" data-id="${m.id}">展开全文</button>` : ''}
      </div>`;
    } else if (batchAIResult?.advices) {
      // 兼容旧批量结果
      const adv = batchAIResult.advices.find(a => a.matchId === m.id);
      if (adv && adv.rawLine) {
        html += `<div style="padding:4px 10px 6px;border-top:1px solid #21262d;font-size:11px;color:#d29922">🤖 AI: ${escapeHtml(adv.rawLine)}</div>`;
      }
    }

    html += `</div>`;
  });

  el.innerHTML = html;
}

async function runBatchAI() {
  if (!todayMatchItems.length) { showAlert('请先采集今日比赛', 'warn'); return; }

  // 仅分析勾选的且已有盘口数据的比赛
  const targetItems = todayMatchItems.filter(it => it.checked && it.matchData);
  if (!targetItems.length) {
    showAlert('请先勾选已采集盘口数据的比赛（无数据场次请先采集）', 'warn');
    return;
  }

  // 提前检查 API Key 配置
  const settingsCheck = await chrome.storage.sync.get(['aiProvider', 'aiApiKey']);
  if (!settingsCheck.aiApiKey && (settingsCheck.aiProvider || 'openai') !== 'custom') {
    showAlert('⚠️ 请先在右上角 ⚙ 设置页面配置 AI API Key，否则无法进行AI分析', 'error', 8000);
    return;
  }

  setLoading('batchAIBtn', true);
  collectAborted = false;
  document.getElementById('stopCollectBtn').style.display = 'inline-flex';
  showAlert(`正在逐场详细AI分析 ${targetItems.length} 场比赛，请稍候...`, 'info', 60000);

  const today = new Date().toLocaleDateString('zh-CN');
  const allAdvices = [];
  let allContent = '';
  let doneCount = 0;
  let officialBetSaveCount = 0;
  let privateBetSaveCount = 0;

  try {
    for (let i = 0; i < targetItems.length; i++) {
      if (collectAborted) break;
      const item = targetItems[i];
      const m = item.match;

      showAlert(`🤖 正在分析 (${i+1}/${targetItems.length}): ${m.home} vs ${m.away}...`, 'info', 20000);
      try {
        const resp = await sendMsg({
          type: 'AI_DAILY_SINGLE',
          matchId: m.id,
          matchData: item.matchData,
          matchInfo: { home: m.home, away: m.away, league: m.league, time: m.time },
          deep: true   // 2.0：批量也走深度编排（量化+联网情报+AI裁决）
        });
        if (resp.ok && resp.prediction?.content) {
          item.aiResult = { content: resp.prediction.content, reportMarkdown: resp.reportMarkdown };
          allContent += `\n\n---\n### ${m.home} vs ${m.away}（${m.league}）\n${resp.prediction.content}`;
          allAdvices.push({ matchId: m.id, rawLine: resp.prediction.content.slice(0, 200), content: resp.prediction.content });
          // 解析高价值/中高价值投注建议
          const betRecs = parseBetAdvicesFromAI(resp.prediction.content, m, m.id, today);
          if (betRecs.length) {
            const saveResp = await sendMsg({ type: 'SAVE_BET_RECORDS', betRecords: betRecs });
            if (saveResp?.savedPrivate) privateBetSaveCount += betRecs.length;
            else officialBetSaveCount += betRecs.length;
            console.log(`[Bet] ${m.home}vs${m.away} 提取到 ${betRecs.length} 条高价值建议`, saveResp?.message || '');
          }
          doneCount++;
        } else if (resp.error) {
          // 显示具体失败原因（包含API Key未配置等）
          const errMsg = resp.error.includes('API Key')
            ? `❌ AI未配置：请在 ⚙ 设置页配置API Key后重试`
            : `❌ ${m.home} vs ${m.away} 分析失败: ${resp.error}`;
          item.aiResult = { content: errMsg };
          showAlert(errMsg, 'error', 6000);
        }
      } catch (e) {
        const errMsg = `❌ ${m.home} vs ${m.away} 分析出错: ${e.message}`;
        item.aiResult = { content: errMsg };
        console.warn(`[AI] 分析 ${m.id} 失败:`, e.message);
      }

      renderDailyList();
      // AI分析间隔1秒避免速率限制
      await new Promise(r => setTimeout(r, 1000));
    }

    batchAIResult = { content: allContent, advices: allAdvices };

    // 持久化保存
    await sendMsg({
      type: 'SAVE_DAILY_AI_RESULT',
      date: today,
      matches: todayMatchItems.map(it => ({ ...it.match, profitabilityScore: it.profitability?.score })),
      aiContent: allContent,
      aiAdvices: allAdvices
    });

    renderDailyList();
    // 自动刷新战绩Tab数据
    await loadDailyRecords();
    const saveNote = privateBetSaveCount > 0
      ? `，${privateBetSaveCount} 条推荐已保存为本地私有记录（不进入官方战绩）`
      : officialBetSaveCount > 0
        ? `，${officialBetSaveCount} 条推荐已发布到官方战绩`
        : '';
    showAlert(collectAborted
      ? `⏹ 已停止，完成 ${doneCount} 场AI分析${saveNote}`
      : `✅ ${doneCount} 场AI详细分析完成${saveNote}`, 'success', 6000);
  } catch (e) {
    showAlert(`AI分析出错: ${e.message}`, 'error');
  } finally {
    setLoading('batchAIBtn', false);
    document.getElementById('stopCollectBtn').style.display = 'none';
    collectAborted = false;
  }
}

// =============================================
// 投注记录解析和战绩管理
// =============================================

/**
 * 从 AI 回复中解析结构化投注建议
 * 支持 |盘口|选项|赔率区间|价值评级|仓位| 格式
 */
function parseBetAdvicesFromAI(aiContent, matchInfo, matchId, date) {
  const records = [];
  if (!aiContent) return records;

  // 匹配竖线分隔的表格行，至少4列
  const lines = aiContent.split('\n');
  lines.forEach(line => {
    line = line.trim();
    if (!line.startsWith('|') || line.match(/^[|\s-]+$/)) return; // 跳过分隔行和空行
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 4) return;

    // 识别价值列（第4列或含"价值"关键词的列）
    const valueText = cols[3] || '';
    const isHighValue = /高价值|中高价值/.test(valueText);
    if (!isHighValue) return;

    const betType = cols[0] || ''; // 全场亚盘/大小球/角球等
    const selection = cols[1] || ''; // 选项：主队+0.25等
    const odds = cols[2] || ''; // 赔率区间
    const valueLevel = valueText;
    const position = cols[4] || '';

    if (!betType || !selection) return;

    const id = `${matchId}_${betType}_${selection}_${date}`.replace(/\s+/g, '');
    records.push({
      id,
      date,
      matchId,
      matchHome: matchInfo?.home || '',
      matchAway: matchInfo?.away || '',
      matchLeague: matchInfo?.league || '',
      matchTime: matchInfo?.time || '',
      betType,
      selection,
      odds,
      valueLevel,
      position,
      betResult: '',    // ✓ 命中 / ✗ 未中 / 空
      actualScore: '',
      createdAt: Date.now()
    });
  });
  return records;
}

let allBetRecords = [];
let betRecordsMeta = {
  publicSyncEnabled: false,
  canManageOfficialRecords: true,
  isAdmin: true,
  mode: 'local',
  offline: false,
  error: ''
};

async function loadDailyRecords() {
  const modeSwitch = document.getElementById('recordsModeSwitch');
  const forceLocal = modeSwitch ? modeSwitch.value === 'local' : false;
  const resp = await sendMsg({ type: 'GET_BET_RECORDS', forceLocal });
  allBetRecords = resp.records || [];
  betRecordsMeta = {
    publicSyncEnabled: !!resp.publicSyncEnabled,
    canManageOfficialRecords: resp.canManageOfficialRecords !== false,
    isAdmin: resp.isAdmin !== false,
    mode: resp.mode || (resp.publicSyncEnabled ? 'official' : 'local'),
    offline: !!resp.offline,
    error: resp.error || ''
  };

  // 更新日期筛选器
  const dateFilter = document.getElementById('recordsDateFilter');
  const dates = [...new Set(allBetRecords.map(r => r.date))].sort().reverse();
  dateFilter.innerHTML = `<option value="">全部日期</option>` +
    dates.map(d => `<option value="${d}">${d}</option>`).join('');

  renderDailyRecords();
}

function renderDailyRecords() {
  const el = document.getElementById('dailyRecordsList');
  const statsEl = document.getElementById('recordsStats');
  const dateFilter = document.getElementById('recordsDateFilter').value;
  const resultFilter = document.getElementById('recordsResultFilter').value;
  const canManage = betRecordsMeta.canManageOfficialRecords !== false;
  const isOfficialMode = betRecordsMeta.publicSyncEnabled;
  const modeText = isOfficialMode
    ? (canManage ? '官方战绩 · 管理员可维护' : '官方战绩 · 普通用户只读')
    : '本地兼容模式';
  const verifyAllBtn = document.getElementById('verifyAllBtn');
  if (verifyAllBtn) {
    verifyAllBtn.disabled = !canManage;
    verifyAllBtn.title = canManage ? '自动验证所有待验证官方记录' : '普通用户只能查看官方战绩';
  }

  let records = allBetRecords;
  if (dateFilter) records = records.filter(r => r.date === dateFilter);
  if (resultFilter === '✓') records = records.filter(r => r.betResult === '✓');
  else if (resultFilter === '✗') records = records.filter(r => r.betResult === '✗');
  else if (resultFilter === 'pending') records = records.filter(r => !r.betResult);

  const total = allBetRecords.length;
  // 走盘(➖)不计入有效验证；半赢◐/半输◑按0.5计入命中率
  const settled = allBetRecords.filter(r => r.betResult && r.betResult !== '➖');
  const verified = settled.length;
  const hitCount = allBetRecords.filter(r => r.betResult === '✓').length;
  const missCount = allBetRecords.filter(r => r.betResult === '✗').length;
  const halfWin = allBetRecords.filter(r => r.betResult === '◐').length;
  const halfLoss = allBetRecords.filter(r => r.betResult === '◑').length;
  const hitEquiv = hitCount + halfWin * 0.5 + halfLoss * 0.5; // 命中等效值(半赢含0.5赢)
  const hitRate = verified > 0 ? ((hitEquiv / verified) * 100).toFixed(1) : '-';

  statsEl.innerHTML = `
    <div style="background:${canManage ? '#16261a' : '#1f2633'};border:1px solid ${canManage ? '#238636' : '#1f6feb'};border-radius:6px;padding:6px 12px;font-size:11px">
      <span style="color:#8b949e">模式</span><span style="color:${canManage ? '#3fb950' : '#58a6ff'};font-weight:700;margin-left:4px">${modeText}</span>
    </div>
    ${betRecordsMeta.offline ? `<div style="background:#2d1f12;border:1px solid #d29922;border-radius:6px;padding:6px 12px;font-size:11px;color:#d29922">离线缓存：${escapeHtml(betRecordsMeta.error || '公共 API 暂不可用')}</div>` : ''}
    <div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:6px 12px;font-size:11px">
      <span style="color:#8b949e">总推荐</span><span style="color:#e6edf3;font-weight:700;margin-left:4px">${total}</span>
    </div>
    <div style="background:#1a2d1a;border:1px solid #3fb950;border-radius:6px;padding:6px 12px;font-size:11px">
      <span style="color:#8b949e">命中</span><span style="color:#3fb950;font-weight:700;margin-left:4px">${hitCount}</span>
    </div>
    <div style="background:#2d1a1a;border:1px solid #f85149;border-radius:6px;padding:6px 12px;font-size:11px">
      <span style="color:#8b949e">未中</span><span style="color:#f85149;font-weight:700;margin-left:4px">${missCount}</span>
    </div>
    <div style="background:#1f3a5a;border:1px solid #1f6feb;border-radius:6px;padding:6px 12px;font-size:11px">
      <span style="color:#8b949e">命中率</span><span style="color:#58a6ff;font-weight:700;margin-left:4px">${hitRate}%</span>
    </div>
    <div style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:6px 12px;font-size:11px">
      <span style="color:#8b949e">待验证</span><span style="color:#d29922;font-weight:700;margin-left:4px">${total - verified}</span>
    </div>`;

  if (!records.length) {
    el.innerHTML = `<div class="empty-state"><div class="emoji">📈</div><p>${isOfficialMode ? '暂无官方高价值投注记录' : '暂无高价值投注记录'}<br>${canManage ? 'AI分析后自动提取高/中高价值建议' : '普通用户只读官方战绩，自己的AI推荐保存在本地私有记录中'}</p></div>`;
    return;
  }

  // 排序：按价值（高价值>中高价值>其他），再按日期倒序
  const valuePriority = v => v === '高价值' ? 0 : v === '中高价值' ? 1 : 2;
  const sortMode = document.getElementById('recordsSortMode')?.value || 'date';
  if (sortMode === 'value') {
    records = [...records].sort((a, b) => {
      const vd = valuePriority(a.valueLevel) - valuePriority(b.valueLevel);
      if (vd !== 0) return vd;
      return (b.date || '').localeCompare(a.date || '');
    });
  }

  // 按日期分组渲染
  const byDate = {};
  records.forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });

  let html = '';
  Object.keys(byDate).sort().reverse().forEach(date => {
    const dayRecs = byDate[date];
    const dayHit = dayRecs.filter(r => r.betResult === '✓').length;
    const dayVerified = dayRecs.filter(r => r.betResult).length;
    html += `<div style="margin-bottom:14px">
      <div class="records-day-head">
        <span>📅 ${date}</span>
        <div class="records-day-actions">
          <span style="font-size:10px;color:#8b949e">${dayRecs.length}条 命中${dayVerified > 0 ? (dayHit/dayVerified*100).toFixed(0)+'%' : '-'}</span>
          ${canManage ? `<button class="btn btn-sm" style="font-size:10px;background:#2d1a1a;border:1px solid #f85149;color:#f85149;padding:2px 6px"
            data-action="deleteByDate" data-date="${date}">🗑 删除当日</button>` : `<span style="font-size:10px;color:#58a6ff">只读</span>`}
        </div>
      </div>
      <div class="records-table-wrap">
      <table class="records-table">
        <colgroup>
          <col style="width:16%">
          <col style="width:12%">
          <col style="width:20%">
          <col style="width:9%">
          <col style="width:11%">
          <col style="width:9%">
          <col style="width:9%">
          <col style="width:14%">
        </colgroup>
        <thead><tr style="color:#8b949e;border-bottom:1px solid #30363d;font-size:10px">
          <th style="text-align:left">比赛</th>
          <th style="text-align:left">盘口</th>
          <th style="text-align:left">选项</th>
          <th style="text-align:center">赔率</th>
          <th style="text-align:center">价值</th>
          <th style="text-align:center">比分</th>
          <th style="text-align:center">结果</th>
          <th style="text-align:center">操作</th>
        </tr></thead><tbody>`;

    dayRecs.forEach(rec => {
      const resultColorMap = { '✓': '#3fb950', '✗': '#f85149', '◐': '#d4a72c', '◑': '#d29922', '➖': '#8b949e' };
      const resultColor = resultColorMap[rec.betResult] || '#484f58';
      const valueColor = rec.valueLevel === '高价值' ? '#f0883e' : '#58a6ff';
      const matchName = `${rec.matchHome}vs${rec.matchAway}`;
      const shortName = matchName.length > 10 ? matchName.slice(0, 10) + '…' : matchName;
      const safeId = rec.id.replace(/[^a-z0-9]/gi, '_');

      html += `<tr style="border-bottom:1px solid #21262d">
        <td class="clip-text" style="color:#c9d1d9" title="${escapeHtml(matchName)}">${escapeHtml(shortName)}</td>
        <td class="clip-text" style="color:#8b949e;font-size:10px" title="${escapeHtml(rec.betType)}">${escapeHtml(rec.betType)}</td>
        <td class="clip-text" style="color:#e6edf3;font-weight:600" title="${escapeHtml(rec.selection)}">${escapeHtml(rec.selection)}</td>
        <td style="text-align:center;color:#8b949e;font-size:10px">${escapeHtml(rec.odds||'-')}</td>
        <td style="text-align:center"><span class="pill-text" style="color:${valueColor};font-size:10px;font-weight:600">${escapeHtml(rec.valueLevel)}</span></td>
        <td style="text-align:center">
          <input type="text" placeholder="比分" value="${escapeHtml(rec.actualScore||'')}"
            id="score_${safeId}" ${canManage ? '' : 'disabled'}
            style="width:42px;max-width:100%;background:#0d1117;border:1px solid #30363d;border-radius:3px;color:#e6edf3;padding:2px 3px;font-size:10px;text-align:center;${canManage ? '' : 'opacity:0.65'}">
        </td>
        <td style="text-align:center">
          <select id="result_${safeId}" ${canManage ? '' : 'disabled'}
            style="width:42px;max-width:100%;background:#0d1117;border:1px solid #30363d;border-radius:3px;color:${resultColor};font-size:10px;padding:1px;${canManage ? '' : 'opacity:0.65'}">
            <option value="">-</option>
            <option value="✓" ${rec.betResult==='✓'?'selected':''}>✓</option>
            <option value="✗" ${rec.betResult==='✗'?'selected':''}>✗</option>
            <option value="◐" ${rec.betResult==='◐'?'selected':''}>◐</option>
            <option value="◑" ${rec.betResult==='◑'?'selected':''}>◑</option>
            <option value="➖" ${rec.betResult==='➖'?'selected':''}>➖</option>
          </select>
        </td>
        <td style="text-align:center">
          <div class="records-actions">
            ${canManage && !rec.betResult ? `<button class="btn btn-sm" style="background:#1f3a5a;border:1px solid #1f6feb;color:#58a6ff"
              data-action="verifyBetRecord" data-id="${escapeHtml(rec.id)}"
              data-match-id="${escapeHtml(rec.matchId)}"
              data-match-home="${escapeHtml(rec.matchHome||'')}"
              data-match-away="${escapeHtml(rec.matchAway||'')}"
              data-bet-type="${escapeHtml(rec.betType)}"
              data-selection="${escapeHtml(rec.selection)}">验</button>` : ''}
            ${canManage ? `<button class="btn btn-sm" style="background:#21262d;border:1px solid #30363d;color:#8b949e"
              data-action="saveBetResult" data-id="${escapeHtml(rec.id)}" data-safe="${safeId}">存</button>
            <button class="btn btn-sm" style="background:#2d1a1a;border:1px solid #f85149;color:#f85149"
              data-action="deleteBetRecord" data-id="${escapeHtml(rec.id)}">删</button>` : `<span style="font-size:10px;color:#58a6ff">官方只读</span>`}
          </div>
        </td>
      </tr>`;
    });

    html += `</tbody></table></div></div>`;
  });

  el.innerHTML = html;
}

// 事件委托：处理今日赛事和战绩操作
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'dailyViewMatch') {
    const id = btn.dataset.id;
    currentMatchId = id;
    document.getElementById('matchIdInput').value = id;
    await loadDataForMatch(id);
    switchTab('data');
    return;
  }

  if (action === 'dailyStartMonitor') {
    const id = btn.dataset.id;
    const resp = await sendMsg({ type: 'START_MONITOR', matchId: id, intervalMin: 2 });
    if (resp.ok) {
      showAlert(`✅ 已启动监控 ${btn.dataset.home} vs ${btn.dataset.away}`, 'success', 3000);
    }
    return;
  }

  if (action === 'showFullAI') {
    const id = btn.dataset.id;
    const item = todayMatchItems.find(it => it.match.id === id);
    if (!item?.aiResult?.content) return;
    const m = item.match;
    document.getElementById('reportContent').innerHTML =
      `<div style="padding:10px"><div style="font-size:12px;color:#58a6ff;font-weight:600;margin-bottom:8px">🤖 ${escapeHtml(m.home)} vs ${escapeHtml(m.away)} AI详细分析</div>
       <div class="ai-output" style="font-size:12px;white-space:pre-wrap;line-height:1.6">${escapeHtml(item.aiResult.content)}</div>
       <button class="btn btn-sm" style="margin-top:8px;background:#21262d;border:1px solid #30363d;color:#8b949e" onclick="copyToClipboard(${JSON.stringify(item.aiResult.content)});showAlert('已复制','success',1500)">📋 复制</button></div>`;
    switchTab('report');
    return;
  }

  if (action === 'verifyBetRecord') {
    const id = btn.dataset.id;
    const matchId = btn.dataset.matchId;
    const betType = btn.dataset.betType;
    const selection = btn.dataset.selection;
    btn.textContent = '验证中...';
    btn.disabled = true;
    try {
      const resp = await sendMsg({ type: 'VERIFY_BET_RECORD', matchId, betType, selection,
        matchHome: btn.dataset.matchHome || '', matchAway: btn.dataset.matchAway || '' });
      if (resp.ok) {
        // 同步本地记录
        const rec = allBetRecords.find(r => r.id === id);
        if (rec) {
          rec.actualScore = resp.score || rec.actualScore;
          if (resp.betResult) rec.betResult = resp.betResult;
        }
        const resultMap = { '✓': '✅ 命中', '✗': '❌ 未中', '◐': '🟡 半赢', '◑': '🟠 半输', '➖': '⚪ 走盘退款' };
        const resultText = resultMap[resp.betResult] || '⚠️ 无法自动判断';
        showAlert(`${resultText} | 比分: ${resp.score || '未知'} | ${resp.autoJudge || ''}`, 'info', 6000);
        renderDailyRecords();
      } else {
        showAlert(`验证失败: ${resp.error}`, 'error');
        btn.textContent = '🔍验证';
        btn.disabled = false;
      }
    } catch (e) {
      showAlert(`验证出错: ${e.message}`, 'error');
      btn.textContent = '🔍验证';
      btn.disabled = false;
    }
    return;
  }

  if (action === 'verifyAllPending') {
    // 一键验证所有待验证记录
    const pending = allBetRecords.filter(r => !r.betResult);
    if (!pending.length) { showAlert('没有待验证的记录', 'info', 2000); return; }
    const verifyAllBtn = document.getElementById('verifyAllBtn');
    if (verifyAllBtn) { verifyAllBtn.textContent = `验证中(0/${pending.length})...`; verifyAllBtn.disabled = true; }
    let done = 0, hit = 0, miss = 0;
    for (const rec of pending) {
      try {
        const resp = await sendMsg({ type: 'VERIFY_BET_RECORD', matchId: rec.matchId, betType: rec.betType, selection: rec.selection,
          matchHome: rec.matchHome || '', matchAway: rec.matchAway || '' });
        if (resp.ok && resp.betResult) {
          rec.actualScore = resp.score || rec.actualScore;
          rec.betResult = resp.betResult;
          if (resp.betResult === '✓') hit++;
          else if (resp.betResult === '✗') miss++;
        }
      } catch {}
      done++;
      if (verifyAllBtn) verifyAllBtn.textContent = `验证中(${done}/${pending.length})...`;
    }
    if (verifyAllBtn) { verifyAllBtn.textContent = '⚡ 一键验证'; verifyAllBtn.disabled = false; }
    showAlert(`批量验证完成：命中${hit}，未中${miss}，其余${pending.length-hit-miss}场无法自动判断`, 'success', 6000);
    renderDailyRecords();
    return;
  }

  if (action === 'saveBetResult') {
    const id = btn.dataset.id;
    const safeId = btn.dataset.safe;
    const score = document.getElementById(`score_${safeId}`)?.value || '';
    const result = document.getElementById(`result_${safeId}`)?.value || '';
    await sendMsg({ type: 'UPDATE_BET_RECORD', id, actualScore: score, betResult: result });
    // 同步本地
    const rec = allBetRecords.find(r => r.id === id);
    if (rec) { rec.actualScore = score; rec.betResult = result; }
    showAlert('✅ 结果已保存', 'success', 1500);
    renderDailyRecords();
    return;
  }

  if (action === 'deleteBetRecord') {
    const id = btn.dataset.id;
    if (!confirm('确定删除该条投注记录？')) return;
    await sendMsg({ type: 'DELETE_BET_RECORD', id });
    allBetRecords = allBetRecords.filter(r => r.id !== id);
    renderDailyRecords();
    return;
  }

  if (action === 'deleteByDate') {
    const date = btn.dataset.date;
    if (!confirm(`确定删除 ${date} 的所有投注记录？`)) return;
    await sendMsg({ type: 'DELETE_BET_RECORDS_BY_DATE', date });
    allBetRecords = allBetRecords.filter(r => r.date !== date);
    renderDailyRecords();
    return;
  }

  if (action === 'saveMatchResult') {
    // 兼容旧代码，实际不再使用
    showAlert('请在战绩Tab使用新的验证功能', 'info', 2000);
  }
});

// 监控列表中的滚球预测按钮
async function fetchLiveAndPredict(matchId) {
  showAlert(`正在采集滚球数据 ${matchId}...`, 'info');
  try {
    const resp = await sendMsg({ type: 'FETCH_LIVE_DATA', matchId });
    if (resp.ok && resp.data) {
      renderLiveData(matchId, resp.data);
    } else {
      showAlert('滚球数据采集失败', 'warn');
    }
  } catch (e) {
    showAlert(e.message, 'error');
  }
}

function renderLiveData(matchId, liveData) {
  const { matchInfo, liveScore, events, asianLive, ouLive, matchStats, recentStats } = liveData;
  const home = matchInfo?.home || '主队';
  const away = matchInfo?.away || '客队';
  const league = matchInfo?.league || '';
  const score = liveScore?.score || '-:-';
  const minute = liveScore?.minute || '';
  const status = liveScore?.status || '';

  let html = `<div class="data-section">
    <div class="section-header" style="color:#f85149">🔴 滚球实时数据${league ? ' · ' + escapeHtml(league) : ''}</div>
    <div class="section-body">
      <div class="stat-row"><span class="stat-label">${escapeHtml(home)} vs ${escapeHtml(away)}</span><span class="stat-value highlight" style="font-size:18px">${score}</span></div>
      <div class="stat-row"><span class="stat-label">状态</span><span class="stat-value">${minute ? minute + "' " : ''}${escapeHtml(status)}</span></div>
      ${asianLive?.handicap ? `<div class="stat-row"><span class="stat-label">实时亚盘</span><span class="stat-value">${asianLive.handicap} 主${asianLive.homeWater}/客${asianLive.awayWater}</span></div>` : ''}
      ${ouLive?.line ? `<div class="stat-row"><span class="stat-label">实时大小球</span><span class="stat-value">${ouLive.line} 大${ouLive.overWater}/小${ouLive.underWater}</span></div>` : ''}
    </div>
  </div>`;

  // 本场实时技术统计
  const ms = matchStats || {};
  const statKeys = Object.keys(ms);
  if (statKeys.length > 0) {
    html += `<div class="data-section">
      <div class="section-header">📊 本场技术统计（主 / 客）</div>
      <div class="section-body">`;
    statKeys.forEach(k => {
      const s = ms[k];
      html += `<div class="stat-row"><span class="stat-label">${escapeHtml(s.label)}</span><span class="stat-value">${escapeHtml(s.home)} / ${escapeHtml(s.away)}</span></div>`;
    });
    html += `</div></div>`;
  }

  // 近期技统（近3 / 近10 场）
  const rs = recentStats || {};
  const rKeys = Object.keys(rs.home || {});
  if (rKeys.length > 0) {
    html += `<div class="data-section">
      <div class="section-header">📈 近期场均（近3 / 近10）</div>
      <div class="section-body">`;
    rKeys.forEach(k => {
      const h = rs.home[k], a = rs.away?.[k] || {};
      html += `<div class="stat-row"><span class="stat-label">${escapeHtml(k)}</span><span class="stat-value">主 ${escapeHtml(h.n3)}/${escapeHtml(h.n10)} · 客 ${escapeHtml(a.n3 || '-')}/${escapeHtml(a.n10 || '-')}</span></div>`;
    });
    html += `</div></div>`;
  }

  if (events?.length > 0) {
    html += `<div class="data-section">
      <div class="section-header">⚽ 比赛事件</div>
      <div class="section-body"><div class="signal-list">`;
    events.forEach(ev => {
      const icon = ev.type === 'goal' ? '⚽' : '🟥';
      html += `<div class="signal-item"><div class="signal-dot positive"></div>${icon} ${ev.minute}' ${escapeHtml(ev.kind || '')}</div>`;
    });
    html += `</div></div></div>`;
  }

  // 滚球建议面板
  const suggestions = liveData.suggestions || [];
  if (suggestions.length > 0) {
    const confColor = c => c >= 75 ? '#3fb950' : c >= 60 ? '#f0883e' : '#8b949e';
    html += `<div class="data-section" style="border:1px solid #238636;background:#0d2318">
      <div class="section-header" style="color:#3fb950">💡 滚球补单建议方案（按信心度排序）</div>
      <div class="section-body">`;
    suggestions.forEach(s => {
      html += `<div style="margin-bottom:10px;padding:8px;background:#0d1117;border-radius:6px;border-left:3px solid ${confColor(s.confidence)}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="color:${confColor(s.confidence)};font-weight:700;font-size:13px">${escapeHtml(s.signal)}</span>
          <span style="font-size:12px;color:#e6edf3">${escapeHtml(s.title)}</span>
          <span style="margin-left:auto;font-size:11px;color:${confColor(s.confidence)};font-weight:700">${s.confidence}%</span>
        </div>
        <div style="font-size:11px;color:#8b949e;line-height:1.5">${escapeHtml(s.reason)}</div>
      </div>`;
    });
    html += `<div style="font-size:10px;color:#484f58;margin-top:4px">⚠️ 以上建议基于当前实时数据的统计概率，仅供参考，请结合盘口走势自行判断。</div>
      </div></div>`;
  } else {
    html += `<div class="data-section"><div class="section-body" style="color:#8b949e;font-size:11px;padding:8px">暂无滚球建议（比赛未开始或数据不足）</div></div>`;
  }

  // 插入到数据面板
  const dataEl = document.getElementById('dataContent');
  dataEl.innerHTML = html + (dataEl.innerHTML || '');
  switchTab('data');
}
