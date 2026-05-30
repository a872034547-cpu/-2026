// popup.js - 弹窗逻辑控制

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
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  initButtons();
  await loadMonitorList();

  // 从 storage 恢复上次使用的 matchId
  const saved = await chrome.storage.local.get('lastMatchId');
  if (saved.lastMatchId) {
    document.getElementById('matchIdInput').value = saved.lastMatchId;
    currentMatchId = saved.lastMatchId;
    await loadDataForMatch(currentMatchId);
  }
});

// ===== Tab 切换 =====
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = `tab-${tab.dataset.tab}`;
      document.getElementById(panelId).classList.add('active');
    });
  });
}

// ===== 按钮绑定 =====
function initButtons() {
  document.getElementById('startMonitorBtn').addEventListener('click', startMonitor);
  document.getElementById('fetchOnceBtn').addEventListener('click', fetchOnce);
  document.getElementById('localPredBtn').addEventListener('click', runLocalPredict);
  document.getElementById('aiPredBtn').addEventListener('click', runAIPredict);
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
    <button class="btn btn-sm" style="background:#21262d;border:1px solid #f85149;color:#f85149" onclick="clearHistory()">清除记录</button>
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
          <button class="btn btn-sm" style="background:#238636;color:#fff" onclick="saveReview(${h.id})">保存</button>
        </div>
      </div>
    </div>`;
  });

  el.innerHTML = html;
}

window.saveReview = async function(id) {
  const input = document.getElementById(`review_${id}`);
  if (!input) return;
  await sendMsg({ type: 'UPDATE_REVIEW', id, actualResult: input.value, review: '' });
  showAlert('✅ 复盘记录已保存', 'success', 2000);
};

window.clearHistory = async function() {
  if (!confirm('确定清除所有预测记录？')) return;
  await chrome.storage.local.remove('pred_history');
  loadHistory();
};

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
  const { analysis, asian, overunder, corner } = data;
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
  if (corner && !corner.error && corner.mainLine) {
    html += `<div class="data-section">
      <div class="section-header">🔢 角球盘口</div>
      <div class="section-body">
        <div class="stat-row"><span class="stat-label">主流角球线</span><span class="stat-value highlight">${corner.mainLine} 个</span></div>
        ${corner.mainOver ? `<div class="stat-row"><span class="stat-label">大角球水位</span><span class="stat-value">${corner.mainOver}</span></div>` : ''}
        ${corner.mainUnder ? `<div class="stat-row"><span class="stat-label">小角球水位</span><span class="stat-value">${corner.mainUnder}</span></div>` : ''}
      </div>
    </div>`;
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
        <button class="btn btn-blue btn-sm" onclick="selectMatch('${matchId}')">查看</button>
        <button class="btn btn-sm" style="background:#2d1a1a;border:1px solid #f85149;color:#f85149" onclick="stopMonitor('${matchId}')">停止</button>
      </div>
    </div>`;
  }
  el.innerHTML = html;
}

window.selectMatch = async function(matchId) {
  currentMatchId = matchId;
  document.getElementById('matchIdInput').value = matchId;
  await loadDataForMatch(matchId);
  switchTab('data');
};

window.stopMonitor = async function(matchId) {
  await sendMsg({ type: 'STOP_MONITOR', matchId });
  await loadMonitorList();
  showAlert(`已停止监控 ${matchId}`, 'info');
};

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
