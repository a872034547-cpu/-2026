// Background Service Worker - Tab注入为主，后台fetch为辅

import从‘./js/ Predictor .js’导入{Predictor， PredictionLogger}； { Predictor, PredictionLogger } from './js/predictor.js';
import从‘./js/report.js’中导入{ReportGenerator}； { ReportGenerator } from './js/report.js';
import从‘./js/ai-client.js’导入{AIClient}； { AIClient } from './js/ai-client.js';

constconst predictor = new predictor ()； predictor = new Predictor();
constconst reportGen = new reportGenerator ()； reportGen = new ReportGenerator();
constconst aiClient = new AIClient()； aiClient = new AIClient();

let   让monitorTasks = {}； monitorTasks = {};
let panelWindowId = null; // 固定面板窗口ID

// 点击图标打开固定独立窗口（不会自动消失）
chromechrome.action.onClicked。addListener(async () => {.action.onClicked.addListener(async () => {
  // 如果窗口已存在，聚焦它
  如果(panelwindowwid ！== null) {if (panelWindowId !== null) {
       尝试{try {
      等待chrome.windows。update(panelWindowId, {focused: true})；await chrome.windows   窗户   窗户.update(panelWindowId, { focused: true });
         返回;return;
    } catch {
      panelWindowId = null; // 窗口已关闭，重新创建
    }
  }
  const win = await chrome.windows   窗户.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 560,
    height: 800,
    top: 80,
    left: 80
  });
  panelWindowId = win.id;
  // 监听窗口关闭，清除ID
  chrome.windows   窗户.onRemoved.addListener(function onRemoved(id) {
    if (id === panelWindowId) {
      panelWindowId = null;
      chrome.windows.onRemoved.removeListener(onRemoved);
    }
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  // 首次安装时写入默认 AI 配置（不覆盖已有配置）
  const existing = await chrome.storage.sync.get(['aiProvider']);
  if (!existing.aiProvider) {
    await chrome.storage.sync.set({
      aiProvider: 'custom',
      aiApiKey: '',
      aiCustomEndpoint: 'https://jiuuij.de5.net/v1',
      aiModel: 'grok-4.20-multi-agent-xhigh'
    });
  }
  await restoreMonitorTasks();
});

chrome.runtime.onStartup.addListener(async () => {
  await restoreMonitorTasks();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('monitor_')) return;
  const matchId = alarm.name.replace('monitor_', '');
  await runMonitorCycle(matchId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PAGE_DATA') {
    handlePageData(msg, sender);
    sendResponse({ ok: true });
    return true;
  }
  handleMessage(msg, sender, sendResponse);
  return true;
});

// content script 主动上报（页面打开时自动触发）
async function handlePageData(msg, sender) {
  const { matchId, dataType, data } = msg;
  if (!matchId || !data) return;

  const key = `partial_${matchId}`;
  const stored = await chrome.storage.local.get(key);
  const partial = stored[key] || {};
  partial[dataType] = data;
  partial._updated = Date.now();

  await chrome.storage.local.set({ [key]: partial });

  const   常量 types = ['analysis', 'asian', 'overunder', 'corner'];
  const filled = types.filter(t => partial[t] && !partial[t].error);

  console.log(`[BG] PageData ${matchId}/${dataType}: ${filled.length}/4 ready`);

  // 4种数据到齐后合并存储
  if (filled.length === types.length) {
    const fullData = {
      matchId, fetchTime: new Date().toISOString(),
      analysis: partial.analysis,
      asian: partial.asian,
      overunder: partial.overunder,
      corner: partial.corner
    };
    await storeData(matchId, fullData);
    await chrome.storage.local.remove(key);
    console.log(`[BG] All data collected for ${matchId}`);
  }
}

async function handleMessage(msg, sender, sendResponse) {
  try {
    switch (msg.type) {

      case 'START_MONITOR': {
        const { matchId, intervalMin = 2 } = msg;
        await startMonitor(matchId, intervalMin);
        sendResponse({ ok: true });
        break;
      }

      case 'STOP_MONITOR': {
        await stopMonitor(msg.matchId);
        sendResponse({ ok: true });
        break;
      }

      case 'FETCH_NOW': {
        const { matchId } = msg;
        // 主方法：打开4个标签页，通过content script采集DOM
        const data = await collectViaTabInjection(matchId);
        if (data) {
          await storeData(matchId, data);
          sendResponse({ ok: true, data });
        } else {
          sendResponse({ ok: false, error: '数据采集失败，请确保已登录球探网，或手动打开球探网页面后重试' });
        }
        break;
      }

      case 'GET_REPORT': {
        const stored = await getStoredData(msg.matchId);
        if (!stored) { sendResponse({ ok: false, error: '暂无数据，请先采集' }); break; }
        const report = reportGen.generate(stored);
        sendResponse({ ok: true, report });
        break;
      }

      case 'AI_PREDICT': {
        const stored = await getStoredData(msg.matchId);
        if (!stored) { sendResponse({ ok: false, error: '暂无数据，请先采集' }); break; }
        const report = reportGen.generate(stored);
        const prediction = await aiClient.predict(report, msg.matchId);
        sendResponse({ ok: true, prediction, reportMarkdown: report.markdown });
        break;
      }

      case 'AI_CHAT': {
        // 多轮对话：msg.messages = [{role,content},...], msg.reportMarkdown = 报告上下文
        const reply = await aiClient.chat(msg.messages, msg.reportMarkdown || '');
        sendResponse({ ok: !reply.error, reply, error: reply.error });
        break;
      }

      case 'LOCAL_PREDICT': {
        const stored = await getStoredData(msg.matchId);
        if (!stored) { sendResponse({ ok: false, error: '暂无数据，请先采集' }); break; }
        const prediction = predictor.predict(stored);
        // 保存预测记录
        await PredictionLogger.save(prediction, stored.data?.analysis?.matchInfo);
        // 检查是否有高信心提示
        const highAlert = prediction.alerts?.find(a => a.playSound);
        if (highAlert) {
          chrome.notifications.create(`pred_${Date.now()}`, {
            type: 'basic', iconUrl: 'icons/icon48.png',
            title: '⚡ 重点推荐提示',
            message: highAlert.msg
          });
        }
        sendResponse({ ok: true, prediction });
        break;
      }

      case 'GET_PRED_HISTORY': {
        const history = await PredictionLogger.getAll();
        sendResponse({ ok: true, history });
        break;
      }

      case 'UPDATE_REVIEW': {
        await PredictionLogger.updateReview(msg.id, msg.actualResult, msg.review);
        sendResponse({ ok: true });
        break;
      }

      case 'LIST_MONITORS': {
        sendResponse({ ok: true, tasks: Object.keys(monitorTasks) });
        break;
      }

      case 'GET_STORED_DATA': {
        const data = await getStoredData(msg.matchId);
        sendResponse({ ok: !!data, data });
        break;
      }
      case 'GET_RAW_DEBUG': {
        // 直接打开分析页面提取原始文本（前2000字）用于调试
        const { matchId } = msg;
        try {
          const debugData = await extractOneTab(
            `https://zq.titan007.com/analysis/${matchId}cn.htm`,
            'debug'
          );
          sendResponse({ ok: true, debug: debugData });
        } catch(e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  } catch (err) {
    console.error('[BG] error:', err);
    sendResponse({ ok: false, error: err.message });
  }
}

// ===== 核心：通过标签页注入采集4个数据源 =====
async function collectViaTabInjection(matchId) {
  const sources = [
    { type: 'analysis',  url: `https://zq.titan007.com/analysis/${matchId}cn.htm` },
    { type: 'asian',     url: `https://vip.titan007.com/AsianOdds_n.aspx?id=${matchId}&l=0` },
    { type: 'overunder', url: `https://vip.titan007.com/OverDown_n.aspx?id=${matchId}&l=0` },
    { type: 'corner',    url: `https://vip.titan007.com/Corner.aspx?id=${matchId}&l=0` }
  ];

  const results = await Promise.allSettled(sources.map(s => extractOneTab(s.url, s.type)));

  const data = { matchId, fetchTime: new Date().toISOString() };
  sources.forEach((s, i) => {
    data[s.type] = results[i].status === 'fulfilled' && results[i].value
      ? results[i].value
      : { error: results[i].reason?.message || '采集失败' };
  });

  const hasAnyData = sources.some(s => data[s.type] && !data[s.type].error);
  return hasAnyData ? data : null;
}

function extractOneTab(url, dataType) {
  return new Promise((resolve, reject) => {
    let tabId = null;
    let done = false;

    const finish = (result, err) => {
      if (done) return;
      done = true;
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      if (err) reject(err);
      else resolve(result);
    };

    // 超时 20秒
    const timer = setTimeout(() => finish(null, new Error(`超时: ${url}`)), 20000);

    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        finish(null, new Error(chrome.runtime.lastError.message));
        return;
      }
      tabId = tab.id;

      const onUpdated = (id, info) => {
        if (id !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);

        // analysis 页面内容通过 Ajax 异步加载，需分阶段等待
        const waitMs = dataType === 'analysis' ? 6000 : 2500;

        const tryExtract = (attempt) => {
          chrome.scripting.executeScript({
            target: { tabId },
            func: extractPageData,
            args: [dataType]
          }, (injResults) => {
            if (chrome.runtime.lastError) {
              clearTimeout(timer);
              finish(null, new Error(chrome.runtime.lastError.message));
              return;
            }
            const result = injResults?.[0]?.result;
            // analysis 页：textLen < 12000 且还有重试机会，再等3秒重试
            if (dataType === 'analysis' && result?._debug?.textLen < 12000 && attempt < 2) {
              setTimeout(() => tryExtract(attempt + 1), 3000);
              return;
            }
            clearTimeout(timer);
            finish(result || null, null);
          });
        };

        setTimeout(() => tryExtract(0), waitMs);
      };

      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

// 此函数将被注入到目标页面中执行（不能引用外部变量）
function extractPageData(dataType) {
  try {
    const text = document.body.innerText || '';
    const html = document.documentElement.outerHTML || '';
    // 触发懒加载：滚动到底部再回顶部
    window.scrollTo(0, document.body.scrollHeight);
    window.scrollTo(0, 0);

    // 重新获取最新 text（滚动后内容可能已更新）
    var freshText = document.body.innerText || '';
    if (freshText.length > text.length) text = freshText;

    if (dataType === 'analysis') return extractAnalysis(text, html);
    if (dataType === 'asian')    return extractAsian(text, html);
    if (dataType === 'overunder')return extractOverUnder(text, html);
    if (dataType === 'corner')   return extractCorner(text, html);
    if (dataType === 'debug')    return {
      title: document.title,
      textLen: text.length,
      textSample: text.substring(0, 500),
      tables: document.querySelectorAll('table').length,
      h2s: Array.from(document.querySelectorAll('h2')).map(h => h.textContent.trim()).slice(0,10)
    };
    return null;
  } catch (e) {
    return { error: e.message };
  }

  // ===================== 赛前分析（精简稳健版）=====================
  function extractAnalysis(text, html) {
    const result = {
      matchInfo: {}, homeStats: {}, awayStats: {},
      homeHalfStats: {}, awayHalfStats: {},
      handicapTrend: { home: {}, away: {} },
      sameHandicapHistory: [],
      goalSingleDouble: {},
      goalTimeDistribution: {},
      injuries: { home: [], away: [] },
      playerRatings: {},
      preBriefing: '',
      dataComparison: { home: {}, away: {} },
      _debug: { title: document.title, textLen: text.length, tables: document.querySelectorAll('table').length }
    };

    // ---- 基本信息 ----
    const timeM = text.match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/);
    if (timeM) result.matchInfo.time = timeM[1] + ' ' + timeM[2];

    const titleM = document.title.match(/^(.+?)\s+VS\s+(.+?)[\(（\(]/i);
    if (titleM) {
      result.matchInfo.home = titleM[1].trim();
      result.matchInfo.away = titleM[2].trim();
    } else {
      const links = Array.from(document.querySelectorAll('a[href*="/team/Summary/"]'));
      const names = [];
      links.forEach(function(a) {
        var n = a.textContent.trim().replace(/\([^)]*\)/g, '').trim();
        if (n.length >= 2 && n.length <= 25 && names.indexOf(n) < 0) names.push(n);
      });
      result.matchInfo.home = names[0] || '';
      result.matchInfo.away = names[1] || '';
    }

    var wm = text.match(/天气[：:]\s*([^\s\n]{1,10})/);
    if (wm) result.matchInfo.weather = wm[1];
    var tm = text.match(/温度[：:]\s*([^\n<]{3,20})/);
    if (tm) result.matchInfo.temperature = tm[1].trim();
    var lm = text.match(/(\d{4}-\d{4})赛季([^\n\-（(]{2,20})/);
    if (lm) result.matchInfo.league = lm[2].trim();

    // ---- 联赛战绩：通过h3/h2标题定位主客队表格 ----
    // 球探网结构：[法甲-1]巴黎圣日耳曼 → 全场表 → 半场表 → [英超-1]阿森纳 → 全场表 → 半场表
    // 战绩表格：必须同时含有"总"行和"近6"行才算有效战绩表
    var parseStatsTable = function(tbl) {
      var statsObj = {};
      var rows = tbl.querySelectorAll('tr');
      for (var ri = 0; ri < rows.length; ri++) {
        var tds = rows[ri].querySelectorAll('td');
        var cells = [];
        for (var ci = 0; ci < tds.length; ci++) cells.push(tds[ci].textContent.trim().replace(/\s+/g,''));
        if (cells.length < 5) continue;
        var lbl = cells[0];
        if (lbl==='总' && /^\d+$/.test(cells[1]) && parseInt(cells[1])>=5) {
          statsObj.total = { played:cells[1], win:cells[2], draw:cells[3], loss:cells[4],
            goalsFor:cells[5]||'', goalsAgainst:cells[6]||'', diff:cells[7]||'',
            points:cells[8]||'', rank:cells[9]||'', winRate:cells[10]||'' };
        }
        if ((lbl==='主'||lbl==='主场') && /^\d+$/.test(cells[1])) {
          statsObj.home = { played:cells[1], win:cells[2], draw:cells[3], loss:cells[4],
            goalsFor:cells[5]||'', goalsAgainst:cells[6]||'', winRate:cells[10]||'' };
        }
        if ((lbl==='客'||lbl==='客场') && /^\d+$/.test(cells[1])) {
          statsObj.away = { played:cells[1], win:cells[2], draw:cells[3], loss:cells[4],
            goalsFor:cells[5]||'', goalsAgainst:cells[6]||'', winRate:cells[10]||'' };
        }
        if ((lbl==='近6'||lbl==='近6场') && cells.length>=5 && /^\d+$/.test(cells[2])) {
          statsObj.last6 = { played:6, win:cells[2]||'', draw:cells[3]||'', loss:cells[4]||'',
            goalsFor:cells[5]||'', goalsAgainst:cells[6]||'' };
        }
      }
      // 必须同时有 total 和 home/last6 才算有效战绩表（排除最大值/最小值表格）
      return (statsObj.total && (statsObj.home || statsObj.last6)) ? statsObj : null;
    };

    var statsTables = [];
    var allTables = document.querySelectorAll('table');
    for (var ti=0; ti<allTables.length; ti++) {
      var ttext = allTables[ti].textContent;
      // 必须含"总""胜""赛""近6"才是战绩表
      if (ttext.indexOf('近6')>=0 && ttext.indexOf('胜')>=0 && ttext.indexOf('赛')>=0) {
        var parsed = parseStatsTable(allTables[ti]);
        if (parsed) statsTables.push({ data: parsed, idx: ti });
      }
    }

    // 按页面顺序：全场表1=主队，全场表2=客队（页面中主队在前）
    if (statsTables.length >= 1) result.homeStats = statsTables[0].data;
    if (statsTables.length >= 2) result.awayStats = statsTables[1].data;
    if (statsTables.length >= 3) result.homeHalfStats = statsTables[2].data;
    if (statsTables.length >= 4) result.awayHalfStats = statsTables[3].data;

    // ---- 盘路走势 ----
    var allRates = [];
    var rateRe = /赢盘率[^\d\n]{0,5}(\d{1,3}\.?\d*)%/g;
    var rm;
    while ((rm = rateRe.exec(text)) !== null) allRates.push(rm[1]);
    var allBigRates = [];
    var bigRe = /大球率[^\d\n]{0,5}(\d{1,3}\.?\d*)%/g;
    while ((rm = bigRe.exec(text)) !== null) allBigRates.push(rm[1]);

    result.handicapTrend.home.winRates = allRates.slice(0, 4);
    result.handicapTrend.away.winRates = allRates.slice(4, 8);
    result.handicapTrend.home.bigBallRates = allBigRates.slice(0, 3);
    result.handicapTrend.away.bigBallRates = allBigRates.slice(3, 6);

    // 近6场走势（格式：赢 赢 输 输 赢 输）
    var seqRe = /近6场\s*\n\s*6\s*\n\s*((?:[赢输走]\s+){3,8})/g;
    var seqMatches = [];
    while ((rm = seqRe.exec(text)) !== null) seqMatches.push(rm[1].trim().replace(/\s+/g,' '));
    if (seqMatches[0]) result.handicapTrend.home.last6Asian = seqMatches[0];
    if (seqMatches[1]) result.handicapTrend.away.last6Asian = seqMatches[1];

    var ouSeqRe = /近6场盘路走势:\s*((?:[大小走]\s*){3,8})/g;
    var ouSeqs = [];
    while ((rm = ouSeqRe.exec(text)) !== null) ouSeqs.push(rm[1].trim());
    if (ouSeqs[0]) result.handicapTrend.home.last6OU = ouSeqs[0];
    if (ouSeqs[1]) result.handicapTrend.away.last6OU = ouSeqs[1];

    // ---- 相同盘口历史 ----
    var sbRe = /初盘[:：]([\w\/]+)\s*[\s\S]{0,500}?近6场盘路走势:\s*([\w\s]+)/g;
    while ((rm = sbRe.exec(text)) !== null) {
      var block = text.slice(rm.index, rm.index + rm[0].length);
      var nm = block.match(/总\s*(\d+)\s*(\d+)\s*(\d+)\s*(\d+\.?\d*)%/);
      result.sameHandicapHistory.push({
        handicap: rm[1],
        total: nm ? { win:nm[1], draw:nm[2], loss:nm[3], rate:nm[4]+'%' } : null,
        last6: rm[2].trim()
      });
    }

    // ---- 进球数/单双 ----
    var sdRe = /(\d+)\((\d+\.?\d*)%\)/g;
    var sdNums = [];
    while ((rm = sdRe.exec(text)) !== null) sdNums.push({ n:rm[1], pct:rm[2] });
    if (sdNums.length >= 5) {
      result.goalSingleDouble.homeTotal = { big:sdNums[0], small:sdNums[1], draw:sdNums[2], odd:sdNums[3], even:sdNums[4] };
    }
    if (sdNums.length >= 10) {
      result.goalSingleDouble.awayTotal = { big:sdNums[5], small:sdNums[6], draw:sdNums[7], odd:sdNums[8], even:sdNums[9] };
    }

    // ---- 进球时间分布 ----
    var timeRows = [];
    var tlineRe = /(总|主|客)\s+([\d\s]{10,60})/g;
    while ((rm = tlineRe.exec(text)) !== null) {
      var nums = rm[2].trim().split(/\s+/).filter(function(x){ return /^\d+$/.test(x); });
      if (nums.length >= 8) timeRows.push({ label:rm[1], data:nums.slice(0,10) });
    }
    result.goalTimeDistribution.rows = timeRows.slice(0, 6);

    // ---- 缺阵球员 ----
    var injRe = /(\d{1,3})\s+\(([^)]+)\)\s+([^\n]{2,30})\n\s*([^\n]{2,30})/g;
    var inj = [];
    while ((rm = injRe.exec(text)) !== null) {
      inj.push({ number:rm[1], position:rm[2], name:rm[3].trim(), reason:rm[4].trim() });
    }
    // 按队分配（前半给主队，后半给客队，用球队名分割）
    var splitIdx = -1;
    if (result.matchInfo.away) {
      for (var i = 0; i < inj.length; i++) {
        if (i > 0 && text.indexOf(result.matchInfo.away) < text.indexOf(result.matchInfo.home)) {
          splitIdx = i; break;
        }
      }
    }
    if (splitIdx > 0) {
      result.injuries.home = inj.slice(0, splitIdx);
      result.injuries.away = inj.slice(splitIdx);
    } else {
      var half = Math.ceil(inj.length / 2);
      result.injuries.home = inj.slice(0, half);
      result.injuries.away = inj.slice(half);
    }

    // ---- 近10场平均评分 ----
    var homeScoresM = text.match(/主队近10场平均评分:([\s\S]{0,300}?)客队近10场/);
    if (homeScoresM) result.playerRatings.home10 = (homeScoresM[1].match(/\d+\.\d+/g)||[]).slice(0,10);
    var awayScoresM = text.match(/客队近10场平均评分:([\s\S]{0,300}?)(?:\n\n|\n\s*\n)/);
    if (awayScoresM) result.playerRatings.away10 = (awayScoresM[1].match(/\d+\.\d+/g)||[]).slice(0,10);

    // ---- 赛前简报 ----
    var briefM = text.match(/赛前简报\s*\n([\s\S]{50,2000}?)(?:\n##|\n本赛季|\n\*\*)/);
    if (briefM) result.preBriefing = briefM[1].trim();

    // ---- 数据统计比较 ----
    var bracketNums = [];
    var bnRe = /\[(\d+\.?\d*)\]/g;
    while ((rm = bnRe.exec(text)) !== null) bracketNums.push(rm[1]);
    result.dataComparison.allBracketNumbers = bracketNums.slice(0, 60);

    // 平均进失球
    var avgGoals = text.match(/平均进球[\s\S]{0,30}?\[(\d+\.\d+)\]/g);
    if (avgGoals && avgGoals[0]) result.dataComparison.home.avgGoal = (avgGoals[0].match(/\[(\d+\.\d+)\]/)||[])[1];
    if (avgGoals && avgGoals[1]) result.dataComparison.away.avgGoal = (avgGoals[1].match(/\[(\d+\.\d+)\]/)||[])[1];

    return result;
  }
  // ===================== 亚让盘（完整版）=====================
  function extractAsian(text, html) {
    const result = { companies: [], summary: {}, keyOdds: {}, history: [] };

    result.summary.up        = (text.match(/升盘[_\s]*(\d+)/) || [,'0'])[1];
    result.summary.down      = (text.match(/降盘[_\s]*(\d+)/) || [,'0'])[1];
    result.summary.highWater = (text.match(/高水[_\s]*(\d+)/) || [,'0'])[1];
    result.summary.lowWater  = (text.match(/低水[_\s]*(\d+)/) || [,'0'])[1];

    const HAND_RE = /受让平手\/半球|平手\/半球|半球\/一球|一球\/球半|球半\/两球|两球\/两球半|平手|半球|一球|球半|两球|两球半|三球/;
    const WATER_RE = /^[01]\.\d{2}$/;
    const SUB_RE = /^盘[2-9]$/;

    // 解析所有公司所有盘线
    // HTML表格：公司名TD用rowspan跨多行，子行(盘2/盘3)第一个TD是"盘2"等
    let currentCompany = null;
    let lastCompanyName = '';

    document.querySelectorAll('table tr').forEach(row => {
      const tds = Array.from(row.querySelectorAll('td'));
      const cells = tds.map(c => c.textContent.trim().replace(/\s+/g, ' '));
      if (!cells.length) return;

      const waters = cells.filter(c => WATER_RE.test(c));
      const lines  = cells.filter(c => HAND_RE.test(c));
      if (waters.length < 4 || lines.length < 1) return;

      // 判断是否子盘行：cells[0]="盘2" 或 cells[0]="" 且 cells[1]="盘2"
      const firstCell = cells[0] || '';
      const secondCell = cells[1] || '';
      const subLabel = SUB_RE.test(firstCell) ? firstCell : (SUB_RE.test(secondCell) ? secondCell : '');

      if (subLabel && currentCompany) {
        currentCompany.subLines = currentCompany.subLines || [];
        currentCompany.subLines.push({
          label: subLabel,
          // 列顺序: init_home, init_away, curr_home, curr_away [, dup_home, dup_away]
          initialHome: waters[0], initialHandicap: lines[0], initialAway: waters[1],
          currentHome: waters[2], currentHandicap: lines[lines.length > 1 ? 1 : 0], currentAway: waters[3]
        });
        return;
      }

      // 主公司行：从 TD[0] 提取公司名
      // 球探网公司名在 <td> 的 <a> 标签内或直接文字，后面跟详细链接
      var firstTd = row.querySelectorAll('td')[0];
      var rawName = '';
      if (firstTd) {
        // 优先取第一个 childNode 的文本（排除img/a等）
        var firstTextNode = '';
        firstTd.childNodes.forEach(function(node) {
          if (!firstTextNode && node.nodeType === 3) firstTextNode = node.textContent.trim();
        });
        if (!firstTextNode) {
          var aEl = firstTd.querySelector('a');
          firstTextNode = aEl ? aEl.textContent.trim() : firstTd.firstChild && firstTd.firstChild.textContent ? firstTd.firstChild.textContent.trim() : '';
        }
        rawName = firstTextNode.replace(/[*★\s\n\t]/g, '').substring(0, 15);
      }
      // 过滤表头行
      var skipNames = ['公司','初','即时','历史','主队','客队','盘','多盘','公司多盘'];
      if (skipNames.indexOf(rawName) >= 0 || rawName.length === 0 && !lastCompanyName) return;
      if (rawName.length === 0) rawName = lastCompanyName;
      else lastCompanyName = rawName;

      const name = rawName || ('C' + (result.companies.length + 1));

      // 列顺序固定：waters[0]=初主, waters[1]=初客, waters[2]=即主, waters[3]=即客
      currentCompany = {
        name,
        mainLine: {
          initialHome: waters[0], initialHandicap: lines[0], initialAway: waters[1],
          currentHome: waters[2], currentHandicap: lines[lines.length > 1 ? 1 : 0], currentAway: waters[3]
        },
        subLines: []
      };
      result.companies.push(currentCompany);
    });

    // 提取历史变化记录（时间线）
    result.history = extractHistory(text, 'asian');

    // 关键公司
    if (result.companies[0]) {
      result.keyOdds.ao = { ...result.companies[0] };
      result.keyOdds.ao.name = result.companies[0].name;
    }
    if (result.companies[1]) {
      result.keyOdds.crown = { ...result.companies[1] };
      result.keyOdds.crown.name = result.companies[1].name;
    }

    // 即时盘口汇总（用于多数决分析）
    result.keyOdds.allCurrent = result.companies.map(c => ({
      name: c.name,
      home: c.mainLine.currentHome,
      line: c.mainLine.currentHandicap,
      away: c.mainLine.currentAway
    }));

    // 统计主流盘口（众数）
    const lineCounts = {};
    result.keyOdds.allCurrent.forEach(c => {
      lineCounts[c.line] = (lineCounts[c.line] || 0) + 1;
    });
    result.summary.mainLine = Object.entries(lineCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || '';
    result.summary.lineConsensus = lineCounts;

    return result;
  }

  // ===================== 大小球（完整版）=====================
  function extractOverUnder(text, html) {
    const result = { companies: [], summary: {}, keyOdds: {}, allOdds: [], history: [] };

    result.summary.up   = (text.match(/升盘[_\s]*(\d+)/) || [,'0'])[1];
    result.summary.down = (text.match(/降盘[_\s]*(\d+)/) || [,'0'])[1];

    const LINE_RE = /^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/;
    const WATER_RE = /^[01]\.\d{2}$/;

    let currentCompany = null;
    let lastCompanyName = '';
    const SUB_RE2 = /^盘[2-9]$/;

    document.querySelectorAll('table tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim().replace(/\s+/g, ' '));
      if (!cells.length) return;

      const waters = cells.filter(c => WATER_RE.test(c));
      const lines  = cells.filter(c => LINE_RE.test(c) && parseFloat(c) >= 1.5 && parseFloat(c) <= 5.5);
      if (waters.length < 4 || lines.length < 1) return;

      const firstCell = cells[0] || '';
      const secondCell = cells[1] || '';
      const subLabel = SUB_RE2.test(firstCell) ? firstCell : (SUB_RE2.test(secondCell) ? secondCell : '');

      if (subLabel && currentCompany) {
        currentCompany.subLines = currentCompany.subLines || [];
        currentCompany.subLines.push({
          label: subLabel,
          initialOver: waters[0], initialLine: lines[0], initialUnder: waters[1],
          currentOver: waters[2], currentLine: lines[lines.length > 1 ? 1 : 0], currentUnder: waters[3]
        });
        return;
      }

      var firstTd2 = row.querySelectorAll('td')[0];
      var rawName = '';
      if (firstTd2) {
        var txt2 = '';
        firstTd2.childNodes.forEach(function(node) {
          if (!txt2 && node.nodeType === 3) txt2 = node.textContent.trim();
        });
        if (!txt2) { var a2 = firstTd2.querySelector('a'); txt2 = a2 ? a2.textContent.trim() : (firstTd2.firstChild ? firstTd2.firstChild.textContent.trim() : ''); }
        rawName = txt2.replace(/[*★\s\n\t]/g, '').substring(0, 15);
      }
      var skipNames2 = ['公司','初','即时','大球','小球','进球数','多盘'];
      if (skipNames2.indexOf(rawName) >= 0 || (rawName.length === 0 && !lastCompanyName)) return;
      if (rawName.length === 0) rawName = lastCompanyName;
      else lastCompanyName = rawName;

      const name = rawName || ('C' + (result.companies.length + 1));
      currentCompany = {
        name,
        mainLine: {
          initialOver: waters[0], initialLine: lines[0], initialUnder: waters[1],
          currentOver: waters[2], currentLine: lines[lines.length > 1 ? 1 : 0], currentUnder: waters[3]
        },
        subLines: []
      };
      result.companies.push(currentCompany);
      result.allOdds.push(currentCompany.mainLine);
    });

    result.history = extractHistory(text, 'ou');

    if (result.companies[0]) {
      result.keyOdds.ao    = { name: result.companies[0].name, ...result.companies[0].mainLine };
    }
    if (result.companies[1]) {
      result.keyOdds.crown = { name: result.companies[1].name, ...result.companies[1].mainLine };
    }

    // 主流进球线统计
    const lineCounts = {};
    result.companies.forEach(c => {
      const l = c.mainLine.currentLine;
      lineCounts[l] = (lineCounts[l] || 0) + 1;
    });
    result.summary.mainLine = Object.entries(lineCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || '';
    result.summary.lineConsensus = lineCounts;

    return result;
  }

  // ===================== 角球（完整版）=====================
  function extractCorner(text, html) {
    const result = { companies: [], allOdds: [], history: [] };

    const LINE_RE = /^\d{1,2}(?:\.\d)?(?:\/\d{1,2}(?:\.\d)?)?$/;
    const WATER_RE = /^[01]\.\d{2}$/;

    document.querySelectorAll('table tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim().replace(/\s+/g, ' '));
      const waters = cells.filter(c => WATER_RE.test(c));
      const lines = cells.filter(c => LINE_RE.test(c) && parseFloat(c) >= 7 && parseFloat(c) <= 14);

      if (waters.length >= 4 && lines.length >= 1) {
        const rawName = cells[0] || '';
        if (rawName.includes('公司') || rawName.includes('初') || rawName.length > 20) return;
        const name = rawName.replace(/[*★\s]/g, '').substring(0, 15) || `C${result.companies.length + 1}`;

        const entry = {
          name,
          initialOver: waters[0], initialLine: lines[0], initialUnder: waters[1],
          currentOver: waters[waters.length > 4 ? 3 : 2],
          currentLine: lines[lines.length > 1 ? 1 : 0],
          currentUnder: waters[waters.length > 4 ? 4 : 3]
        };
        result.companies.push(entry);
        result.allOdds.push(entry);
      }
    });

    if (result.companies[0]) {
      result.mainLine  = result.companies[0].currentLine;
      result.mainOver  = result.companies[0].currentOver;
      result.mainUnder = result.companies[0].currentUnder;
    }

    return result;
  }

  // ===================== 历史变化时间线 =====================
  function extractHistory(text, type) {
    const history = [];
    // 格式：5-7 09:01\n盘口名\n水位 水位  或  5-7 09:01\n进球线\n水位 水位
    const timeRe = /(\d{1,2}-\d{1,2}\s+\d{2}:\d{2})\s*\n\s*([^\n]{2,30})\s*\n\s*([\d.]+)\s+([\d.]+)/g;
    let m;
    let count = 0;
    while ((m = timeRe.exec(text)) !== null && count < 50) {
      history.push({
        time: m[1].trim(),
        line: m[2].trim(),
        v1: m[3],
        v2: m[4]
      });
      count++;
    }
    return history;
  }
}

async function startMonitor(matchId, intervalMin) {
  const alarmName = `monitor_${matchId}`;
  monitorTasks[matchId] = { alarmName, intervalMin };
  await chrome.storage.local.set({ monitorTasks });
  chrome.alarms.create(alarmName, { periodInMinutes: intervalMin });
  await runMonitorCycle(matchId);
  console.log(`[BG] Monitor started for ${matchId}`);
}

async function stopMonitor(matchId) {
  chrome.alarms.clear(`monitor_${matchId}`);
  delete monitorTasks[matchId];
  await chrome.storage.local.set({ monitorTasks });
}

async function runMonitorCycle(matchId) {
  try {
    const data = await collectViaTabInjection(matchId);
    if (!data) return;
    const prev = monitorTasks[matchId]?.lastData;
    if (prev) {
      const changes = detectChanges(prev, data);
      if (changes.length > 0) notifyChanges(matchId, changes, data);
    }
    if (monitorTasks[matchId]) monitorTasks[matchId].lastData = data;
    await storeData(matchId, data);
  } catch (err) {
    console.error(`[BG] Monitor cycle error:`, err);
  }
}

function detectChanges(prev, curr) {
  const changes = [];
  const pa = prev.asian?.keyOdds?.ao, ca = curr.asian?.keyOdds?.ao;
  if (pa && ca && pa.currentHandicap !== ca.currentHandicap)
    changes.push({ type: 'asian', from: pa.currentHandicap, to: ca.currentHandicap });
  const po = prev.overunder?.keyOdds?.ao, co = curr.overunder?.keyOdds?.ao;
  if (po && co && po.currentLine !== co.currentLine)
    changes.push({ type: 'ou', from: po.currentLine, to: co.currentLine });
  return changes;
}

function notifyChanges(matchId, changes, data) {
  const home = data.analysis?.matchInfo?.home || matchId;
  const away = data.analysis?.matchInfo?.away || '';
  chrome.notifications.create(`chg_${matchId}_${Date.now()}`, {
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: `⚽ ${home}${away ? ' vs ' + away : ''} 盘口变动`,
    message: changes.map(c => c.type === 'asian' ? `亚让: ${c.from}→${c.to}` : `大小球: ${c.from}→${c.to}`).join('\n')
  });
}

async function storeData(matchId, data) {
  await chrome.storage.local.set({ [`match_${matchId}`]: { matchId, fetchTime: Date.now(), data } });
}

async function getStoredData(matchId) {
  const r = await chrome.storage.local.get(`match_${matchId}`);
  return r[`match_${matchId}`] || null;
}

async function restoreMonitorTasks() {
  const r = await chrome.storage.local.get('monitorTasks');
  if (r.monitorTasks) {
    monitorTasks = r.monitorTasks;
    for (const [, task] of Object.entries(monitorTasks)) {
      chrome.alarms.create(task.alarmName, { periodInMinutes: task.intervalMin });
    }
  }
}
