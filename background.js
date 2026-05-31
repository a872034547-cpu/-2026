// Background Service Worker - Tab注入为主，后台fetch为辅

import { Predictor, PredictionLogger } from './js/predictor.js';
import { ReportGenerator } from './js/report.js';
import { AIClient } from './js/ai-client.js';
import { calcProfitabilityScore, parseTodayMatchesFromHtml, buildBatchAIPrompt, parseAIBetAdvice, getLeaguePriority } from './js/daily-analyzer.js';

const predictor = new Predictor();
const reportGen = new ReportGenerator();
const aiClient = new AIClient();

let monitorTasks = {};
let panelWindowId = null; // 固定面板窗口ID

// 点击图标打开固定独立窗口（不会自动消失）
chrome.action.onClicked.addListener(async () => {
  // 如果窗口已存在，聚焦它
  if (panelWindowId !== null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true });
      return;
    } catch {
      panelWindowId = null; // 窗口已关闭，重新创建
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 560,
    height: 800,
    top: 80,
    left: 80
  });
  panelWindowId = win.id;
  // 监听窗口关闭，清除ID
  chrome.windows.onRemoved.addListener(function onRemoved(id) {
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
  if (dataType === 'winDrawWinStats') {
    partial.winDrawWin = mergeWinDrawWinStats(partial.winDrawWin, data);
  } else if (dataType === 'winDrawWin') {
    partial.winDrawWin = partial.winDrawWin?.statistics
      ? mergeWinDrawWinStats(data, partial.winDrawWin.statistics)
      : finalizeWinDrawWin(data);
  } else {
    partial[dataType] = data;
  }
  partial._updated = Date.now();

  await chrome.storage.local.set({ [key]: partial });

  const types = ['analysis', 'winDrawWin', 'asian', 'overunder', 'corner'];
  const filled = types.filter(t => partial[t] && !partial[t].error);

  console.log(`[BG] PageData ${matchId}/${dataType}: ${filled.length}/${types.length} ready`);

  // 5种数据到齐后合并存储
  if (filled.length === types.length) {
    const fullData = {
      matchId, fetchTime: new Date().toISOString(),
      analysis: partial.analysis,
      winDrawWin: finalizeWinDrawWin(partial.winDrawWin),
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
        // 主方法：打开5个标签页，通过content script采集DOM
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

      // ===== 滚球实时数据采集 =====
      case 'FETCH_LIVE_DATA': {
        const { matchId } = msg;
        const liveData = await collectLiveData(matchId);
        if (liveData) {
          await chrome.storage.local.set({ [`live_${matchId}`]: { matchId, fetchTime: Date.now(), data: liveData } });
          sendResponse({ ok: true, data: liveData });
        } else {
          sendResponse({ ok: false, error: '滚球数据采集失败' });
        }
        break;
      }

      case 'GET_LIVE_DATA': {
        const r = await chrome.storage.local.get(`live_${msg.matchId}`);
        sendResponse({ ok: true, data: r[`live_${msg.matchId}`] || null });
        break;
      }

      // ===== 今日比赛分析 =====
      case 'FETCH_TODAY_MATCHES': {
        const matches = await fetchTodayMatches();
        sendResponse({ ok: true, matches });
        break;
      }

      case 'FETCH_MATCH_QUICK_DATA': {
        // 快速采集单场比赛盘口（只采集亚盘+欧赔+大小球，不采集analysis）
        const { matchId } = msg;
        try {
          const sources = [
            { type: 'winDrawWin', url: `https://1x2.titan007.com/oddslist/${matchId}.htm` },
            { type: 'asian',      url: `https://vip.titan007.com/AsianOdds_n.aspx?id=${matchId}&l=0` },
            { type: 'overunder',  url: `https://vip.titan007.com/OverDown_n.aspx?id=${matchId}&l=0` }
          ];
          const results = await Promise.allSettled(sources.map(s => extractOneTab(s.url, s.type)));
          const data = { matchId, fetchTime: new Date().toISOString() };
          sources.forEach((s, i) => {
            data[s.type] = results[i].status === 'fulfilled' ? results[i].value : { error: results[i].reason?.message };
          });
          if (data.winDrawWin && !data.winDrawWin.error) {
            data.winDrawWin = finalizeWinDrawWin(data.winDrawWin);
          }
          const profitability = calcProfitabilityScore(data);
          sendResponse({ ok: true, data, profitability });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }

      case 'GET_DAILY_RECORDS': {
        const r = await chrome.storage.local.get('daily_records');
        sendResponse({ ok: true, records: r.daily_records || [] });
        break;
      }

      case 'GET_BET_RECORDS': {
        // 获取投注记录（高价值/中高价值自动提取的结构化记录）
        const r = await chrome.storage.local.get('bet_records');
        sendResponse({ ok: true, records: r.bet_records || [] });
        break;
      }

      case 'SAVE_BET_RECORDS': {
        // 保存结构化投注记录（自动提取的高/中高价值）
        const { betRecords } = msg;
        const r = await chrome.storage.local.get('bet_records');
        const existing = r.bet_records || [];
        // 合并新记录（按 id 去重）
        const newIds = new Set(betRecords.map(b => b.id));
        const merged = [...betRecords, ...existing.filter(b => !newIds.has(b.id))];
        // 最多保留500条
        while (merged.length > 500) merged.pop();
        await chrome.storage.local.set({ bet_records: merged });
        sendResponse({ ok: true, count: betRecords.length });
        break;
      }

      case 'UPDATE_BET_RECORD': {
        // 更新单条投注记录的验证结果
        const { id, actualScore, betResult } = msg;
        const r = await chrome.storage.local.get('bet_records');
        const records = r.bet_records || [];
        const rec = records.find(x => x.id === id);
        if (rec) {
          if (actualScore !== undefined) rec.actualScore = actualScore;
          if (betResult !== undefined) rec.betResult = betResult;
        }
        await chrome.storage.local.set({ bet_records: records });
        sendResponse({ ok: true });
        break;
      }

      case 'DELETE_BET_RECORD': {
        // 删除单条投注记录
        const { id } = msg;
        const r = await chrome.storage.local.get('bet_records');
        const records = (r.bet_records || []).filter(x => x.id !== id);
        await chrome.storage.local.set({ bet_records: records });
        sendResponse({ ok: true });
        break;
      }

      case 'DELETE_BET_RECORDS_BY_DATE': {
        // 按日期删除一批记录
        const { date } = msg;
        const r = await chrome.storage.local.get('bet_records');
        const records = (r.bet_records || []).filter(x => x.date !== date);
        await chrome.storage.local.set({ bet_records: records });
        sendResponse({ ok: true });
        break;
      }

      case 'VERIFY_BET_RECORD': {
        // 自动采集比分，判断投注是否命中
        const { matchId: vMatchId, betType, selection } = msg;
        try {
          // 采集analysis页获取比分
          const analysisData = await extractOneTab(
            `https://zq.titan007.com/analysis/${vMatchId}cn.htm`, 'analysis'
          );
          const score = analysisData?.matchInfo?.score || analysisData?.matchInfo?.currentScore || '';
          let betResult = '';
          let autoJudge = '';

          if (score) {
            const scoreM = score.match(/(\d+)\s*[-:]\s*(\d+)/);
            if (scoreM) {
              const homeGoals = parseInt(scoreM[1]);
              const awayGoals = parseInt(scoreM[2]);
              const totalGoals = homeGoals + awayGoals;
              const diff = homeGoals - awayGoals; // 主队净胜球

              const bt = betType.toLowerCase();
              const sel = selection.replace(/\s+/g, '');

              // 大小球判断
              if (bt.includes('大小') || bt.includes('over') || bt.includes('大球')) {
                const lineM = sel.match(/(大|小|over|under)[\s]*([\d.]+)/i);
                if (lineM) {
                  const line = parseFloat(lineM[2]);
                  const isBig = /大|over/i.test(lineM[1]);
                  if (isBig) betResult = totalGoals > line ? '✓' : totalGoals < line ? '✗' : '';
                  else betResult = totalGoals < line ? '✓' : totalGoals > line ? '✗' : '';
                  autoJudge = `总进球${totalGoals}，盘口${line}`;
                }
              }
              // 亚盘判断
              else if (bt.includes('亚盘') || bt.includes('让球')) {
                const handicapM = sel.match(/([+-]?[\d.]+)(?:\/[\d.]+)?/);
                const isHome = /主|home/i.test(sel) || (!/(客|away)/i.test(sel) && !sel.includes('-'));
                if (handicapM) {
                  const h = parseFloat(handicapM[1]);
                  const adjustedDiff = isHome ? diff + h : -diff + h;
                  if (adjustedDiff > 0) betResult = '✓';
                  else if (adjustedDiff < 0) betResult = '✗';
                  autoJudge = `比分${homeGoals}-${awayGoals}，让${h}后差${adjustedDiff.toFixed(2)}`;
                }
              }
              // 角球（需要角球数据，这里只记录比分）
              else {
                autoJudge = `比分 ${homeGoals}-${awayGoals}，需手动判断`;
              }
            }
          }

          // 自动保存判断结果
          if (betResult) {
            const r2 = await chrome.storage.local.get('bet_records');
            const recs = r2.bet_records || [];
            const rec = recs.find(x => x.matchId === vMatchId &&
              x.betType === betType && x.selection === selection);
            if (rec) {
              rec.actualScore = score;
              rec.betResult = betResult;
              await chrome.storage.local.set({ bet_records: recs });
            }
          }

          sendResponse({ ok: true, score, betResult, autoJudge });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }

      case 'SAVE_DAILY_AI_RESULT': {
        // 保存AI对今日比赛的分析结果（永久持久化）
        const { date, matches, aiContent, aiAdvices } = msg;
        const r = await chrome.storage.local.get('daily_records');
        const records = r.daily_records || [];
        const existIdx = records.findIndex(x => x.date === date);
        const entry = {
          date,
          createdAt: Date.now(),
          matches: matches || [],
          aiContent: aiContent || '',
          aiAdvices: aiAdvices || []
        };
        if (existIdx >= 0) records[existIdx] = { ...records[existIdx], ...entry };
        else records.unshift(entry);
        // 最多保留90天
        while (records.length > 90) records.pop();
        await chrome.storage.local.set({ daily_records: records });
        sendResponse({ ok: true });
        break;
      }

      case 'UPDATE_DAILY_MATCH_RESULT': {
        // 更新比赛结果（赛后验证用）
        const { date, matchId, actualScore, actualResult, betResult } = msg;
        const r = await chrome.storage.local.get('daily_records');
        const records = r.daily_records || [];
        const rec = records.find(x => x.date === date);
        if (rec) {
          const match = rec.matches.find(m => m.id === matchId);
          if (match) {
            match.actualScore = actualScore || '';
            match.actualResult = actualResult || '';
            match.betResult = betResult || ''; // √ 或 ×
            match.verifiedAt = Date.now();
          }
          const advice = rec.aiAdvices?.find(a => a.matchId === matchId);
          if (advice) {
            advice.betResult = betResult || '';
            advice.actualScore = actualScore || '';
          }
          await chrome.storage.local.set({ daily_records: records });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'AI_DAILY_BATCH': {
        // 批量AI分析今日比赛（笼统批量，保留兼容）
        const { matchItems } = msg;
        const prompt = buildBatchAIPrompt(matchItems);
        try {
          const reply = await aiClient.chat(
            [{ role: 'user', content: prompt }],
            `今日足球比赛分析助手，请提供专业的投注建议`
          );
          if (reply.error) {
            sendResponse({ ok: false, error: reply.error });
          } else {
            const advices = parseAIBetAdvice(reply.content, matchItems);
            sendResponse({ ok: true, content: reply.content, advices });
          }
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }

      case 'AI_DAILY_SINGLE': {
        // 单场详细分析（用于今日赛事勾选批量）
        const { matchId: dmId, matchData, matchInfo } = msg;
        try {
          // 构造与 getStoredData 兼容的结构，用 reportGen 生成报告
          const pseudoStored = {
            matchId: dmId,
            fetchTime: new Date().toISOString(),
            data: {
              matchId: dmId,
              fetchTime: new Date().toISOString(),
              analysis: {
                matchInfo: {
                  home: matchInfo?.home || '主队',
                  away: matchInfo?.away || '客队',
                  league: matchInfo?.league || '',
                  time: matchInfo?.time || ''
                }
              },
              winDrawWin: matchData?.winDrawWin || {},
              asian: matchData?.asian || {},
              overunder: matchData?.overunder || {}
            }
          };
          const report = reportGen.generate(pseudoStored);
          const prediction = await aiClient.predict(report, dmId);
          sendResponse({ ok: true, prediction, reportMarkdown: report.markdown });
        } catch (e) {
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

// ===== 核心：通过标签页注入采集6个数据源 =====
async function collectViaTabInjection(matchId) {
  const sources = [
    { type: 'analysis',        url: `https://zq.titan007.com/analysis/${matchId}cn.htm` },
    { type: 'winDrawWin',      url: `https://1x2.titan007.com/oddslist/${matchId}.htm` },
    { type: 'winDrawWinStats', url: `https://vip.titan007.com/count/goalCount.aspx?t=5&sid=${matchId}&cid=281` },
    { type: 'asian',           url: `https://vip.titan007.com/AsianOdds_n.aspx?id=${matchId}&l=0` },
    { type: 'overunder',       url: `https://vip.titan007.com/OverDown_n.aspx?id=${matchId}&l=0` },
    { type: 'corner',          url: `https://vip.titan007.com/Corner.aspx?id=${matchId}&l=0` }
  ];

  const results = await Promise.allSettled(sources.map(s => extractOneTab(s.url, s.type)));

  const data = { matchId, fetchTime: new Date().toISOString() };
  sources.forEach((s, i) => {
    data[s.type] = results[i].status === 'fulfilled' && results[i].value
      ? results[i].value
      : { error: results[i].reason?.message || '采集失败' };
  });

  if (data.winDrawWinStats && !data.winDrawWinStats.error) {
    data.winDrawWin = mergeWinDrawWinStats(data.winDrawWin, data.winDrawWinStats);
  }
  data.winDrawWin = finalizeWinDrawWin(data.winDrawWin);
  delete data.winDrawWinStats;

  const hasAnyData = ['analysis', 'winDrawWin', 'asian', 'overunder', 'corner']
    .some(type => data[type] && !data[type].error);
  return hasAnyData ? data : null;
}

function wdwClean(v) { return String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(); }
function wdwCompact(v) { return wdwClean(v).replace(/\s+/g, ''); }
function wdwFmt(n) { return isFinite(n) ? Number(n).toFixed(2) : ''; }
function wdwFmtPct(n) { return isFinite(n) ? (Number(n) * 100).toFixed(2) + '%' : ''; }
function wdwCalcReturnRate(win, draw, loss) {
  win = parseFloat(win); draw = parseFloat(draw); loss = parseFloat(loss);
  if (!(win > 0 && draw > 0 && loss > 0)) return null;
  return win * draw * loss / (win * draw + draw * loss + win * loss);
}
function wdwCalcProbabilities(win, draw, loss) {
  const rate = wdwCalcReturnRate(win, draw, loss);
  win = parseFloat(win); draw = parseFloat(draw); loss = parseFloat(loss);
  if (!rate || !(win > 0 && draw > 0 && loss > 0)) return null;
  return {
    win: wdwFmtPct(rate / win),
    draw: wdwFmtPct(rate / draw),
    loss: wdwFmtPct(rate / loss),
    returnRate: wdwFmtPct(rate),
    _decimal: { win: rate / win, draw: rate / draw, loss: rate / loss }
  };
}
function wdwRecentChange(timeText) {
  const m = String(timeText || '').match(/(?:(\d{4})[-\/])?(\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return false;
  const now = new Date();
  const y = m[1] ? parseInt(m[1], 10) : now.getFullYear();
  const dt = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10));
  let diff = now.getTime() - dt.getTime();
  if (diff < -24 * 60 * 60 * 1000 && !m[1]) dt.setFullYear(y - 1);
  diff = now.getTime() - dt.getTime();
  return diff >= 0 && diff <= 30 * 60 * 1000;
}
function isWdwSkipName(name) {
  name = wdwCompact(name);
  if (!name) return true;
  return /^(公司|所有|主流|交易所|非交易所|初|即|主|和|客|主胜|客胜|返还率|凯利指数|变化时间|历史指数|筛选|设置自定义)$/.test(name) ||
    /初盘|即时|最高值|最低值|平均值|高级筛选|删除选中|保留选中|导出Excel|欧亚转换|主胜率|和率|平率|客胜率|概率|返还|凯利|变化时间/.test(name);
}
function normalizeWdwCompanyName(raw) {
  let name = wdwCompact(raw).replace(/[×√□☑★]/g, '');
  name = name.replace(/^[\s\-:：]+/, '');
  if (!/^\d+\*?[（(][^）)]{1,20}[）)]$/.test(name)) {
    name = name.replace(/^[\d一二三四五六七八九十]+[、.．\-]\s*/, '');
  }
  name = name.replace(/\[[^\]]*\]/g, '')
    .replace(/[【】]/g, '')
    .replace(/(走势|详情|历史|主流|交易所|非交易所)$/g, '')
    .trim();
  return name.length > 24 ? name.substring(0, 24) : name;
}
function isValidWdwCompanyName(name) {
  name = normalizeWdwCompanyName(name);
  if (!name || name.length > 24) return false;
  if (/^\d+(?:\.\d+)?%?$/.test(name)) return false;
  if (/^[（(][^）)]*[）)]$/.test(name)) return false;
  if (/^[\d\s]+$/.test(name)) return false;
  if (isWdwSkipName(name)) return false;
  return /[\u4e00-\u9fa5A-Za-z]/.test(name) || /^\d+\*?[（(][^）)]{1,20}[）)]$/.test(name);
}
function wdwCompanyKey(name) {
  name = normalizeWdwCompanyName(name).toLowerCase();
  const stat = name.match(/^(\d+)\*?[（(]([^）)]{1,20})[）)]$/);
  if (stat) return `${stat[1]}:${stat[2]}`;
  return name.replace(/[\s*＊★]/g, '');
}
function isWdwOddsValue(v) {
  const n = parseFloat(v);
  return isFinite(n) && n >= 1.01 && n <= 30;
}
function isValidWdwTriple(win, draw, loss) {
  if (!isWdwOddsValue(win) || !isWdwOddsValue(draw) || !isWdwOddsValue(loss)) return false;
  const rate = wdwCalcReturnRate(win, draw, loss);
  return !!rate && rate >= 0.70 && rate <= 1.05;
}
function wdwTripleFrom(entry, prefix) {
  const keys = prefix === 'initial'
    ? ['initialWin', 'initialDraw', 'initialLoss']
    : ['currentWin', 'currentDraw', 'currentLoss'];
  if (!isValidWdwTriple(entry[keys[0]], entry[keys[1]], entry[keys[2]])) return null;
  return {
    win: wdwFmt(parseFloat(entry[keys[0]])),
    draw: wdwFmt(parseFloat(entry[keys[1]])),
    loss: wdwFmt(parseFloat(entry[keys[2]]))
  };
}
function mergeWdwCompany(target, src) {
  const preferred = /goal-count|stat/.test(String(src.source || ''));
  const fields = ['initialWin', 'initialDraw', 'initialLoss', 'currentWin', 'currentDraw', 'currentLoss'];
  fields.forEach(f => {
    if (src[f] && (preferred || !target[f])) target[f] = src[f];
  });
  if (src.changeTime && !target.changeTime) target.changeTime = src.changeTime;
  if (src.statSample) target.statSample = src.statSample;
  if (src.source && target.source !== src.source) {
    target.source = Array.from(new Set([target.source, src.source].filter(Boolean))).join('+');
  }
}
function finalizeWinDrawWin(winDrawWin) {
  if (!winDrawWin || winDrawWin.error) return winDrawWin;
  const data = winDrawWin;
  data.summary = data.summary || {};
  data.keyOdds = data.keyOdds || {};

  const byKey = new Map();
  const order = [];
  (Array.isArray(data.companies) ? data.companies : []).forEach(src => {
    const name = normalizeWdwCompanyName(src.name);
    if (!isValidWdwCompanyName(name)) return;
    const item = { ...src, name };
    const initial = wdwTripleFrom(item, 'initial');
    const current = wdwTripleFrom(item, 'current');
    if (initial) {
      item.initialWin = initial.win; item.initialDraw = initial.draw; item.initialLoss = initial.loss;
    } else {
      delete item.initialWin; delete item.initialDraw; delete item.initialLoss;
    }
    if (current) {
      item.currentWin = current.win; item.currentDraw = current.draw; item.currentLoss = current.loss;
    } else if (initial) {
      item.currentWin = initial.win; item.currentDraw = initial.draw; item.currentLoss = initial.loss;
    } else {
      return;
    }
    const key = wdwCompanyKey(name);
    if (!byKey.has(key)) {
      byKey.set(key, item);
      order.push(key);
    } else {
      mergeWdwCompany(byKey.get(key), item);
    }
  });

  data.companies = order.map(key => byKey.get(key)).filter(Boolean);
  const statKey = data.statistics?.company ? wdwCompanyKey(data.statistics.company) : '';
  if (statKey) {
    data.companies.sort((a, b) => (wdwCompanyKey(a.name) === statKey ? -1 : 0) - (wdwCompanyKey(b.name) === statKey ? -1 : 0));
  }

  const avg = rows => {
    rows = rows.filter(x => x && isValidWdwTriple(x.win, x.draw, x.loss));
    if (!rows.length) return null;
    const sum = rows.reduce((acc, x) => {
      acc.win += parseFloat(x.win);
      acc.draw += parseFloat(x.draw);
      acc.loss += parseFloat(x.loss);
      return acc;
    }, { win: 0, draw: 0, loss: 0 });
    return { win: wdwFmt(sum.win / rows.length), draw: wdwFmt(sum.draw / rows.length), loss: wdwFmt(sum.loss / rows.length) };
  };

  data.summary.averageCurrent = avg(data.companies.map(c => ({ win: c.currentWin, draw: c.currentDraw, loss: c.currentLoss })));
  data.summary.averageInitial = avg(data.companies.map(c => ({ win: c.initialWin, draw: c.initialDraw, loss: c.initialLoss })));
  const movement = { winDown: 0, winUp: 0, drawDown: 0, drawUp: 0, lossDown: 0, lossUp: 0 };
  data.companies.forEach(c => {
    const iw = parseFloat(c.initialWin), cw = parseFloat(c.currentWin);
    const id = parseFloat(c.initialDraw), cd = parseFloat(c.currentDraw);
    const il = parseFloat(c.initialLoss), cl = parseFloat(c.currentLoss);
    if (isFinite(iw) && isFinite(cw)) { if (cw < iw) movement.winDown++; else if (cw > iw) movement.winUp++; }
    if (isFinite(id) && isFinite(cd)) { if (cd < id) movement.drawDown++; else if (cd > id) movement.drawUp++; }
    if (isFinite(il) && isFinite(cl)) { if (cl < il) movement.lossDown++; else if (cl > il) movement.lossUp++; }
  });
  data.summary.count = data.companies.length;
  data.summary.movement = movement;

  let marketProbability = null;
  if (data.summary.averageCurrent) {
    const mp = wdwCalcProbabilities(data.summary.averageCurrent.win, data.summary.averageCurrent.draw, data.summary.averageCurrent.loss);
    if (mp) {
      marketProbability = mp._decimal;
      data.summary.impliedAverage = { win: mp.win, draw: mp.draw, loss: mp.loss };
      data.summary.averageReturnRate = mp.returnRate;
    }
  }

  data.companies.forEach(c => {
    const cp = wdwCalcProbabilities(c.currentWin, c.currentDraw, c.currentLoss);
    if (cp) {
      c.returnRate = cp.returnRate;
      c.currentReturnRate = cp.returnRate;
      c.probabilities = { win: cp.win, draw: cp.draw, loss: cp.loss };
      c.currentProbabilities = c.probabilities;
    }
    const ip = wdwCalcProbabilities(c.initialWin, c.initialDraw, c.initialLoss);
    if (ip) {
      c.initialReturnRate = ip.returnRate;
      c.initialProbabilities = { win: ip.win, draw: ip.draw, loss: ip.loss };
    }
    if (marketProbability && isValidWdwTriple(c.currentWin, c.currentDraw, c.currentLoss)) {
      const kw = marketProbability.win * parseFloat(c.currentWin);
      const kd = marketProbability.draw * parseFloat(c.currentDraw);
      const kl = marketProbability.loss * parseFloat(c.currentLoss);
      c.kelly = { win: wdwFmt(kw), draw: wdwFmt(kd), loss: wdwFmt(kl) };
      c.kellyRisk = { win: kw > 1, draw: kd > 1, loss: kl > 1 };
    } else {
      delete c.kelly;
      delete c.kellyRisk;
    }
    c.recent30 = c.changeTime ? wdwRecentChange(c.changeTime) : false;
  });

  data.allOdds = data.companies;
  data.keyOdds.allCurrent = data.companies.map(c => ({ name: c.name, win: c.currentWin, draw: c.currentDraw, loss: c.currentLoss }));
  data.keyOdds.ao = data.companies[0] ? { name: data.companies[0].name, ...data.companies[0] } : null;
  data.keyOdds.crown = data.companies[1] ? { name: data.companies[1].name, ...data.companies[1] } : null;
  return data;
}

function mergeWinDrawWinStats(winDrawWin, stats) {
  if (!stats || stats.error) return finalizeWinDrawWin(winDrawWin);
  const data = winDrawWin && !winDrawWin.error
    ? winDrawWin
    : { companies: [], summary: {}, keyOdds: {}, history: [] };

  data.companies = Array.isArray(data.companies) ? data.companies : [];
  data.summary = data.summary || {};
  data.keyOdds = data.keyOdds || {};
  data.statistics = stats;

  const initial = stats.rows?.find(r => r.type === 'initial');
  const current = stats.rows?.find(r => r.type === 'current');
  if (initial || current) {
    const companyName = normalizeWdwCompanyName(stats.company || '36*(英国)') || '36*(英国)';
    const statKey = wdwCompanyKey(companyName);
    let entry = data.companies.find(c => wdwCompanyKey(c.name) === statKey);
    if (!entry) {
      entry = { name: companyName, source: 'goal-count-stat' };
      data.companies.unshift(entry);
    }
    entry.name = companyName;
    entry.source = /goal-count|stat/.test(String(entry.source || '')) ? entry.source : `${entry.source || 'table'}+goal-count-stat`;
    if (initial) {
      entry.initialWin = initial.win;
      entry.initialDraw = initial.draw;
      entry.initialLoss = initial.loss;
      entry.initialReturnRate = initial.returnRate;
      entry.initialProbabilities = initial.probabilities;
    }
    if (current) {
      entry.currentWin = current.win;
      entry.currentDraw = current.draw;
      entry.currentLoss = current.loss;
      entry.currentReturnRate = current.returnRate;
      entry.currentProbabilities = current.probabilities;
    }
    entry.statSample = {
      total: current?.total || initial?.total || '',
      winCount: current?.winCount || initial?.winCount || '',
      drawCount: current?.drawCount || initial?.drawCount || '',
      lossCount: current?.lossCount || initial?.lossCount || ''
    };
  }

  return finalizeWinDrawWin(data);
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

        // analysis / 1x2 页面内容通过 Ajax 异步加载，需分阶段等待
        const waitMs = dataType === 'analysis' ? 6000 : (dataType === 'winDrawWin' ? 5000 : 2500);

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
            // 1x2 欧赔页经常由脚本延迟填表，公司列表为空时再等待一次
            if (dataType === 'winDrawWin' && (!result || result.error || !Array.isArray(result.companies) || result.companies.length === 0) && attempt < 2) {
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
    let text = document.body.innerText || '';
    const html = document.documentElement.outerHTML || '';
    // 触发懒加载：滚动到底部再回顶部
    window.scrollTo(0, document.body.scrollHeight);
    window.scrollTo(0, 0);

    // 重新获取最新 text（滚动后内容可能已更新）
    var freshText = document.body.innerText || '';
    if (freshText.length > text.length) text = freshText;

    if (dataType === 'analysis') return extractAnalysis(text, html);
    if (dataType === 'winDrawWin') return extractWinDrawWin(text, html);
    if (dataType === 'winDrawWinStats') return extractWinDrawWinStats(text, html);
    if (dataType === 'asian')    return extractAsian(text, html);
    if (dataType === 'overunder')return extractOverUnder(text, html);
    if (dataType === 'corner')   return extractCorner(text, html);
    if (dataType === 'live')     return extractLiveData(text, html);
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
        if (lbl==='总' && /^\d+$/.test(cells[1]) && parseInt(cells[1])>=1) {
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
      // 有 total 行即算有效战绩表（国际赛可能没有主客场分项）
      return statsObj.total ? statsObj : null;
    };

    var statsTables = [];
    var allTables = document.querySelectorAll('table');
    for (var ti=0; ti<allTables.length; ti++) {
      var ttext = allTables[ti].textContent;
      // 含"总"和"胜"即可能是战绩表（国际赛可能没有"近6"）
      if (ttext.indexOf('总')>=0 && ttext.indexOf('胜')>=0 && /\d{1,3}/.test(ttext)) {
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
    var rm;
    var compact = function(v) { return (v || '').replace(/\s+/g, '').trim(); };
    var pctFromText = function(v) {
      var m = String(v || '').match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      return m ? m[1] : '';
    };
    var getCells = function(row) {
      var nodes = row.querySelectorAll('th,td');
      var cells = [];
      for (var ci = 0; ci < nodes.length; ci++) cells.push(nodes[ci].textContent.trim().replace(/\s+/g, ' '));
      return cells;
    };
    var hasTrendData = function(trend) {
      return !!(trend && (
        (trend.winRates && trend.winRates.some(Boolean)) ||
        (trend.bigBallRates && trend.bigBallRates.some(Boolean)) ||
        trend.last6Asian || trend.last6OU || trend.last6HalfAsian
      ));
    };
    var rowLabel = function(cells, rowText) {
      var first = compact(cells[0] || '');
      if (/近6|近六/.test(rowText) || first === '近6' || first === '近6场') return 'last6';
      if (first === '总' || first === '全部' || first === '全场') return 'total';
      if (first === '主' || first === '主场') return 'home';
      if (first === '客' || first === '客场') return 'away';
      return '';
    };
    var getHeaderIndex = function(headers, words) {
      for (var hi = 0; hi < headers.length; hi++) {
        var h = compact(headers[hi]);
        for (var wi = 0; wi < words.length; wi++) {
          if (h.indexOf(words[wi]) >= 0) return hi;
        }
      }
      return -1;
    };
    var getRateByIndex = function(cells, idx) {
      if (idx < 0) return '';
      return pctFromText(cells[idx]) || pctFromText(cells[idx + 1]) || pctFromText(cells[idx - 1]);
    };
    var oneCharSeq = function(cells, re) {
      var out = [];
      for (var si = 0; si < cells.length; si++) {
        var c = compact(cells[si]);
        if (re.test(c)) out.push(c);
      }
      return out.length >= 3 ? out.join(' ') : '';
    };
    var toTrend = function(parsed, owner) {
      var venueBig = owner === 'away' ? (parsed.big.away || parsed.big.home) : (parsed.big.home || parsed.big.away);
      return {
        winRates: [parsed.win.total || '', parsed.win.home || '', parsed.win.away || '', parsed.win.last6 || ''],
        bigBallRates: [parsed.big.total || '', venueBig || '', parsed.big.last6 || ''],
        last6Asian: parsed.last6Asian || '',
        last6OU: parsed.last6OU || '',
        source: parsed.source || ''
      };
    };
    var parseTrendTable = function(tbl) {
      var rows = Array.from(tbl.querySelectorAll('tr'));
      var parsed = { win: {}, big: {}, last6Asian: '', last6OU: '', source: 'table' };
      var headers = [];
      for (var ri = 0; ri < Math.min(rows.length, 4); ri++) {
        var hc = getCells(rows[ri]);
        if (hc.join(' ').indexOf('赢盘率') >= 0 || hc.join(' ').indexOf('大球率') >= 0) {
          headers = hc;
          break;
        }
      }
      var winIdx = getHeaderIndex(headers, ['赢盘率', '赢率']);
      var bigIdx = getHeaderIndex(headers, ['大球率']);
      for (var r = 0; r < rows.length; r++) {
        var cells = getCells(rows[r]);
        if (!cells.length) continue;
        var rowText = cells.join(' ');
        var rowCompact = compact(rowText);
        var label = rowLabel(cells, rowCompact);
        if (!label) continue;

        var winRate = getRateByIndex(cells, winIdx);
        var bigRate = getRateByIndex(cells, bigIdx);
        var winLabelPos = rowText.indexOf('赢盘率');
        var bigLabelPos = rowText.indexOf('大球率');
        if (!winRate && winLabelPos >= 0) winRate = pctFromText(rowText.slice(winLabelPos));
        if (!bigRate && bigLabelPos >= 0) bigRate = pctFromText(rowText.slice(bigLabelPos));
        if (!winRate && rowCompact.indexOf('赢盘') >= 0) {
          var pcts = rowText.match(/\d{1,3}(?:\.\d+)?\s*%/g) || [];
          if (pcts.length) winRate = pctFromText(pcts[pcts.length - 1]);
        }
        if (!bigRate && rowCompact.indexOf('大球') >= 0) {
          var bigPcts = rowText.match(/\d{1,3}(?:\.\d+)?\s*%/g) || [];
          if (bigPcts.length) bigRate = pctFromText(bigPcts[bigPcts.length - 1]);
        }
        if (winRate) parsed.win[label] = winRate;
        if (bigRate) parsed.big[label] = bigRate;
        if (label === 'last6') {
          parsed.last6Asian = parsed.last6Asian || oneCharSeq(cells, /^[赢输走]$/);
          parsed.last6OU = parsed.last6OU || oneCharSeq(cells, /^[大小走]$/);
        }
      }
      return (Object.keys(parsed.win).length || Object.keys(parsed.big).length || parsed.last6Asian || parsed.last6OU) ? parsed : null;
    };
    var tableOwner = function(tbl) {
      var homeName = result.matchInfo.home || '';
      var awayName = result.matchInfo.away || '';
      var ctx = '';
      var node = tbl.previousElementSibling;
      for (var step = 0; node && step < 8; step++, node = node.previousElementSibling) ctx += ' ' + node.textContent;
      var tblText = tbl.textContent || '';
      var near = ctx || tblText;
      if (homeName && near.indexOf(homeName) >= 0 && (!awayName || near.indexOf(awayName) < 0)) return 'home';
      if (awayName && near.indexOf(awayName) >= 0 && (!homeName || near.indexOf(homeName) < 0)) return 'away';
      return '';
    };

    var trendTables = [];
    for (var tti = 0; tti < allTables.length; tti++) {
      var tt = allTables[tti].textContent || '';
      if (!/(赢盘率|大球率|近6场盘路走势|盘路走势)/.test(tt)) continue;
      var parsedTrend = parseTrendTable(allTables[tti]);
      if (parsedTrend) trendTables.push({ owner: tableOwner(allTables[tti]), parsed: parsedTrend, idx: tti });
    }
    result._debug.trendTables = trendTables.map(function(x) { return { idx: x.idx, owner: x.owner, win: x.parsed.win, big: x.parsed.big }; });

    var pendingTrendTables = [];
    for (var pt = 0; pt < trendTables.length; pt++) {
      if (trendTables[pt].owner === 'home' && !hasTrendData(result.handicapTrend.home)) {
        result.handicapTrend.home = toTrend(trendTables[pt].parsed, 'home');
      } else if (trendTables[pt].owner === 'away' && !hasTrendData(result.handicapTrend.away)) {
        result.handicapTrend.away = toTrend(trendTables[pt].parsed, 'away');
      } else {
        pendingTrendTables.push(trendTables[pt]);
      }
    }
    for (var ptti = 0; ptti < pendingTrendTables.length; ptti++) {
      if (!hasTrendData(result.handicapTrend.home)) result.handicapTrend.home = toTrend(pendingTrendTables[ptti].parsed, 'home');
      else if (!hasTrendData(result.handicapTrend.away)) result.handicapTrend.away = toTrend(pendingTrendTables[ptti].parsed, 'away');
    }

    // 文本兜底：用于没有可解析表格结构的旧页面，范围放宽但只在表格解析未命中时使用。
    if (!hasTrendData(result.handicapTrend.home) || !hasTrendData(result.handicapTrend.away)) {
      var allRates = [];
      var rateRe = /(?:赢盘率[\s\S]{0,40}?(\d{1,3}\.?\d*)%|(\d{1,3}\.?\d*)%[\s\S]{0,20}?赢盘率)/g;
      while ((rm = rateRe.exec(text)) !== null) allRates.push(rm[1] || rm[2]);
      var allBigRates = [];
      var bigRe = /(?:大球率[\s\S]{0,40}?(\d{1,3}\.?\d*)%|(\d{1,3}\.?\d*)%[\s\S]{0,20}?大球率)/g;
      while ((rm = bigRe.exec(text)) !== null) allBigRates.push(rm[1] || rm[2]);
      if (!hasTrendData(result.handicapTrend.home)) {
        result.handicapTrend.home.winRates = allRates.slice(0, 4);
        result.handicapTrend.home.bigBallRates = allBigRates.slice(0, 3);
        result.handicapTrend.home.source = 'text-fallback';
      }
      if (!hasTrendData(result.handicapTrend.away)) {
        result.handicapTrend.away.winRates = allRates.slice(4, 8);
        result.handicapTrend.away.bigBallRates = allBigRates.slice(3, 6);
        result.handicapTrend.away.source = 'text-fallback';
      }
    }

    // 近6场走势（格式：赢 赢 输 输 赢 输）
    var seqRe = /近6场\s*\n\s*6\s*\n\s*((?:[赢输走]\s+){3,8})/g;
    var seqMatches = [];
    while ((rm = seqRe.exec(text)) !== null) seqMatches.push(rm[1].trim().replace(/\s+/g,' '));
    if (!result.handicapTrend.home.last6Asian && seqMatches[0]) result.handicapTrend.home.last6Asian = seqMatches[0];
    if (!result.handicapTrend.away.last6Asian && seqMatches[1]) result.handicapTrend.away.last6Asian = seqMatches[1];

    var ouSeqRe = /近6场盘路走势[:：]\s*((?:[大小走]\s*){3,8})/g;
    var ouSeqs = [];
    while ((rm = ouSeqRe.exec(text)) !== null) ouSeqs.push(rm[1].trim());
    if (!result.handicapTrend.home.last6OU && ouSeqs[0]) result.handicapTrend.home.last6OU = ouSeqs[0];
    if (!result.handicapTrend.away.last6OU && ouSeqs[1]) result.handicapTrend.away.last6OU = ouSeqs[1];

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

  // ===================== 胜平负 / 欧赔（1x2）=====================
  function extractWinDrawWin(text, html) {
    const result = {
      companies: [],
      summary: {},
      keyOdds: {},
      history: [],
      _debug: { title: document.title, textLen: text.length, tables: document.querySelectorAll('table').length, parsedRows: 0, skippedRows: 0 }
    };

    const clean = function(v) { return String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(); };
    const compact = function(v) { return clean(v).replace(/\s+/g, ''); };
    const fmt = function(n) { return isFinite(n) ? Number(n).toFixed(2) : ''; };
    const fmtPct = function(n) { return isFinite(n) ? (Number(n) * 100).toFixed(2) + '%' : ''; };
    const calcReturnRate = function(win, draw, loss) {
      win = parseFloat(win); draw = parseFloat(draw); loss = parseFloat(loss);
      if (!(win > 0 && draw > 0 && loss > 0)) return null;
      return win * draw * loss / (win * draw + draw * loss + win * loss);
    };
    const calcProbabilities = function(win, draw, loss) {
      const rate = calcReturnRate(win, draw, loss);
      win = parseFloat(win); draw = parseFloat(draw); loss = parseFloat(loss);
      if (!rate || !(win > 0 && draw > 0 && loss > 0)) return null;
      return {
        win: fmtPct(rate / win),
        draw: fmtPct(rate / draw),
        loss: fmtPct(rate / loss),
        returnRate: fmtPct(rate),
        _decimal: { win: rate / win, draw: rate / draw, loss: rate / loss }
      };
    };
    const recentChange = function(timeText) {
      var m = String(timeText || '').match(/(?:(\d{4})[-\/])?(\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
      if (!m) return false;
      var now = new Date();
      var y = m[1] ? parseInt(m[1], 10) : now.getFullYear();
      var dt = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10));
      var diff = now.getTime() - dt.getTime();
      if (diff < -24 * 60 * 60 * 1000 && !m[1]) dt.setFullYear(y - 1);
      diff = now.getTime() - dt.getTime();
      return diff >= 0 && diff <= 30 * 60 * 1000;
    };
    const pickChangeTime = function(rowText) {
      var ms = String(rowText || '').match(/(?:(?:\d{4}[-\/])?\d{1,2}[-\/]\d{1,2}\s+\d{1,2}:\d{2})/g);
      return ms && ms.length ? ms[ms.length - 1] : '';
    };
    const isSkipName = function(name) {
      name = compact(name);
      if (!name) return true;
      return /^(公司|所有|主流|交易所|非交易所|初|即|主|和|客|主胜|客胜|返还率|凯利指数|变化时间|历史指数|筛选|设置自定义)$/.test(name) ||
        /初盘|即时|最高值|最低值|平均值|高级筛选|删除选中|保留选中|导出Excel|欧亚转换|主胜率|和率|平率|客胜率|概率|返还|凯利|变化时间/.test(name);
    };
    const extractCells = function(row) {
      return Array.from(row.querySelectorAll('th,td')).map(function(c) { return clean(c.textContent); });
    };
    const normalizeCompanyName = function(raw) {
      var name = compact(raw).replace(/[×√□☑★]/g, '');
      name = name.replace(/^[\s\-:：]+/, '');
      if (!/^\d+\*?[（(][^）)]{1,20}[）)]$/.test(name)) {
        name = name.replace(/^[\d一二三四五六七八九十]+[、.．\-]\s*/, '');
      }
      name = name.replace(/\[[^\]]*\]/g, '')
        .replace(/[【】]/g, '')
        .replace(/(走势|详情|历史|主流|交易所|非交易所)$/g, '')
        .trim();
      return name.length > 24 ? name.substring(0, 24) : name;
    };
    const isValidCompanyName = function(name) {
      name = normalizeCompanyName(name);
      if (!name || name.length > 24) return false;
      if (/^\d+(?:\.\d+)?%?$/.test(name)) return false;
      if (/^[（(][^）)]*[）)]$/.test(name)) return false;
      if (/^[\d\s]+$/.test(name)) return false;
      if (isSkipName(name)) return false;
      return /[\u4e00-\u9fa5A-Za-z]/.test(name) || /^\d+\*?[（(][^）)]{1,20}[）)]$/.test(name);
    };
    const extractName = function(row, cells) {
      var td = row.querySelector('td');
      var raw = '';
      if (td) {
        td.childNodes.forEach(function(node) {
          if (!raw && node.nodeType === 3) raw = clean(node.textContent);
        });
        if (!raw) {
          var a = td.querySelector('a');
          raw = a ? clean(a.textContent) : clean(td.textContent);
        }
      }
      if (!raw) raw = cells[0] || '';
      raw = normalizeCompanyName(raw);
      if (!isValidCompanyName(raw)) {
        for (var i = 0; i < Math.min(3, cells.length); i++) {
          var cand = normalizeCompanyName(cells[i]);
          if (isValidCompanyName(cand)) return cand;
        }
        return '';
      }
      return raw;
    };
    const isReasonableOdds = function(v) { v = parseFloat(v); return isFinite(v) && v >= 1.01 && v <= 30; };
    const isValidOddsTriple = function(win, draw, loss) {
      if (!isReasonableOdds(win) || !isReasonableOdds(draw) || !isReasonableOdds(loss)) return false;
      var rate = calcReturnRate(win, draw, loss);
      return !!rate && rate >= 0.70 && rate <= 1.05;
    };
    const parseNumberItems = function(cells, startIndex) {
      const items = [];
      for (var i = startIndex || 0; i < cells.length; i++) {
        var cell = clean(cells[i]);
        if (!cell || cell.indexOf('%') >= 0 || /凯利|概率|主胜率|和率|平率|客胜率|返还/.test(cell)) continue;
        var re = /(^|[^\d.])(\d{1,2}\.\d{2,3})(?![\d.])/g;
        var m;
        while ((m = re.exec(cell)) !== null) {
          var val = parseFloat(m[2]);
          if (isReasonableOdds(val)) items.push({ value: val, text: m[2], cellIndex: i });
        }
      }
      return items;
    };
    const firstValidTriple = function(values, startAt) {
      for (var i = startAt || 0; i <= values.length - 3; i++) {
        if (isValidOddsTriple(values[i], values[i + 1], values[i + 2])) return [values[i], values[i + 1], values[i + 2], i];
      }
      return null;
    };
    const makeEntry = function(name, odds, rowText, source) {
      if (!isValidCompanyName(name) || odds.length < 3) return null;
      var entry = { name: normalizeCompanyName(name), source: source || 'table' };
      var initial = null;
      var current = null;
      if (odds.length >= 6 && isValidOddsTriple(odds[0], odds[1], odds[2]) && isValidOddsTriple(odds[3], odds[4], odds[5])) {
        initial = [odds[0], odds[1], odds[2]];
        current = [odds[3], odds[4], odds[5]];
      } else {
        current = firstValidTriple(odds, 0);
      }
      if (!current) return null;
      if (initial) {
        entry.initialWin = fmt(initial[0]);
        entry.initialDraw = fmt(initial[1]);
        entry.initialLoss = fmt(initial[2]);
      } else {
        entry.initialWin = '';
        entry.initialDraw = '';
        entry.initialLoss = '';
      }
      entry.currentWin = fmt(current[0]);
      entry.currentDraw = fmt(current[1]);
      entry.currentLoss = fmt(current[2]);
      var returnM = rowText.match(/返还率?\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)%/);
      if (returnM) entry.returnRate = returnM[1] + '%';
      var timeM = rowText.match(/(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/);
      if (timeM) entry.changeTime = timeM[1];
      return entry;
    };
    const addCompany = function(entry) {
      if (!entry || !isValidCompanyName(entry.name) || !isValidOddsTriple(entry.currentWin, entry.currentDraw, entry.currentLoss)) return;
      entry.name = normalizeCompanyName(entry.name);
      var key = [entry.name, entry.currentWin, entry.currentDraw, entry.currentLoss].join('|');
      for (var i = 0; i < result.companies.length; i++) {
        var oldKey = [result.companies[i].name, result.companies[i].currentWin, result.companies[i].currentDraw, result.companies[i].currentLoss].join('|');
        if (oldKey === key) return;
      }
      result.companies.push(entry);
    };
    const parseSummaryRow = function(label, cells) {
      var nums = parseNumberItems(cells, 1).map(function(x) { return x.value; });
      if (nums.length < 3) return;
      var target = null;
      if (/初盘平均值/.test(label)) target = 'averageInitial';
      else if (/即时平均值/.test(label)) target = 'averageCurrent';
      else if (/初盘最高值/.test(label)) target = 'maxInitial';
      else if (/即时最高值/.test(label)) target = 'maxCurrent';
      else if (/初盘最低值/.test(label)) target = 'minInitial';
      else if (/即时最低值/.test(label)) target = 'minCurrent';
      if (target) result.summary[target] = { win: fmt(nums[0]), draw: fmt(nums[1]), loss: fmt(nums[2]) };
    };
    const detectRowKind = function(cells, rowCompact) {
      for (var i = 0; i < Math.min(4, cells.length); i++) {
        var c = compact(cells[i]);
        if (/^(初|初盘|初赔|初始)$/.test(c)) return 'initial';
        if (/^(即|即时|即赔)$/.test(c)) return 'current';
      }
      if (/^初盘/.test(rowCompact) || /初盘/.test(rowCompact.substring(0, 10))) return 'initial';
      if (/^即时/.test(rowCompact) || /即时/.test(rowCompact.substring(0, 10))) return 'current';
      return '';
    };
    const pairedRows = {};
    var lastCompanyName = '';
    const storePairedRow = function(name, kind, nums, rowText) {
      if (!isValidCompanyName(name) || !kind || nums.length < 3) return;
      var triple = firstValidTriple(nums, 0);
      if (!triple) return;
      name = normalizeCompanyName(name);
      var entry = pairedRows[name] || { name: name, source: 'table-paired' };
      if (kind === 'initial') {
        entry.initialWin = fmt(triple[0]);
        entry.initialDraw = fmt(triple[1]);
        entry.initialLoss = fmt(triple[2]);
      } else {
        entry.currentWin = fmt(triple[0]);
        entry.currentDraw = fmt(triple[1]);
        entry.currentLoss = fmt(triple[2]);
        var time = pickChangeTime(rowText);
        if (time) entry.changeTime = time;
      }
      pairedRows[name] = entry;
    };

    document.querySelectorAll('table tr').forEach(function(row) {
      const cells = extractCells(row);
      if (cells.length < 4) { result._debug.skippedRows++; return; }
      const rowText = cells.join(' ');
      const rowCompact = compact(rowText);
      if (/^(初盘|即时)(最高值|最低值|平均值)/.test(rowCompact)) {
        parseSummaryRow(rowCompact, cells);
        return;
      }
      if (!/(\d{1,2}\.\d{2,3})/.test(rowText)) { result._debug.skippedRows++; return; }
      const rowKind = detectRowKind(cells, rowCompact);
      var name = extractName(row, cells);
      if (!name && rowKind && lastCompanyName) name = lastCompanyName;
      if (!name) { result._debug.skippedRows++; return; }
      if (name && !/^(初|即|初盘|即时|初赔|即赔)$/.test(name)) lastCompanyName = name;
      const nums = parseNumberItems(cells, 1).map(function(x) { return x.value; });
      if (rowKind && nums.length >= 3) {
        storePairedRow(name, rowKind, nums, rowText);
        result._debug.parsedRows++;
        return;
      }
      const entry = makeEntry(name, nums, rowText, 'table');
      if (entry) {
        addCompany(entry);
        result._debug.parsedRows++;
      } else {
        result._debug.skippedRows++;
      }
    });

    Object.keys(pairedRows).forEach(function(name) {
      var entry = pairedRows[name];
      if (!entry.currentWin && entry.initialWin) {
        entry.currentWin = entry.initialWin;
        entry.currentDraw = entry.initialDraw;
        entry.currentLoss = entry.initialLoss;
      }
      addCompany(entry);
    });

    if (result.companies.length === 0) {
      const lines = (text + '\n' + String(html || '').replace(/[<>"'=,;\[\]{}()]/g, ' ')).split(/\n+/);
      for (var li = 0; li < lines.length && result.companies.length < 120; li++) {
        var line = clean(lines[li]);
        if (!line || !/\d{1,2}\.\d{2,3}/.test(line)) continue;
        var firstNum = line.search(/\d{1,2}\.\d{2,3}/);
        if (firstNum <= 0) continue;
        var name = normalizeCompanyName(line.slice(0, firstNum));
        if (!isValidCompanyName(name)) continue;
        var nums = [];
        var re = /(^|[^\d.])(\d{1,2}\.\d{2,3})(?![\d.])/g;
        var m;
        while ((m = re.exec(line)) !== null) {
          var v = parseFloat(m[2]);
          if (isReasonableOdds(v)) nums.push(v);
        }
        addCompany(makeEntry(name, nums, line, 'text-fallback'));
      }
    }

    const calcAverage = function(selector) {
      if (!result.companies.length) return null;
      var rows = result.companies.map(selector).filter(function(x) { return x && isValidOddsTriple(x.win, x.draw, x.loss); });
      if (!rows.length) return null;
      var sum = rows.reduce(function(acc, x) {
        acc.win += parseFloat(x.win);
        acc.draw += parseFloat(x.draw);
        acc.loss += parseFloat(x.loss);
        return acc;
      }, { win: 0, draw: 0, loss: 0 });
      return { win: fmt(sum.win / rows.length), draw: fmt(sum.draw / rows.length), loss: fmt(sum.loss / rows.length) };
    };
    if (!result.summary.averageCurrent) result.summary.averageCurrent = calcAverage(function(c) { return { win: c.currentWin, draw: c.currentDraw, loss: c.currentLoss }; });
    if (!result.summary.averageInitial) result.summary.averageInitial = calcAverage(function(c) { return { win: c.initialWin, draw: c.initialDraw, loss: c.initialLoss }; });

    const movement = { winDown: 0, winUp: 0, drawDown: 0, drawUp: 0, lossDown: 0, lossUp: 0 };
    result.companies.forEach(function(c) {
      var iw = parseFloat(c.initialWin), cw = parseFloat(c.currentWin);
      var id = parseFloat(c.initialDraw), cd = parseFloat(c.currentDraw);
      var il = parseFloat(c.initialLoss), cl = parseFloat(c.currentLoss);
      if (isFinite(iw) && isFinite(cw)) { if (cw < iw) movement.winDown++; else if (cw > iw) movement.winUp++; }
      if (isFinite(id) && isFinite(cd)) { if (cd < id) movement.drawDown++; else if (cd > id) movement.drawUp++; }
      if (isFinite(il) && isFinite(cl)) { if (cl < il) movement.lossDown++; else if (cl > il) movement.lossUp++; }
    });
    result.summary.count = result.companies.length;
    result.summary.movement = movement;

    var marketProbability = null;
    if (result.summary.averageCurrent) {
      var aw = parseFloat(result.summary.averageCurrent.win);
      var ad = parseFloat(result.summary.averageCurrent.draw);
      var al = parseFloat(result.summary.averageCurrent.loss);
      if (aw > 0 && ad > 0 && al > 0) {
        var marketCalc = calcProbabilities(aw, ad, al);
        if (marketCalc) {
          marketProbability = marketCalc._decimal;
          result.summary.impliedAverage = {
            win: marketCalc.win,
            draw: marketCalc.draw,
            loss: marketCalc.loss
          };
          result.summary.averageReturnRate = marketCalc.returnRate;
        }
      }
    }

    result.companies.forEach(function(c) {
      var cp = calcProbabilities(c.currentWin, c.currentDraw, c.currentLoss);
      if (cp) {
        c.returnRate = cp.returnRate;
        c.currentReturnRate = cp.returnRate;
        c.probabilities = { win: cp.win, draw: cp.draw, loss: cp.loss };
        c.currentProbabilities = c.probabilities;
      }
      var ip = calcProbabilities(c.initialWin, c.initialDraw, c.initialLoss);
      if (ip) {
        c.initialReturnRate = ip.returnRate;
        c.initialProbabilities = { win: ip.win, draw: ip.draw, loss: ip.loss };
      }
      if (marketProbability && isValidOddsTriple(c.currentWin, c.currentDraw, c.currentLoss)) {
        var kw = marketProbability.win * parseFloat(c.currentWin);
        var kd = marketProbability.draw * parseFloat(c.currentDraw);
        var kl = marketProbability.loss * parseFloat(c.currentLoss);
        c.kelly = { win: fmt(kw), draw: fmt(kd), loss: fmt(kl) };
        c.kellyRisk = { win: kw > 1, draw: kd > 1, loss: kl > 1 };
      }
      if (c.changeTime) c.recent30 = recentChange(c.changeTime);
    });

    result.keyOdds.allCurrent = result.companies.map(function(c) {
      return { name: c.name, win: c.currentWin, draw: c.currentDraw, loss: c.currentLoss };
    });
    if (result.companies[0]) result.keyOdds.ao = { name: result.companies[0].name, ...result.companies[0] };
    if (result.companies[1]) result.keyOdds.crown = { name: result.companies[1].name, ...result.companies[1] };
    result.history = extractHistory(text, 'winDrawWin');

    return result;
  }

  // ===================== 36*(英国)欧指统计表 =====================
  function extractWinDrawWinStats(text, html) {
    const result = {
      company: '36*(英国)',
      source: 'goalCount',
      rows: [],
      summary: {},
      recent30: [],
      _debug: { title: document.title, textLen: text.length, tables: document.querySelectorAll('table').length, parsedRows: 0 }
    };
    const clean = function(v) { return String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(); };
    const compact = function(v) { return clean(v).replace(/\s+/g, ''); };
    const fmt = function(n) { return isFinite(n) ? Number(n).toFixed(2) : ''; };
    const fmtPct = function(n) { return isFinite(n) ? (Number(n) * 100).toFixed(2) + '%' : ''; };
    const calcReturnRate = function(win, draw, loss) {
      win = parseFloat(win); draw = parseFloat(draw); loss = parseFloat(loss);
      if (!(win > 0 && draw > 0 && loss > 0)) return null;
      return win * draw * loss / (win * draw + draw * loss + win * loss);
    };
    const calcProbabilities = function(win, draw, loss) {
      const rate = calcReturnRate(win, draw, loss);
      win = parseFloat(win); draw = parseFloat(draw); loss = parseFloat(loss);
      if (!rate || !(win > 0 && draw > 0 && loss > 0)) return null;
      return { win: fmtPct(rate / win), draw: fmtPct(rate / draw), loss: fmtPct(rate / loss), returnRate: fmtPct(rate) };
    };
    const parseRowType = function(cells, rowText) {
      var joined = compact(rowText);
      for (var i = 0; i < Math.min(3, cells.length); i++) {
        var c = compact(cells[i]);
        if (/^(初盘|初|初赔|初始)$/.test(c)) return 'initial';
        if (/^(即时|即|即赔)$/.test(c)) return 'current';
      }
      if (/^初盘/.test(joined)) return 'initial';
      if (/^即时/.test(joined)) return 'current';
      return '';
    };
    const parseStatsRow = function(cells, rowText) {
      const type = parseRowType(cells, rowText);
      if (!type) return null;
      const oddsItems = [];
      cells.forEach(function(c, idx) {
        var cell = clean(c);
        if (!cell || cell.indexOf('%') >= 0 || /概率|返还|凯利|主胜率|和率|平率|客胜率/.test(cell)) return;
        var re = /(^|[^\d.])(\d{1,2}\.\d{2,3})(?![\d.])/g;
        var m;
        while ((m = re.exec(cell)) !== null) {
          var v = parseFloat(m[2]);
          if (v >= 1.01 && v <= 30) oddsItems.push({ value: v, cellIndex: idx });
        }
      });
      if (oddsItems.length < 3) return null;
      const rateCheck = calcReturnRate(oddsItems[0].value, oddsItems[1].value, oddsItems[2].value);
      if (!rateCheck || rateCheck < 0.70 || rateCheck > 1.05) return null;
      const lastOddsIndex = oddsItems[2].cellIndex;
      const counts = [];
      for (var i = lastOddsIndex + 1; i < cells.length; i++) {
        var cm = clean(cells[i]).match(/^\d+$/);
        if (cm) counts.push(parseInt(cm[0], 10));
      }
      const win = fmt(oddsItems[0].value);
      const draw = fmt(oddsItems[1].value);
      const loss = fmt(oddsItems[2].value);
      const prob = calcProbabilities(win, draw, loss);
      const row = {
        type,
        label: type === 'initial' ? '初盘' : '即时',
        win,
        draw,
        loss,
        total: counts[0] || '',
        winCount: counts[1] || '',
        drawCount: counts[2] || '',
        lossCount: counts[3] || '',
        probabilities: prob ? { win: prob.win, draw: prob.draw, loss: prob.loss } : null,
        returnRate: prob ? prob.returnRate : ''
      };
      if (row.total) {
        row.sampleProbabilities = {
          win: row.winCount !== '' ? (row.winCount / row.total * 100).toFixed(2) + '%' : '',
          draw: row.drawCount !== '' ? (row.drawCount / row.total * 100).toFixed(2) + '%' : '',
          loss: row.lossCount !== '' ? (row.lossCount / row.total * 100).toFixed(2) + '%' : ''
        };
      }
      return row;
    };

    var titleText = clean(document.title + ' ' + text.slice(0, 300));
    var companyM = titleText.match(/(\d+\*?\([^)]{1,20}\))\s*欧指统计表/);
    if (companyM) result.company = companyM[1];

    document.querySelectorAll('table tr').forEach(function(row) {
      const cells = Array.from(row.querySelectorAll('th,td')).map(function(c) { return clean(c.textContent); });
      if (cells.length < 4) return;
      const rowText = cells.join(' ');
      const parsed = parseStatsRow(cells, rowText);
      if (parsed) {
        result.rows.push(parsed);
        result._debug.parsedRows++;
      }
    });

    if (result.rows.length === 0) {
      var lines = text.split(/\n+/);
      lines.forEach(function(line) {
        line = clean(line);
        if (!/^(初盘|即时|初|即)\s+\d/.test(line)) return;
        var cells = line.split(/\s+/);
        var parsed = parseStatsRow(cells, line);
        if (parsed) result.rows.push(parsed);
      });
    }

    var summaryM = text.match(/共\s*(\d+)\s*场[\s\S]{0,60}?主胜\s*(\d{1,3}(?:\.\d+)?)%[\s\S]{0,30}?(?:和局|平局|和)\s*(\d{1,3}(?:\.\d+)?)%[\s\S]{0,30}?客胜\s*(\d{1,3}(?:\.\d+)?)%/);
    if (summaryM) {
      result.summary.sampleTotal = summaryM[1];
      result.summary.sampleRates = { win: summaryM[2] + '%', draw: summaryM[3] + '%', loss: summaryM[4] + '%' };
    }
    var recentM = text.match(/近\s*30\s*场[\s\S]{0,80}?([胜平负和客主]{10,})/);
    if (recentM) result.recent30 = recentM[1].replace(/和/g, '平').split('').slice(0, 30);

    result.summary.initial = result.rows.find(function(r) { return r.type === 'initial'; }) || null;
    result.summary.current = result.rows.find(function(r) { return r.type === 'current'; }) || null;
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

  // ===================== 滚球实时数据提取 =====================
  function extractLiveData(text, html) {
    const result = {
      matchInfo: {},
      liveScore: {},
      events: [],
      asianLive: {},
      ouLive: {},
      suggestions: []
    };

    // 比分
    const scoreM = text.match(/(\d+)\s*[-:]\s*(\d+)/);
    if (scoreM) {
      result.liveScore.home = parseInt(scoreM[1]);
      result.liveScore.away = parseInt(scoreM[2]);
      result.liveScore.score = `${scoreM[1]}:${scoreM[2]}`;
    }

    // 比赛时间（分钟）
    const minM = text.match(/(\d{1,3})['\s]*分/);
    if (minM) result.liveScore.minute = parseInt(minM[1]);

    // 半场/全场
    if (/半场|上半场/.test(text)) result.liveScore.period = '上半场';
    else if (/下半场/.test(text)) result.liveScore.period = '下半场';
    else if (/加时/.test(text)) result.liveScore.period = '加时';
    else if (/完场|全场/.test(text)) result.liveScore.period = '完场';

    // 进球事件
    const goalRe = /(\d{1,3})['\s]分.*?([^\n]{2,15})进球/g;
    let gm;
    while ((gm = goalRe.exec(text)) !== null) {
      result.events.push({ type: 'goal', minute: gm[1], player: gm[2] });
    }

    // 红牌
    const redRe = /(\d{1,3})['\s]分.*?([^\n]{2,15})红牌/g;
    let rm;
    while ((rm = redRe.exec(text)) !== null) {
      result.events.push({ type: 'redcard', minute: rm[1], player: rm[2] });
    }

    // 实时亚盘（从页面表格提取当前让球）
    const tables = document.querySelectorAll('table');
    tables.forEach(tbl => {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
        if (cells.length < 3) return;
        // 让球识别
        const handicapM = cells.join('').match(/([+-]?\d+(?:\.\d+)?)\s*([01]\.\d{2})\s*([01]\.\d{2})/);
        if (handicapM && !result.asianLive.handicap) {
          result.asianLive.handicap = handicapM[1];
          result.asianLive.homeWater = handicapM[2];
          result.asianLive.awayWater = handicapM[3];
        }
        // 大小球识别
        const ouM = cells.join('').match(/(\d+(?:\.\d+)?)\s*大\s*([01]\.\d{2})\s*小\s*([01]\.\d{2})/);
        if (ouM && !result.ouLive.line) {
          result.ouLive.line = ouM[1];
          result.ouLive.overWater = ouM[2];
          result.ouLive.underWater = ouM[3];
        }
      });
    });

    // 主客队名
    const teamM = text.match(/([^\s\n]{2,12})\s*(?:vs|VS|对)\s*([^\s\n]{2,12})/);
    if (teamM) { result.matchInfo.home = teamM[1]; result.matchInfo.away = teamM[2]; }

    result._fetchTime = Date.now();
    result._textLen = text.length;
    return result;
  }
}

// ===== 滚球实时数据采集 =====
async function collectLiveData(matchId) {
  // 采集 live.titan007.com/detail/页面的实时数据
  const url = `https://live.titan007.com/detail/${matchId}sb.htm`;
  try {
    const result = await extractOneTab(url, 'live');
    return result;
  } catch (e) {
    console.error('[BG] collectLiveData error:', e);
    return null;
  }
}

// ===== 今日比赛采集 =====
async function fetchTodayMatches() {
  const url = 'https://live.titan007.com/oldIndexall.aspx';
  try {
    const result = await new Promise((resolve, reject) => {
      let tabId = null;
      let done = false;
      const finish = (r, e) => {
        if (done) return;
        done = true;
        if (tabId) chrome.tabs.remove(tabId).catch(() => {});
        if (e) reject(e); else resolve(r);
      };
      // 总超时60秒（Ajax数据需要时间加载）
      const timer = setTimeout(() => finish({ matches: [] }, null), 60000);

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

          // 轮询等待数据加载（页面Ajax数据通常需要3-10秒）
          let pollCount = 0;
          const maxPolls = 10;

          const poll = () => {
            chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                // 方法1: 检测 tr[mid] 属性
                const trByMid = document.querySelectorAll('tr[mid]');
                // 方法2: 检测 id="m_XXXXXXX" 格式的行
                const trById = document.querySelectorAll('tr[id^="m_"]');
                // 方法3: 含 EuropeOdds(ID) 的链接（球探网标准）
                let euroCount = 0;
                document.querySelectorAll('a').forEach(a => {
                  const h = a.getAttribute('href') || '';
                  if (/EuropeOdds\(\d+\)/.test(h) || /advices\(\d+\)/.test(h)) euroCount++;
                });
                const matchCount = Math.max(trByMid.length, trById.length, euroCount);
                return { loaded: matchCount > 3, matchCount, trMid: trByMid.length, trId: trById.length, euro: euroCount };
              }
            }, (res) => {
              if (chrome.runtime.lastError) {
                clearTimeout(timer);
                finish({ matches: [] }, null);
                return;
              }
              const r = res?.[0]?.result || {};
              console.log(`[BG] Today poll ${pollCount}: matchCount=${r.matchCount} (trMid=${r.trMid}, trId=${r.trId}, xi=${r.xi})`);

              if (r.loaded || pollCount >= maxPolls) {
                // 数据已加载，执行正式提取
                chrome.scripting.executeScript({
                  target: { tabId },
                  func: () => {
                    try {
                      const matches = [];
                      const seen = new Set();

                      // =============================================
                      // 方法1: tr[mid] 属性直接获取比赛ID（最可靠）
                      // =============================================
                      document.querySelectorAll('tr[mid]').forEach(tr => {
                        const id = tr.getAttribute('mid');
                        if (!id || !/^\d{6,8}$/.test(id) || seen.has(id)) return;
                        seen.add(id);
                        const tds = Array.from(tr.querySelectorAll('td'));
                        matches.push(parseRowData(id, tr, tds));
                      });

                      // =============================================
                      // 方法2: tr[id^="m_"] 格式
                      // =============================================
                      document.querySelectorAll('tr[id^="m_"]').forEach(tr => {
                        const raw = tr.id.replace('m_', '');
                        if (!/^\d{6,8}$/.test(raw) || seen.has(raw)) return;
                        seen.add(raw);
                        const tds = Array.from(tr.querySelectorAll('td'));
                        matches.push(parseRowData(raw, tr, tds));
                      });

                      // =============================================
                      // 方法3: EuropeOdds(ID) 或 advices(ID) 链接（始终执行）
                      // 球探网标准：<a href="javascript:EuropeOdds(2915673)">欧</a>
                      //             <a href="javascript:advices(2915673)">荐</a>
                      //             <a href="javascript:addConcern(2915673,10)">置顶</a>
                      // =============================================
                      document.querySelectorAll('a').forEach(a => {
                        const href = a.getAttribute('href') || '';
                        const idM = href.match(/EuropeOdds\((\d{6,8})\)/) ||
                                    href.match(/advices\((\d{6,8})\)/) ||
                                    href.match(/addConcern\((\d{6,8})/);
                        if (!idM) return;
                        const id = idM[1];
                        if (seen.has(id)) return;
                        seen.add(id);
                        const tr = a.closest('tr');
                        if (!tr) return;
                        const tds = Array.from(tr.querySelectorAll('td'));
                        matches.push(parseRowData(id, tr, tds));
                      });

                      // =============================================
                      // 方法4: 全局变量
                      // =============================================
                      let globalMatches = [];
                      if (matches.length === 0) {
                        try {
                          const possibleVars = ['g_matList', 'matchList', 'allMatchData', 'g_scoreData', 'GoalList'];
                          for (const v of possibleVars) {
                            if (window[v] && typeof window[v] === 'object') {
                              const vals = Array.isArray(window[v]) ? window[v] : Object.values(window[v]);
                              globalMatches = vals;
                              // 尝试将全局变量解析成比赛列表
                              vals.forEach(item => {
                                if (!item) return;
                                const id = item.matchId || item.mid || item.id || item.mId;
                                if (!id || seen.has(String(id))) return;
                                seen.add(String(id));
                                matches.push({
                                  id: String(id),
                                  league: item.leagueName || item.league || item.ln || '未知',
                                  home: item.homeTeam || item.home || item.hn || '主队',
                                  away: item.awayTeam || item.away || item.an || '客队',
                                  time: item.matchTime || item.time || item.mt || '',
                                  score: '',
                                  status: 'upcoming'
                                });
                              });
                              break;
                            }
                          }
                        } catch(e2) {}
                      }

                      function parseRowData(id, tr, tds) {
                        const cells = tds.map(c => (c.innerText || '').replace(/\s+/g, ' ').trim());
                        const rowText = cells.join('|');

                        // 时间
                        const timeM = rowText.match(/\b(\d{1,2}:\d{2})\b/);
                        const matchTime = timeM ? timeM[1] : '';

                        // 比分
                        const scoreM = rowText.match(/\b(\d{1,2})\s*[-]\s*(\d{1,2})\b/);
                        const score = scoreM ? `${scoreM[1]}:${scoreM[2]}` : '';

                        // 联赛名：球探网联赛链接格式 SubLeague.aspx?SclassID=
                        let league = '';
                        const leagueA = tr.querySelector('a[href*="SubLeague.aspx"]');
                        if (leagueA) league = leagueA.innerText.trim();

                        // 回退：含league/lg class的td
                        if (!league) {
                          for (const td of tds) {
                            const cls = (td.className || '').toLowerCase();
                            const t = (td.innerText || '').trim();
                            if ((cls.includes('league') || cls.includes('lg')) && t && t.length <= 30 && /[\u4e00-\u9fa5A-Za-z]/.test(t)) {
                              league = t; break;
                            }
                          }
                        }
                        // 再回退：第一个含汉字短单元格
                        if (!league) {
                          for (const td of tds) {
                            const t = (td.innerText || '').replace(/\s+/g, '').trim();
                            if (t.length >= 2 && t.length <= 20 && /[\u4e00-\u9fa5]/.test(t) &&
                                !t.match(/^\d/) && !/[:-]/.test(t) && !/析|荐|电视|隐|完场|上半|下半|亚|大|欧/.test(t)) {
                              league = t; break;
                            }
                          }
                        }

                        // 主客队：球探网队名是 <a href="javascript:">队名</a>
                        // 找所有 href="javascript:" 且文本含汉字/字母的链接
                        const teamLinks = [];
                        tr.querySelectorAll('a').forEach(a => {
                          const h = a.getAttribute('href') || '';
                          const t = (a.innerText || '').trim();
                          // 排除联赛链接、功能链接
                          if (h === 'javascript:' && t && t.length >= 2 && t.length <= 30 &&
                              /[\u4e00-\u9fa5A-Za-z]/.test(t) &&
                              !/^(析|亚|大|欧|荐|电视)$/.test(t)) {
                            teamLinks.push(t);
                          }
                        });
                        let home = '', away = '';
                        if (teamLinks.length >= 2) {
                          home = teamLinks[0];
                          away = teamLinks[1];
                        } else {
                          // class 检测
                          for (const td of tds) {
                            const cls = (td.className || '').toLowerCase();
                            const t = (td.innerText || '').trim();
                            if ((cls.includes('home') || cls.includes('hteam')) && t && /[\u4e00-\u9fa5A-Za-z]/.test(t)) home = t;
                            if ((cls.includes('away') || cls.includes('ateam')) && t && /[\u4e00-\u9fa5A-Za-z]/.test(t)) away = t;
                          }
                          home = home || tr.getAttribute('home') || tr.getAttribute('hteam') || '';
                          away = away || tr.getAttribute('away') || tr.getAttribute('ateam') || '';
                        }

                        // 状态
                        let status = score ? 'live' : 'upcoming';
                        if (/完场|全场|结束/.test(rowText)) status = 'finished';
                        if (/上半|下半|加时|点球/.test(rowText)) status = 'live';
                        if (/未开|预定/.test(rowText)) status = 'upcoming';

                        return {
                          id,
                          league: league || '未知',
                          home: home || '主队',
                          away: away || '客队',
                          time: matchTime,
                          score: score || '',
                          status,
                          _rowText: rowText.slice(0, 120)
                        };
                      }

                      return {
                        matches,
                        globalMatchCount: globalMatches.length,
                        pageText: document.body.innerText.slice(0, 500),
                        linkCount: document.querySelectorAll('a[href]').length
                      };
                    } catch (e) {
                      return { error: e.message, matches: [], pageText: document.body.innerText.slice(0, 300) };
                    }
                  }
                }, (res2) => {
                  clearTimeout(timer);
                  if (chrome.runtime.lastError) { finish({ matches: [] }, null); return; }
                  const extracted = res2?.[0]?.result || { matches: [] };
                  console.log(`[BG] Extracted ${extracted.matches?.length} matches, links=${extracted.linkCount}, globalMatches=${extracted.globalMatchCount}`);
                  if (extracted.pageText) console.log('[BG] PageText sample:', extracted.pageText);
                  finish(extracted, null);
                });
              } else {
                // 继续等待
                pollCount++;
                setTimeout(poll, 2000);
              }
            });
          };

          // 初始等待8秒后开始轮询（Ajax页面需要充足时间）
          setTimeout(poll, 8000);
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
      });
    });

    const rawMatches = result?.matches || [];
    if (rawMatches.length === 0) {
      console.warn('[BG] fetchTodayMatches: no matches extracted');
    }
    return rawMatches.map(m => ({
      ...m,
      leaguePriority: getLeaguePriority(m.league),
      leagueTier: getLiveTierLabel(m.league)
    })).sort((a, b) => b.leaguePriority - a.leaguePriority);
  } catch (e) {
    console.error('[BG] fetchTodayMatches error:', e);
    return [];
  }
}

function getLiveTierLabel(leagueName) {
  if (!leagueName) return '其他';
  const name = String(leagueName);
  const tier1 = ['世界杯', 'FIFA', '欧冠', '冠军联赛', '欧洲杯', '美洲杯', '非洲杯', '亚洲杯', '金杯赛', 'Champions', '欧联'];
  const tier2 = ['英超', '西甲', '德甲', '意甲', '法甲', 'Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1'];
  const tier3 = ['葡超', '荷甲', '比甲', '土超', '俄超', '苏超', '英冠', '西乙', '意乙', '德乙', '法乙', 'MLS', 'J联赛', 'K联赛', '中超', '澳超', '巴西', '阿根廷'];
  if (tier1.some(p => name.includes(p))) return '顶级赛事';
  if (tier2.some(p => name.includes(p))) return '五大联赛';
  if (tier3.some(p => name.includes(p))) return '热门联赛';
  return '其他';
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

  const pw = prev.winDrawWin?.keyOdds?.ao, cw = curr.winDrawWin?.keyOdds?.ao;
  const prevWinDrawWin = formatWinDrawWinOdds(pw);
  const currWinDrawWin = formatWinDrawWinOdds(cw);
  if (prevWinDrawWin && currWinDrawWin && prevWinDrawWin !== currWinDrawWin) {
    changes.push({ type: 'winDrawWin', from: prevWinDrawWin, to: currWinDrawWin });
  }

  const pa = prev.asian?.keyOdds?.ao, ca = curr.asian?.keyOdds?.ao;
  if (pa && ca && pa.currentHandicap !== ca.currentHandicap)
    changes.push({ type: 'asian', from: pa.currentHandicap, to: ca.currentHandicap });

  const po = prev.overunder?.keyOdds?.ao, co = curr.overunder?.keyOdds?.ao;
  if (po && co && po.currentLine !== co.currentLine)
    changes.push({ type: 'ou', from: po.currentLine, to: co.currentLine });

  return changes;
}

function formatWinDrawWinOdds(odds) {
  if (!odds) return '';
  const values = [odds.currentWin, odds.currentDraw, odds.currentLoss]
    .map(v => String(v ?? '').trim());
  if (values.some(v => !v)) return '';
  return values.join('/');
}

function formatChangeMessage(change) {
  if (change.type === 'winDrawWin') return `胜平负: 主/平/客 ${change.from}→${change.to}`;
  if (change.type === 'asian') return `亚让: ${change.from}→${change.to}`;
  if (change.type === 'ou') return `大小球: ${change.from}→${change.to}`;
  return `${change.type}: ${change.from}→${change.to}`;
}

function notifyChanges(matchId, changes, data) {
  const home = data.analysis?.matchInfo?.home || matchId;
  const away = data.analysis?.matchInfo?.away || '';
  chrome.notifications.create(`chg_${matchId}_${Date.now()}`, {
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: `⚽ ${home}${away ? ' vs ' + away : ''} 盘口变动`,
    message: changes.map(formatChangeMessage).join('\n')
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
