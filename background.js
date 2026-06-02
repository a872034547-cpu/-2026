// Background Service Worker - Tab注入为主，后台fetch为辅

import { Predictor, PredictionLogger } from './js/predictor.js';
import { ReportGenerator } from './js/report.js';
import { AIClient } from './js/ai-client.js';
import { calcProfitabilityScore, parseTodayMatchesFromHtml, buildBatchAIPrompt, parseAIBetAdvice, getLeaguePriority } from './js/daily-analyzer.js';
import { analyze as quantAnalyze, toMarkdown as quantToMarkdown } from './js/quant-engine.js';
import { gatherMatchIntel, intelToMarkdown } from './js/web-search.js';

const predictor = new Predictor();
const reportGen = new ReportGenerator();
const aiClient = new AIClient();

const PUBLIC_SYNC_KEYS = ['publicSyncEnabled', 'publicApiUrl', 'publicAdminKey'];
const OFFICIAL_RECORD_LIMIT = 1000;

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
    width: 780,
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

      // ===== 深度预测 2.0：原始数据 + 量化模型 + 联网情报 + AI综合裁决 =====
      case 'AI_PREDICT_DEEP': {
        const stored = await getStoredData(msg.matchId);
        if (!stored) { sendResponse({ ok: false, error: '暂无数据，请先采集' }); break; }
        const result = await runDeepPrediction(stored, msg.matchId);
        sendResponse(result);
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
          liveData.suggestions = calcLiveSuggestions(liveData);
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

      case 'SYNC_ALL_TO_SERVER': {
        // 管理员一键全量同步：本地所有战绩 + 本地缓存的所有比赛数据
        try {
          const settings = await getPublicSyncSettings();
          if (!settings.enabled) { sendResponse({ ok: false, error: '公共同步未启用' }); break; }
          if (!settings.isAdmin) { sendResponse({ ok: false, error: '仅管理员可同步' }); break; }

          // 1. 上传本地战绩（bet_records）
          const rRec = await chrome.storage.local.get('bet_records');
          const localRecords = rRec.bet_records || [];
          let recordCount = 0;
          if (localRecords.length > 0) {
            const officialRecords = localRecords.map(r => ({ ...r, official: true }));
            await publicApi('record.upsert', {
              settings,
              requireAdmin: true,
              method: 'POST',
              body: { records: officialRecords }
            });
            recordCount = officialRecords.length;
          }

          // 2. 上传所有本地缓存的比赛数据（match_* 键）
          const allLocal = await chrome.storage.local.get(null);
          const matchKeys = Object.keys(allLocal).filter(k => k.startsWith('match_'));
          let matchCount = 0;
          for (const key of matchKeys) {
            const entry = allLocal[key];
            if (!entry || !entry.matchId || !entry.data) continue;
            try {
              await publicApi('match.upsert', {
                settings,
                requireAdmin: true,
                method: 'POST',
                body: { matchId: entry.matchId, data: entry.data }
              });
              matchCount++;
            } catch (e2) { /* 单场失败不阻断 */ }
          }

          sendResponse({
            ok: true,
            recordCount,
            matchCount,
            message: `同步完成：${recordCount} 条战绩 + ${matchCount} 场比赛数据已上传到服务器`
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }

      case 'LOAD_SERVER_MATCHES': {
        // 从服务器加载今日/明日比赛完整列表（含 data_json），供普通用户直接展示
        try {
          const settings = await getPublicSyncSettings();
          if (!settings.enabled) { sendResponse({ ok: false, serverEnabled: false, matches: [] }); break; }
          // 取今天和明天日期前缀（UTC+8）
          const now = new Date(Date.now() + 8 * 3600000);
          const today = now.toISOString().slice(0, 10);
          const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
          const json = await publicApi('match.list', { settings, params: { limit: '500', includeData: '1' } });
          const matches = (json.matches || [])
            .filter(m => {
              const t = (m.matchTime || '').slice(0, 10);
              return t === today || t === tomorrow;
            })
            .map(m => {
              const data = m.data || null;
              const info = (data?.analysis?.matchInfo) || {};
              const league = m.league || info.league || '';
              const home = m.home || info.home || '';
              const away = m.away || info.away || '';
              let profitability = null;
              try { if (data) profitability = calcProfitabilityScore(data); } catch(e) {}
              return {
                matchId: String(m.matchId),
                home,
                away,
                league,
                matchTime: m.matchTime || '',
                leaguePriority: getLeaguePriority(league),
                leagueTier: getLiveTierLabel(league),
                data,
                profitability
              };
            });
          sendResponse({ ok: true, serverEnabled: true, matches });
        } catch (e) {
          sendResponse({ ok: false, error: e.message, matches: [] });
        }
        break;
      }

      case 'LOAD_PUBLIC_MATCH_LIST': {
        // 批量加载服务器上已采集的公共比赛数据列表（不含完整 data_json，仅 matchId 列表）
        try {
          const settings = await getPublicSyncSettings();
          if (!settings.enabled) { sendResponse({ ok: false, serverEnabled: false, matchIds: [] }); break; }
          const json = await publicApi('match.list', { settings, params: { includeData: '0', limit: '1000' } });
          const matchIds = (json.matches || []).map(m => String(m.matchId));
          sendResponse({ ok: true, serverEnabled: true, matchIds });
        } catch (e) {
          sendResponse({ ok: false, error: e.message, matchIds: [] });
        }
        break;
      }

      case 'FETCH_MATCH_QUICK_DATA': {
        // 快速采集单场比赛核心数据：analysis 富统计 + 亚盘 + 欧赔 + 大小球
        // preferServer=true 时优先从服务器加载，服务器无数据再打开标签页采集
        const { matchId, preferServer, league, home, away, matchTime } = msg;
        try {
          // 优先从服务器加载
          if (preferServer) {
            const serverEntry = await loadPublicMatchData(matchId);
            if (serverEntry && serverEntry.data) {
              const data = serverEntry.data;
              const profitability = calcProfitabilityScore(data);
              // 写入本地缓存
              await chrome.storage.local.set({ [`match_${matchId}`]: serverEntry });
              sendResponse({ ok: true, data, profitability, source: 'server' });
              break;
            }
          }
          const sources = [
            { type: 'analysis',   url: `https://zq.titan007.com/analysis/${matchId}cn.htm` },
            { type: 'winDrawWin', url: `https://1x2.titan007.com/oddslist/${matchId}.htm` },
            { type: 'asian',      url: `https://vip.titan007.com/AsianOdds_n.aspx?id=${matchId}&l=0` },
            { type: 'overunder',  url: `https://vip.titan007.com/OverDown_n.aspx?id=${matchId}&l=0` }
          ];
          const results = await Promise.allSettled(sources.map(s =>
            s.type === 'analysis' ? extractAnalysisWithFallback(matchId) : extractOneTab(s.url, s.type)
          ));
          const data = { matchId, fetchTime: new Date().toISOString() };
          sources.forEach((s, i) => {
            data[s.type] = results[i].status === 'fulfilled' ? results[i].value : { error: results[i].reason?.message };
          });
          if (data.winDrawWin && !data.winDrawWin.error) {
            data.winDrawWin = finalizeWinDrawWin(data.winDrawWin);
          }
          if (data.analysis?.recentStats) data.recentStats = data.analysis.recentStats;
          // 将今日比赛列表中的 league/home/away/time 补入 matchInfo（分析页不含赛事名）
          if (league || home || away || matchTime) {
            if (!data.analysis) data.analysis = {};
            if (!data.analysis.matchInfo) data.analysis.matchInfo = {};
            if (league) data.analysis.matchInfo.league = data.analysis.matchInfo.league || league;
            if (home) data.analysis.matchInfo.home = data.analysis.matchInfo.home || home;
            if (away) data.analysis.matchInfo.away = data.analysis.matchInfo.away || away;
            if (matchTime) data.analysis.matchInfo.time = data.analysis.matchInfo.time || matchTime;
          }
          await storeData(matchId, data);
          const profitability = calcProfitabilityScore(data);
          sendResponse({ ok: true, data, profitability, source: 'live' });
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
        // 战绩Tab展示官方记录：公共同步开启时从 PHP 服务端读取；未开启时兼容旧本地模式。
        // forceLocal=true：强制读取本地 bet_records，忽略服务器
        if (msg.forceLocal) {
          const r = await chrome.storage.local.get('bet_records');
          sendResponse({ records: r.bet_records || [], publicSyncEnabled: false, canManageOfficialRecords: true, isAdmin: true, mode: 'local' });
        } else {
          const result = await getOfficialBetRecords();
          sendResponse(result);
        }
        break;
      }

      case 'SAVE_BET_RECORDS': {
        // 管理员：发布为官方战绩；普通用户：保存为本地私有记录，不进入官方战绩。
        const result = await saveBetRecordsByRole(msg.betRecords || []);
        sendResponse(result);
        break;
      }

      case 'UPDATE_BET_RECORD': {
        const { id, actualScore, betResult } = msg;
        const result = await updateOfficialBetRecordByRole(id, { actualScore, betResult });
        sendResponse(result);
        break;
      }

      case 'DELETE_BET_RECORD': {
        const result = await deleteOfficialBetRecordByRole(msg.id);
        sendResponse(result);
        break;
      }

      case 'DELETE_BET_RECORDS_BY_DATE': {
        const result = await deleteOfficialBetRecordsByDateByRole(msg.date);
        sendResponse(result);
        break;
      }

      case 'VERIFY_BET_RECORD': {
        // 自动采集赛果比分，判断官方投注是否命中；公共同步普通用户只读，不能写回。
        const { id: recordId, matchId: vMatchId, betType, selection, matchHome: vMatchHome, matchAway: vMatchAway } = msg;
        try {
          const permission = await officialRecordPermission();
          if (!permission.canManage) {
            sendResponse({ ok: false, error: permission.reason || '普通用户只能查看官方战绩，不能验证或修改' });
            break;
          }
          const verifyRes = await verifyBetRecord(vMatchId, betType, selection, vMatchHome, vMatchAway);
          if (verifyRes.betResult) {
            await saveVerifiedBetResult(recordId, vMatchId, betType, selection, verifyRes);
          }
          sendResponse({ ok: true, ...verifyRes });
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
        // 单场详细分析（用于今日赛事勾选批量）。deep=true 时走深度编排
        const { matchId: dmId, matchData, matchInfo, deep } = msg;
        try {
          // 构造与 getStoredData 兼容的结构，用 reportGen 生成报告；保留快速采集到的 analysis 富统计
          const analysisData = Object.assign({}, matchData?.analysis || {});
          analysisData.matchInfo = Object.assign({}, analysisData.matchInfo || {}, {
            home: matchInfo?.home || analysisData.matchInfo?.home || '主队',
            away: matchInfo?.away || analysisData.matchInfo?.away || '客队',
            league: matchInfo?.league || analysisData.matchInfo?.league || '',
            time: matchInfo?.time || analysisData.matchInfo?.time || ''
          });
          const pseudoStored = {
            matchId: dmId,
            fetchTime: new Date().toISOString(),
            data: {
              matchId: dmId,
              fetchTime: new Date().toISOString(),
              analysis: analysisData,
              winDrawWin: matchData?.winDrawWin || {},
              asian: matchData?.asian || {},
              overunder: matchData?.overunder || {}
            }
          };
          const analysisRecentStats = matchData?.recentStats || matchData?.analysis?.recentStats;
          if (deep) {
            const result = await runDeepPrediction(pseudoStored, dmId, analysisRecentStats);
            sendResponse(result);
          } else {
            const report = reportGen.generate(pseudoStored);
            const prediction = await aiClient.predict(report, dmId);
            sendResponse({ ok: true, prediction, reportMarkdown: report.markdown });
          }
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

function analysisRichScore(analysis) {
  if (!analysis || analysis.error) return -1;
  const richTables = analysis._debug?.richTables || {};
  let score = 0;
  score += (Number(richTables.goalDist) || 0) * 4;
  score += (Number(richTables.halfFull) || 0) * 3;
  score += (Number(richTables.singleDouble) || 0) * 3;
  score += (Number(richTables.goalTime) || 0) * 3;
  score += (Number(richTables.firstGoalTime) || 0) * 2;
  if (analysis.recentGoalDistribution?.home || analysis.recentGoalDistribution?.away) score += 4;
  if (analysis.halfFull?.home || analysis.halfFull?.away) score += 3;
  if (analysis.goalSingleDouble?.home || analysis.goalSingleDouble?.away) score += 3;
  if (analysis.goalTimeDistribution?.home || analysis.goalTimeDistribution?.away) score += 3;
  if (analysis.goalTimeDistribution?.homeFirst || analysis.goalTimeDistribution?.awayFirst) score += 2;
  if (analysis.seasonComparison?.home?.goals?.total || analysis.seasonComparison?.away?.goals?.total) score += 1;
  if (analysis.recentStats) score += 1;
  return score;
}

function hasAnalysisRichData(analysis) {
  return analysisRichScore(analysis) > 0;
}

async function extractAnalysisWithFallback(matchId) {
  const cnUrl = `https://zq.titan007.com/analysis/${matchId}cn.htm`;
  const sbUrl = `https://zq.titan007.com/analysis/${matchId}sb.htm`;
  let primary = null;
  let primaryErr = null;

  try {
    primary = await extractOneTab(cnUrl, 'analysis');
  } catch (e) {
    primaryErr = e;
  }

  try {
    const fallback = await extractOneTab(sbUrl, 'analysis');
    if (fallback && !fallback.error) {
      const primaryScore = analysisRichScore(primary);
      const fallbackScore = analysisRichScore(fallback);
      fallback._debug = Object.assign({}, fallback._debug || {}, {
        fallbackFrom: 'cn.htm',
        primaryRichScore: primaryScore,
        fallbackRichScore: fallbackScore,
        primaryRichTables: primary?._debug?.richTables || null,
        primaryError: primaryErr?.message || null
      });
      // sb.htm 经常比 cn.htm 多“入球分布/半全场/进球时间/得失球统计”。只要 sb 的富统计更完整，就优先使用 sb。
      if (!primary || fallbackScore > primaryScore || (fallbackScore >= 6 && primaryScore <= 2)) return fallback;
    }
  } catch (e) {
    if (!primary) throw (primaryErr || e);
    primary._debug = Object.assign({}, primary._debug || {}, { sbFallbackError: e.message });
  }

  return primary;
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

  const results = await Promise.allSettled(sources.map(s =>
    s.type === 'analysis' ? extractAnalysisWithFallback(matchId) : extractOneTab(s.url, s.type)
  ));

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
  if (data.analysis?.recentStats) data.recentStats = data.analysis.recentStats;

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
            // 已有公司但初盘列尚未渲染（无任一公司带初盘）时，给"所有/初"视图激活留出时间再重试
            if (dataType === 'winDrawWin' && result && Array.isArray(result.companies) && result.companies.length > 0
                && !result.companies.some(c => c && c.initialWin) && attempt < 3) {
              setTimeout(() => tryExtract(attempt + 1), 2500);
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
    if (dataType === 'winDrawWin') {
      // 百家欧指页默认只渲染"即时"列，初盘列需切到"所有/初"视图或勾选"头尾浮动"才填充。
      // 在页面上下文里主动触发这些开关，使初盘列渲染出来后再解析（配合 extractOneTab 重试）。
      try {
        var activateInitialOdds = function() {
          var clicked = false;
          // 1) "头尾浮动"开关（最直接：同时显示初盘+即时）
          var all = document.querySelectorAll('a,span,label,input,td,th,div,li,b');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var t = (el.textContent || '').replace(/\s/g, '');
            if (t === '头尾浮动' || t === '頭尾浮動') {
              // 勾选其内/相邻 checkbox 或直接点击
              var cb = el.querySelector && el.querySelector('input[type=checkbox]');
              if (cb && !cb.checked) { cb.click(); clicked = true; }
              else { try { el.click(); clicked = true; } catch (e) {} }
            }
          }
          // 2) 顶部"所有 / 初 / 即"视图：优先点"所有"，其次"初"
          var pickView = function(label) {
            for (var j = 0; j < all.length; j++) {
              var e2 = all[j];
              var tx = (e2.textContent || '').replace(/\s/g, '');
              if ((tx === label) && (e2.tagName === 'A' || e2.tagName === 'SPAN' || e2.tagName === 'LABEL' || e2.tagName === 'LI' || e2.onclick || (e2.getAttribute && e2.getAttribute('onclick')))) {
                try { e2.click(); return true; } catch (e) {}
              }
            }
            return false;
          };
          if (pickView('所有') || pickView('初')) clicked = true;
          // 3) 兜底：调用页面可能存在的全局切换函数
          ['ShowType', 'showType', 'SetType', 'companyFilter', 'ShowOdds'].forEach(function(fn) {
            try { if (typeof window[fn] === 'function') { window[fn](0); clicked = true; } } catch (e) {}
          });
          return clicked;
        };
        activateInitialOdds();
      } catch (e) { /* 激活失败不影响后续解析 */ }
      return extractWinDrawWin(text, html);
    }
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
      recentGoalDistribution: { home: null, away: null },
      halfFull: { home: null, away: null },
      goalSingleDouble: {},
      goalTimeDistribution: {},
      seasonComparison: { home: {}, away: {} },
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

    // 用前置标题/队名锚定全场/半场战绩表归属，避免因页面中有其他匹配表导致顺序错乱
    var statsOwnerOf = function(tbl) {
      var hName = result.matchInfo.home || '';
      var aName = result.matchInfo.away || '';
      var ctx = '';
      var node = tbl.previousElementSibling;
      for (var s = 0; node && s < 8; s++, node = node.previousElementSibling) ctx += ' ' + node.textContent;
      if (hName && ctx.indexOf(hName) >= 0 && (!aName || ctx.indexOf(aName) < 0)) return 'home';
      if (aName && ctx.indexOf(aName) >= 0 && (!hName || ctx.indexOf(hName) < 0)) return 'away';
      return '';
    };
    var homeFullIdx = -1, awayFullIdx = -1, homeHalfIdx = -1, awayHalfIdx = -1;
    statsTables.forEach(function(st, i) {
      var owner = statsOwnerOf(allTables[st.idx]);
      if (owner === 'home') {
        if (homeFullIdx < 0) homeFullIdx = i;
        else if (homeHalfIdx < 0) homeHalfIdx = i;
      } else if (owner === 'away') {
        if (awayFullIdx < 0) awayFullIdx = i;
        else if (awayHalfIdx < 0) awayHalfIdx = i;
      }
    });
    // 未能按队名匹配的，按出现顺序补全（兜底）
    var unmatchedStats = statsTables.map(function(_, i) { return i; }).filter(function(i) {
      return i !== homeFullIdx && i !== awayFullIdx && i !== homeHalfIdx && i !== awayHalfIdx;
    });
    if (homeFullIdx < 0 && unmatchedStats.length > 0) { homeFullIdx = unmatchedStats.shift(); }
    if (awayFullIdx < 0 && unmatchedStats.length > 0) { awayFullIdx = unmatchedStats.shift(); }
    if (homeHalfIdx < 0 && unmatchedStats.length > 0) { homeHalfIdx = unmatchedStats.shift(); }
    if (awayHalfIdx < 0 && unmatchedStats.length > 0) { awayHalfIdx = unmatchedStats.shift(); }
    if (homeFullIdx >= 0) result.homeStats = statsTables[homeFullIdx].data;
    if (awayFullIdx >= 0) result.awayStats = statsTables[awayFullIdx].data;
    if (homeHalfIdx >= 0) result.homeHalfStats = statsTables[homeHalfIdx].data;
    if (awayHalfIdx >= 0) result.awayHalfStats = statsTables[awayHalfIdx].data;

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
    var toNum = function(v) {
      var n = parseFloat(String(v || '').replace(/[^\d.\-]/g, ''));
      return isFinite(n) ? n : NaN;
    };
    var pctObj = function(v) {
      var m = String(v || '').match(/(\d+)\s*\((\d+(?:\.\d+)?)%\)/);
      if (m) return { count: m[1], pct: m[2] };
      var n = String(v || '').match(/^\d+(?:\.\d+)?$/);
      return n ? { count: n[0], pct: '' } : { count: String(v || '').trim(), pct: '' };
    };
    var rowKey = function(label) {
      var l = compact(label);
      if (l === '总' || l === '全部') return 'total';
      if (l === '主' || l === '主场') return 'home';
      if (l === '客' || l === '客场') return 'away';
      if (l === '近6' || l === '近6场') return 'last6';
      return '';
    };
    var teamOwnerByOrder = function(count) { return count < 3 ? 'home' : 'away'; };
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

    // ---- 富统计表：入球分布 / 半全场 / 进球数单双 / 进球时间 ----
    var tableContextText = function(tbl) {
      var ctx = '';
      var node = tbl.previousElementSibling;
      for (var step = 0; node && step < 10; step++, node = node.previousElementSibling) ctx = ' ' + node.textContent + ctx;
      return compact(ctx + ' ' + (tbl.textContent || ''));
    };
    var numericRows = function(tbl) {
      var out = [];
      var rows = tbl.querySelectorAll('tr');
      for (var ri = 0; ri < rows.length; ri++) {
        var cells = getCells(rows[ri]).map(function(c) { return compact(c).replace(/（/g, '(').replace(/）/g, ')'); }).filter(Boolean);
        if (!cells.length) continue;
        var label = cells[0];
        if (!/^(总|主|客|主场|客场)$/.test(label)) continue;
        var vals = [];
        for (var vi = 1; vi < cells.length; vi++) {
          var cv = cells[vi];
          if (/^-?\d+(?:\.\d+)?(?:\([^)]*\))?$/.test(cv) || /^\d+(?:\.\d+)?%\[\d+场\]$/.test(cv)) vals.push(cv);
        }
        if (vals.length) out.push({ label: label, values: vals });
      }
      return out;
    };
    var normalizeVenueLabel = function(label) { return label === '主场' ? '主' : (label === '客场' ? '客' : label); };
    var rowsToObject = function(rows, headers) {
      var obj = {};
      rows.forEach(function(r) {
        var key = normalizeVenueLabel(r.label);
        obj[key] = {};
        headers.forEach(function(h, i) { obj[key][h] = r.values[i] || ''; });
      });
      return obj;
    };
    var parsePercentCell = function(v) {
      var s = String(v || '').replace(/（/g, '(').replace(/）/g, ')');
      var m = s.match(/(\d+)\((\d+(?:\.\d+)?)%\)/);
      return m ? { games: m[1], pct: m[2] } : { games: s, pct: '' };
    };
    var richOwner = function(tbl, ctx) {
      var owner = tableOwner(tbl);
      var homeName = compact(result.matchInfo.home || '');
      var awayName = compact(result.matchInfo.away || '');
      if (!owner && homeName && ctx.indexOf(homeName) >= 0 && (!awayName || ctx.indexOf(awayName) < 0)) owner = 'home';
      if (!owner && awayName && ctx.indexOf(awayName) >= 0 && (!homeName || ctx.indexOf(homeName) < 0)) owner = 'away';
      if (!owner && ctx.indexOf('主队') >= 0 && ctx.indexOf('客队') < 0) owner = 'home';
      if (!owner && ctx.indexOf('客队') >= 0 && ctx.indexOf('主队') < 0) owner = 'away';
      return owner;
    };
    var pickRich = function(list, owner, fallbackIndex) {
      var hasOwner = false;
      for (var i = 0; i < list.length; i++) {
        if (list[i].owner) hasOwner = true;
        if (list[i].owner === owner) return list[i].data;
      }
      return !hasOwner && list[fallbackIndex] ? list[fallbackIndex].data : null;
    };
    var rich = { goalDist: [], halfFull: [], singleDouble: [], goalTime: [], firstGoalTime: [] };
    for (var rti = 0; rti < allTables.length; rti++) {
      var tbl = allTables[rti];
      var tt2 = compact(tbl.textContent || '');
      var ctx2 = tableContextText(tbl);
      var rows2 = numericRows(tbl);
      if (!rows2.length) continue;
      var owner2 = richOwner(tbl, ctx2);
      var item = null;
      if ((/0球1球2球3球4\+/.test(tt2) || /入球数.*上半场.*下半场/.test(ctx2)) && rows2[0].values.length >= 7) {
        item = { owner: owner2, data: rowsToObject(rows2, ['0球','1球','2球','3球','4+','上半场','下半场']) };
        rich.goalDist.push(item);
      } else if ((/胜胜.*胜和.*胜负.*和胜.*和和.*和负.*负胜.*负和.*负负/.test(tt2) || (ctx2.indexOf('半全场') >= 0 && tt2.indexOf('胜胜') >= 0 && tt2.indexOf('负负') >= 0)) && rows2[0].values.length >= 9) {
        item = { owner: owner2, data: rowsToObject(rows2, ['胜胜','胜和','胜负','和胜','和和','和负','负胜','负和','负负']) };
        rich.halfFull.push(item);
      } else if ((tt2.indexOf('大小走单双') >= 0 || (ctx2.indexOf('进球数/单双') >= 0 && tt2.indexOf('大') >= 0 && tt2.indexOf('小') >= 0 && tt2.indexOf('单') >= 0 && tt2.indexOf('双') >= 0)) && rows2[0].values.length >= 5) {
        var sdObj = rowsToObject(rows2, ['大','小','走','单','双']);
        ['总','主','客'].forEach(function(k) {
          if (!sdObj[k]) return;
          Object.keys(sdObj[k]).forEach(function(h) { sdObj[k][h] = parsePercentCell(sdObj[k][h]); });
        });
        rich.singleDouble.push({ owner: owner2, data: sdObj });
      } else if (tt2.indexOf('1-10') >= 0 && (tt2.indexOf('81-90+') >= 0 || tt2.indexOf('81-90') >= 0) && rows2[0].values.length >= 10) {
        item = { owner: owner2, data: rowsToObject(rows2, ['1-10','11-20','21-30','31-40','41-45','46-50','51-60','61-70','71-80','81-90+']) };
        if (/第一个进球|第一個進球|首个进球|首個進球/.test(ctx2)) rich.firstGoalTime.push(item);
        else rich.goalTime.push(item);
      }
    }
    result.recentGoalDistribution.home = pickRich(rich.goalDist, 'home', 0);
    result.recentGoalDistribution.away = pickRich(rich.goalDist, 'away', 1);
    result.halfFull.home = pickRich(rich.halfFull, 'home', 0);
    result.halfFull.away = pickRich(rich.halfFull, 'away', 1);
    result.goalSingleDouble.home = pickRich(rich.singleDouble, 'home', 0);
    result.goalSingleDouble.away = pickRich(rich.singleDouble, 'away', 1);
    // 兼容旧报告字段
    if (result.goalSingleDouble.home && result.goalSingleDouble.home['总']) {
      var hsd = result.goalSingleDouble.home['总'];
      result.goalSingleDouble.homeTotal = { big: hsd['大'], small: hsd['小'], draw: hsd['走'], odd: hsd['单'], even: hsd['双'] };
    }
    if (result.goalSingleDouble.away && result.goalSingleDouble.away['总']) {
      var asd = result.goalSingleDouble.away['总'];
      result.goalSingleDouble.awayTotal = { big: asd['大'], small: asd['小'], draw: asd['走'], odd: asd['单'], even: asd['双'] };
    }
    result.goalTimeDistribution.home = pickRich(rich.goalTime, 'home', 0);
    result.goalTimeDistribution.away = pickRich(rich.goalTime, 'away', 1);
    result.goalTimeDistribution.homeFirst = pickRich(rich.firstGoalTime, 'home', 0);
    result.goalTimeDistribution.awayFirst = pickRich(rich.firstGoalTime, 'away', 1);
    result.goalTimeDistribution.rows = rich.goalTime.map(function(x) { return x.data; });
    result.goalTimeDistribution.firstRows = rich.firstGoalTime.map(function(x) { return x.data; });
    result._debug.richTables = { goalDist: rich.goalDist.length, halfFull: rich.halfFull.length, singleDouble: rich.singleDouble.length, goalTime: rich.goalTime.length, firstGoalTime: rich.firstGoalTime.length };

    // ---- 缺阵球员 ----（DOM解析，表格格式：球员 | 缺阵原因）
    (function() {
      var injTables = [];
      document.querySelectorAll('table').forEach(function(tbl) {
        var tt = tbl.textContent;
        if (tt.indexOf('缺阵原因') >= 0 || tt.indexOf('球员') >= 0 && tt.indexOf('损伤') >= 0) {
          injTables.push(tbl);
        }
      });
      var hName = result.matchInfo.home || '';
      var aName = result.matchInfo.away || '';
      injTables.forEach(function(tbl) {
        // 判断该表属于主队还是客队
        var ctx = '';
        var node = tbl.previousElementSibling;
        for (var s = 0; node && s < 5; s++, node = node.previousElementSibling) ctx += ' ' + node.textContent;
        var side = '';
        if (hName && ctx.indexOf(hName) >= 0 && (!aName || ctx.indexOf(aName) < 0)) side = 'home';
        else if (aName && ctx.indexOf(aName) >= 0 && (!hName || ctx.indexOf(hName) < 0)) side = 'away';
        if (!side) return;
        tbl.querySelectorAll('tr').forEach(function(row) {
          var tds = row.querySelectorAll('td');
          if (tds.length < 2) return;
          // 格式1: "6 (中卫) 球员名" | "缺阵原因"
          var cell0 = tds[0].textContent.trim();
          var cell1 = tds[1].textContent.trim();
          var m2 = cell0.match(/^(\d{1,3})\s+\(([^)]+)\)\s+(.{2,20})$/);
          if (m2 && cell1 && cell1.length >= 2 && cell1 !== '缺阵原因') {
            result.injuries[side].push({ number: m2[1], position: m2[2], name: m2[3].trim(), reason: cell1 });
          }
        });
      });
      // 若DOM方式失败，用文本正则兜底（同行格式：数字 (位置) 姓名\t原因）
      if (result.injuries.home.length === 0 && result.injuries.away.length === 0) {
        var injRe = /(\d{1,3})\s+\(([^)]+)\)\s+([^\t\n]{2,25})[\t ]+([^\n]{2,30})/g;
        var inj = [];
        while ((rm = injRe.exec(text)) !== null) {
          inj.push({ number:rm[1], position:rm[2], name:rm[3].trim(), reason:rm[4].trim() });
        }
        var half = Math.ceil(inj.length / 2);
        result.injuries.home = inj.slice(0, half);
        result.injuries.away = inj.slice(half);
      }
    })();

    // ---- 近10场平均评分 ----
    var homeScoresM = text.match(/主队近10场平均评分:([\s\S]{0,300}?)客队近10场/);
    if (homeScoresM) result.playerRatings.home10 = (homeScoresM[1].match(/\d+\.\d+/g)||[]).slice(0,10);
    var awayScoresM = text.match(/客队近10场平均评分:([\s\S]{0,300}?)(?:\n\n|\n\s*\n)/);
    if (awayScoresM) result.playerRatings.away10 = (awayScoresM[1].match(/\d+\.\d+/g)||[]).slice(0,10);

    // ---- 赛前简报 ----
    var briefM = text.match(/赛前简报[\s\n]+([\s\S]{20,3000}?)(?:\n+(?:本赛季|以上资料|##|\*\*以上))/);
    if (briefM) result.preBriefing = briefM[1].trim();

    // ---- 本赛季数据统计比较 / 主客队得失球统计 ----
    var bracketNums = [];
    var bnRe = /\[(\d+\.?\d*)\s*(?:场)?\]/g;
    while ((rm = bnRe.exec(text)) !== null) bracketNums.push(rm[1]);
    result.dataComparison.allBracketNumbers = bracketNums.slice(0, 80);
    result.dataComparison.allNumbers = result.dataComparison.allBracketNumbers;

    var safeAvgGoal = function(a, b) { a = parseFloat(a); b = parseFloat(b); return (isFinite(a) && isFinite(b) && b > 0) ? (a / b).toFixed(2) : ''; };
    var calcSeason = function(stats, venueKey) {
      var src = stats || {};
      var total = src.total || {};
      var venue = src[venueKey] || {};
      var last6 = src.last6 || {};
      return {
        record: {
          total: total.played ? { winPct: total.winRate || '', winGames: total.win || '', drawGames: total.draw || '', lossGames: total.loss || '' } : null,
          venue: venue.played ? { winPct: venue.winRate || '', winGames: venue.win || '', drawGames: venue.draw || '', lossGames: venue.loss || '' } : null
        },
        goals: {
          total: total.played ? { goalsFor: total.goalsFor || '', goalsAgainst: total.goalsAgainst || '', avgGoal: safeAvgGoal(total.goalsFor, total.played), avgLoss: safeAvgGoal(total.goalsAgainst, total.played) } : null,
          venue: venue.played ? { goalsFor: venue.goalsFor || '', goalsAgainst: venue.goalsAgainst || '', avgGoal: safeAvgGoal(venue.goalsFor, venue.played), avgLoss: safeAvgGoal(venue.goalsAgainst, venue.played) } : null,
          last6: last6.played ? { goalsFor: last6.goalsFor || '', goalsAgainst: last6.goalsAgainst || '', avgGoal: safeAvgGoal(last6.goalsFor, last6.played), avgLoss: safeAvgGoal(last6.goalsAgainst, last6.played) } : null
        }
      };
    };
    result.seasonComparison.home = calcSeason(result.homeStats, 'home');
    result.seasonComparison.away = calcSeason(result.awayStats, 'away');

    var cellNumber = function(cell) {
      var clean = compact(cell).replace(/\[\d+(?:\.\d+)?场\]/g, '');
      var nums = clean.match(/\d+(?:\.\d+)?/g) || [];
      for (var ni = 0; ni < nums.length; ni++) if (nums[ni].indexOf('.') >= 0) return nums[ni];
      return nums.length ? nums[nums.length - 1] : '';
    };
    var readLabeledNumber = function(cells, labels) {
      for (var ci = 0; ci < cells.length; ci++) {
        var c = compact(cells[ci]);
        var hit = false;
        for (var li = 0; li < labels.length; li++) if (c.indexOf(labels[li]) >= 0) hit = true;
        if (!hit) continue;
        var inline = cellNumber(c);
        if (inline) return inline;
        for (var j = ci + 1; j < Math.min(cells.length, ci + 5); j++) {
          var n = cellNumber(cells[j]);
          if (n) return n;
        }
      }
      return '';
    };
    var parseGoalStatTable = function(tbl) {
      var ctx = tableContextText(tbl);
      if (!/(得失球统计|平均入球|平均进球|平均失球|场均入球|场均进球|场均失球)/.test(ctx)) return null;
      var flat = [];
      var rows = tbl.querySelectorAll('tr');
      for (var ri = 0; ri < rows.length; ri++) {
        var cells = getCells(rows[ri]);
        for (var ci = 0; ci < cells.length; ci++) flat.push(cells[ci]);
      }
      var parsed = {
        owner: ctx.indexOf('主队得失球统计') >= 0 ? 'home' : (ctx.indexOf('客队得失球统计') >= 0 ? 'away' : richOwner(tbl, ctx)),
        games: (ctx.match(/\[(\d+(?:\.\d+)?)场\]/) || [,''])[1],
        goalsFor: readLabeledNumber(flat, ['入球数','进球数','总入球','总进球']),
        goalsAgainst: readLabeledNumber(flat, ['失球数','总失球']),
        avgGoal: readLabeledNumber(flat, ['平均入球','平均进球','场均入球','场均进球','均入球','均进球']),
        avgLoss: readLabeledNumber(flat, ['平均失球','场均失球','均失球'])
      };
      return (parsed.avgGoal || parsed.avgLoss || parsed.goalsFor || parsed.goalsAgainst) ? parsed : null;
    };
    var mergeGoalStat = function(side, parsed) {
      if (!parsed) return;
      var comp = result.seasonComparison[side] || { record: {}, goals: {} };
      comp.record = comp.record || {};
      comp.goals = comp.goals || {};
      var total = Object.assign({}, comp.goals.total || {});
      if (parsed.games && !total.played) total.played = parsed.games;
      if (parsed.goalsFor) total.goalsFor = parsed.goalsFor;
      if (parsed.goalsAgainst) total.goalsAgainst = parsed.goalsAgainst;
      if (parsed.avgGoal) total.avgGoal = parsed.avgGoal;
      else if (!total.avgGoal) total.avgGoal = safeAvgGoal(total.goalsFor, total.played);
      if (parsed.avgLoss) total.avgLoss = parsed.avgLoss;
      else if (!total.avgLoss) total.avgLoss = safeAvgGoal(total.goalsAgainst, total.played);
      comp.goals.total = total;
      result.seasonComparison[side] = comp;
    };
    var goalStatTables = [];
    for (var gti = 0; gti < allTables.length; gti++) {
      var gst = parseGoalStatTable(allTables[gti]);
      if (gst) goalStatTables.push(gst);
    }
    var homeGoalStat = goalStatTables.filter(function(x) { return x.owner === 'home'; })[0] || (!goalStatTables.some(function(x) { return x.owner; }) ? goalStatTables[0] : null);
    var awayGoalStat = goalStatTables.filter(function(x) { return x.owner === 'away'; })[0] || (!goalStatTables.some(function(x) { return x.owner; }) ? goalStatTables[1] : null);
    mergeGoalStat('home', homeGoalStat);
    mergeGoalStat('away', awayGoalStat);

    result.dataComparison.home = Object.assign(result.dataComparison.home || {}, result.seasonComparison.home.goals.total || {});
    result.dataComparison.away = Object.assign(result.dataComparison.away || {}, result.seasonComparison.away.goals.total || {});
    result._debug.goalStatTables = goalStatTables.map(function(x) { return { owner: x.owner, games: x.games, avgGoal: x.avgGoal, avgLoss: x.avgLoss, goalsFor: x.goalsFor, goalsAgainst: x.goalsAgainst }; });

    // ---- 对赛往绩 & 近期战绩（文本解析）----
    // 每条记录行格式：类型 日期 主场 比分(半场) 角球 客场 ... 胜负 让球 进球数
    var parseMatchResultRows = function(sectionText) {
      var rows = [];
      var lineRe = /(\w+)\s+(\d{2}-\d{2}-\d{2})\s+(.+?)\s+(\d+-\d+)\((\d+-\d+)\)\s+([\d-]+)\s+(.+?)\s+([\u4e00-\u9fa5勝負平]{1,2})\s+([\u8d62\u8f38\u8d70\u8d62贏輸走]{1,2})\s+([\u5927\u5c0f\u8d70大小走]{1,2})/g;
      var rm2;
      while ((rm2 = lineRe.exec(sectionText)) !== null) {
        rows.push({
          type: rm2[1], date: rm2[2],
          home: rm2[3].trim(), score: rm2[4], halfScore: rm2[5],
          corners: rm2[6], away: rm2[7].trim(),
          result: rm2[8], handicapResult: rm2[9], ouResult: rm2[10]
        });
        if (rows.length >= 10) break;
      }
      return rows;
    };

    // 定位三个区块：对赛往绩 / 主队近期战绩 / 客队近期战绩
    var h2hIdx = text.indexOf('对赛往绩');
    var homeRecentIdx = text.indexOf('近期战绩', h2hIdx + 1);
    var awayRecentIdx = homeRecentIdx > 0 ? text.indexOf('近期战绩', homeRecentIdx + 100) : -1;

    if (h2hIdx >= 0) {
      var h2hEnd = homeRecentIdx > 0 ? homeRecentIdx : h2hIdx + 2000;
      result.headToHead = parseMatchResultRows(text.slice(h2hIdx, h2hEnd));
    }
    if (homeRecentIdx >= 0) {
      var hrEnd = awayRecentIdx > 0 ? awayRecentIdx : homeRecentIdx + 3000;
      result.homeRecentMatches = parseMatchResultRows(text.slice(homeRecentIdx, hrEnd));
    }
    if (awayRecentIdx >= 0) {
      result.awayRecentMatches = parseMatchResultRows(text.slice(awayRecentIdx, awayRecentIdx + 3000));
    }

    var homeGoals = result.seasonComparison.home.goals.total || {};
    var awayGoals = result.seasonComparison.away.goals.total || {};
    var hf = parseFloat(homeGoals.avgGoal);
    var ha = parseFloat(homeGoals.avgLoss);
    var af = parseFloat(awayGoals.avgGoal);
    var aa = parseFloat(awayGoals.avgLoss);
    if (isFinite(hf) || isFinite(ha) || isFinite(af) || isFinite(aa)) {
      result.recentStats = {
        homeFor: isFinite(hf) ? hf : undefined,
        homeAgainst: isFinite(ha) ? ha : undefined,
        awayFor: isFinite(af) ? af : undefined,
        awayAgainst: isFinite(aa) ? aa : undefined,
        leagueAvg: 1.35,
        source: goalStatTables.length ? 'analysis-goal-stat-table' : 'analysis-season-comparison'
      };
    }

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
    // 历史变化表格结构：多列（各公司），每数据行只有一个TD有内容（"盘口 水位1 水位2"），最后列是时间
    // 无法用文本正则跨行匹配，改用DOM遍历
    var WATER_RE2 = /^[01]\.\d{2}$/;
    var TIME_RE2 = /^\d{1,2}-\d{1,2}\s+\d{2}:\d{2}$/;

    var tables = document.querySelectorAll('table');
    for (var ti = 0; ti < tables.length; ti++) {
      var tbl = tables[ti];
      var rows = tbl.querySelectorAll('tr');
      if (rows.length < 5) continue;

      // 检查是否含时间列（历史变化表特征）
      var hasTime = false;
      for (var ri = 0; ri < rows.length; ri++) {
        var lastTd = rows[ri].querySelectorAll('td');
        if (!lastTd.length) continue;
        var lastText = lastTd[lastTd.length - 1].textContent.trim();
        if (TIME_RE2.test(lastText)) { hasTime = true; break; }
      }
      if (!hasTime) continue;

      // 解析表头（公司名）
      var headers = [];
      var headerRow = tbl.querySelector('tr');
      if (headerRow) {
        var hCells = headerRow.querySelectorAll('td,th');
        for (var hi = 0; hi < hCells.length; hi++) {
          headers.push(hCells[hi].textContent.trim().replace(/[*★\s]/g, ''));
        }
      }

      // 解析每行
      for (var ri2 = 0; ri2 < rows.length && history.length < 50; ri2++) {
        var tds = rows[ri2].querySelectorAll('td');
        if (tds.length < 2) continue;
        var lastTdText = tds[tds.length - 1].textContent.trim();
        if (!TIME_RE2.test(lastTdText)) continue;
        var time = lastTdText;
        // 找含水位的TD
        for (var ci = 0; ci < tds.length - 1; ci++) {
          var cellText = tds[ci].textContent.trim();
          if (!cellText) continue;
          var parts = cellText.split(/\s+/).filter(Boolean);
          var waters = parts.filter(function(p) { return WATER_RE2.test(p); });
          if (waters.length >= 2) {
            var lineParts = parts.filter(function(p) { return !WATER_RE2.test(p); });
            history.push({
              time: time,
              company: headers[ci] || '',
              line: lineParts.join(' ') || cellText,
              v1: waters[0],
              v2: waters[1]
            });
            break;
          }
        }
      }
      if (history.length > 0) break; // 只取第一个匹配的历史表
    }
    return history;
  }

  // ===================== 滚球实时数据提取 =====================
  function extractLiveData(text, html) {
    const result = {
      matchInfo: {},        // home / away / league / kickoff
      liveScore: {},        // home / away / score / minute / status
      events: [],           // 进球/红牌事件
      matchStats: {},       // 本场实时技术统计（射门/射正/控球率/角球...）
      recentStats: { home: {}, away: {} }, // 近3/近10场技统
      goalTiming: {},       // 进失球时段（保留扩展）
      asianLive: {},
      ouLive: {},
      suggestions: []
    };

    const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // ---------- 球队名 / 联赛：优先解析 document.title ----------
    // 形如「全南天龙 VS 首尔衣恋(2026赛季韩K2联)-现场分析-...」
    const title = document.title || '';
    let tm = title.match(/^\s*(.+?)\s+VS\s+(.+?)\s*[（(]([^）)]+)[）)]/i);
    if (tm) {
      result.matchInfo.home = tm[1].trim();
      result.matchInfo.away = tm[2].trim();
      result.matchInfo.league = tm[3].trim();
    }
    // 备选：team/Summary 链接（页面顶部主客队链接）
    if (!result.matchInfo.home) {
      const tl = Array.from(document.querySelectorAll('a[href*="team/Summary"]'))
        .map(a => (a.textContent || '').trim())
        .filter(t => t && t.length >= 2 && t.length <= 16);
      const uniq = [...new Set(tl)];
      if (uniq.length >= 2) { result.matchInfo.home = uniq[0]; result.matchInfo.away = uniq[1]; }
    }
    const home = result.matchInfo.home || '';
    const away = result.matchInfo.away || '';

    // 开赛时间：标题或正文里的 yyyy-mm-dd hh:mm
    const koM = text.match(/(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})/);
    if (koM) result.matchInfo.kickoff = koM[1];

    // ---------- 比分：用球队名锚定，避免误配日期/赔率/统计 ----------
    if (home && away) {
      // 主队名 [分隔] 数字 [分隔] 客队名 [分隔] 数字
      const re = new RegExp(escRe(home) + '[\\s_:\\-]*?(\\d{1,2})[\\s_]+' + escRe(away) + '[\\s_:\\-]*?(\\d{1,2})');
      const sm = text.match(re);
      if (sm) {
        result.liveScore.home = parseInt(sm[1], 10);
        result.liveScore.away = parseInt(sm[2], 10);
        result.liveScore.score = sm[1] + ':' + sm[2];
      }
    }
    // 备选：常见比分节点
    if (!result.liveScore.score) {
      const scoreEl = document.querySelector('#mScore, .score, .bf, .LiveScore, .scoreboard');
      if (scoreEl) {
        const m = (scoreEl.textContent || '').match(/(\d{1,2})\s*[-:]\s*(\d{1,2})/);
        if (m) {
          result.liveScore.home = parseInt(m[1], 10);
          result.liveScore.away = parseInt(m[2], 10);
          result.liveScore.score = m[1] + ':' + m[2];
        }
      }
    }

    // ---------- 比赛状态 / 进行分钟 ----------
    if (/完场|完場|已结束/.test(text)) result.liveScore.status = '完场';
    else if (/中场|中場|半场休息/.test(text)) result.liveScore.status = '中场';
    else {
      const minM = text.match(/(\d{1,3})\s*['′’]/);
      if (minM) { result.liveScore.minute = parseInt(minM[1], 10); result.liveScore.status = '进行中'; }
      else result.liveScore.status = '未开始';
    }

    // ---------- 本场实时技术统计 ----------
    // 截取「本场技术统计」区块，减少与近期技统/盘口的误配
    let statText = text;
    const blkM = text.match(/本场技术统计([\s\S]{0,800}?)(技统数据|进失球概率|首发阵容|半场\/全场)/);
    if (blkM) statText = blkM[1];
    // [中文标签, 输出键]，长标签优先，匹配后从片段中移除避免子串重复命中
    const statDefs = [
      ['半场角球', 'halfCorner'], ['半场控球率', 'halfPossession'],
      ['危险进攻', 'dangerAttack'], ['射门不中', 'shotOff'],
      ['控球率', 'possession'], ['任意球', 'freeKick'],
      ['角球', 'corner'], ['射正', 'shotOn'], ['射门', 'shot'],
      ['进攻', 'attack'], ['犯规', 'foul'], ['越位', 'offside'],
      ['黄牌', 'yellow'], ['红牌', 'red']
    ];
    statDefs.forEach(([label, key]) => {
      const re = new RegExp('(\\d+%?)\\s*' + label + '\\s*(\\d+%?)');
      const m = statText.match(re);
      if (m && !result.matchStats[key]) {
        result.matchStats[key] = { label, home: m[1], away: m[2] };
        statText = statText.replace(m[0], ' '); // 移除已命中片段
      }
    });

    // ---------- 进球/红牌事件 ----------
    const evRe = /(\d{1,3})\s*['′’]\s*(入球|进球|乌龙球|点球|两黄变红|红牌)/g;
    let em;
    while ((em = evRe.exec(text)) !== null) {
      const kind = em[2];
      const type = /红/.test(kind) ? 'card' : 'goal';
      result.events.push({ minute: parseInt(em[1], 10), type, kind });
    }

    // ---------- 近期技统（近3 / 近10 场） ----------
    // 行格式：home3 home10 标签 away3 away10
    const recentDefs = ['进球', '失球', '被射门', '角球', '黄牌', '犯规', '控球率'];
    recentDefs.forEach(label => {
      const re = new RegExp('([\\d.]+%?)\\s+([\\d.]+%?)\\s*' + label + '\\s*([\\d.]+%?)\\s+([\\d.]+%?)');
      const m = text.match(re);
      if (m) {
        result.recentStats.home[label] = { n3: m[1], n10: m[2] };
        result.recentStats.away[label] = { n3: m[3], n10: m[4] };
      }
    });

    // ---------- 实时亚盘 / 大小球（从表格保守提取） ----------
    const tables = document.querySelectorAll('table');
    tables.forEach(tbl => {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td')).map(c => (c.innerText || '').trim());
        if (cells.length < 3) return;
        const joined = cells.join(' ');
        const handicapM = joined.match(/([+-]?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)\s+([01]\.\d{2})\s+([01]\.\d{2})/);
        if (handicapM && !result.asianLive.handicap && /让|盘|半|球|平/.test(joined)) {
          result.asianLive.handicap = handicapM[1];
          result.asianLive.homeWater = handicapM[2];
          result.asianLive.awayWater = handicapM[3];
        }
        const ouM = joined.match(/(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)\s*[大]\s*([01]\.\d{2})\s*[小]\s*([01]\.\d{2})/);
        if (ouM && !result.ouLive.line) {
          result.ouLive.line = ouM[1];
          result.ouLive.overWater = ouM[2];
          result.ouLive.underWater = ouM[3];
        }
      });
    });

    // ---------- 进失球时段概率（近30场） ----------
    // 格式: 9% 14% 1~15 10% 14%  (主进 主失 时段 客进 客失)
    const timingDefs = [
      { label: '1~15', key: 't1_15' }, { label: '16~30', key: 't16_30' },
      { label: '31~45', key: 't31_45' }, { label: '46~60', key: 't46_60' },
      { label: '61~75', key: 't61_75' }, { label: '76~90', key: 't76_90' },
      { label: '90+', key: 't90plus' }
    ];
    timingDefs.forEach(({ label, key }) => {
      const re = new RegExp('(\\d+)%\\s+(\\d+)%\\s+' + label.replace('+', '\\+').replace('~', '[~\\-]') + '\\s+(\\d+)%\\s+(\\d+)%');
      const m = text.match(re);
      if (m) result.goalTiming[key] = { label, homeGoal: +m[1], homeConcede: +m[2], awayGoal: +m[3], awayConcede: +m[4] };
    });

    result._fetchTime = Date.now();
    result._textLen = text.length;
    return result;
  }
}

// ===== 滚球建议引擎 =====
/**
 * 基于实时数据计算滚球补单建议
 * @param {object} live - extractLiveData 返回结果
 * @returns {Array} 建议列表 [{type, title, reason, confidence, signal}]
 */
function calcLiveSuggestions(live) {
  const suggestions = [];
  if (!live) return suggestions;
  const { liveScore, matchStats, recentStats, goalTiming, asianLive, ouLive } = live;
  const minute = liveScore?.minute || 0;
  const homeGoals = liveScore?.home ?? 0;
  const awayGoals = liveScore?.away ?? 0;
  const totalGoals = homeGoals + awayGoals;
  const status = liveScore?.status || '';
  const isHalf = /中场/.test(status);
  const isRunning = /进行中/.test(status) || minute > 0;
  if (!isRunning && !isHalf) return suggestions;

  const num = v => parseFloat(String(v || '0').replace('%', '')) || 0;
  const ms = matchStats || {};
  const rs = recentStats || {};

  // ── 技术统计 ──
  const homeShot     = num(ms.shot?.home),     awayShot     = num(ms.shot?.away);
  const homeShotOn   = num(ms.shotOn?.home),   awayShotOn   = num(ms.shotOn?.away);
  const homeDanger   = num(ms.dangerAttack?.home), awayDanger = num(ms.dangerAttack?.away);
  const homeCorner   = num(ms.corner?.home),   awayCorner   = num(ms.corner?.away);
  const homePoss     = num(ms.possession?.home);

  // ── 近期场均（近3场） ──
  const homeAvgGoal    = num(rs.home?.['进球']?.n3);
  const awayAvgGoal    = num(rs.away?.['进球']?.n3);
  const homeAvgConcede = num(rs.home?.['失球']?.n3);
  const awayAvgConcede = num(rs.away?.['失球']?.n3);
  const homeAvgCorner  = num(rs.home?.['角球']?.n3);
  const awayAvgCorner  = num(rs.away?.['角球']?.n3);

  // ── 盘口信息 ──
  const curLine   = asianLive?.handicap || '';   // 即时亚盘盘口
  const curHW     = num(asianLive?.homeWater);   // 即时主水
  const curAW     = num(asianLive?.awayWater);   // 即时客水
  const ouLine    = num(ouLive?.line);            // 即时大小球线
  const ouOver    = num(ouLive?.overWater);       // 即时大球水
  const ouUnder   = num(ouLive?.underWater);      // 即时小球水

  // ── 压力指数（Pressure Index）──
  // 危险进攻权重1，射正权重2，射门权重1
  const homePressureRaw = homeDanger + homeShotOn * 2 + homeShot;
  const awayPressureRaw = awayDanger + awayShotOn * 2 + awayShot;
  const totalPressure   = homePressureRaw + awayPressureRaw || 1;
  const homePressurePct = (homePressureRaw / totalPressure) * 100;
  const awayPressurePct = 100 - homePressurePct;
  const dominantSide    = homePressurePct >= 66 ? 'home' : (awayPressurePct >= 66 ? 'away' : null);

  // ── 角球速率 ──
  const totalCorner  = homeCorner + awayCorner;
  const cornerRate90 = minute > 0 ? (totalCorner / minute) * 90 : 0;
  const avgCornerTotal = homeAvgCorner + awayAvgCorner;

  // ── 大小球水位信号（大球水 < 小球水 → 庄家偏向有球）──
  // 亚盘水位：低水=庄家看好 / 大球水<小球水 → 庄家预期进球
  const ouSignalBig   = ouOver > 0 && ouUnder > 0 && ouOver < ouUnder;  // 大球水低=庄家预期进球
  const ouSignalSmall = ouOver > 0 && ouUnder > 0 && ouUnder < ouOver;  // 小球水低=庄家预期无球

  // ── 亚盘水位方向（主水 vs 客水，低水=庄家看好该队）──
  const asianFavorHome = curHW > 0 && curAW > 0 && curHW < curAW;  // 主水低=庄家看好主队
  const asianFavorAway = curHW > 0 && curAW > 0 && curAW < curHW;  // 客水低=庄家看好客队
  const asianFavorSide = asianFavorHome ? 'home' : (asianFavorAway ? 'away' : null);

  // ── 进失球时段概率 ──
  const gt = goalTiming || {};
  const timingGoalRate = (seg) => (num(gt[seg]?.homeGoal) + num(gt[seg]?.awayGoal)) / 2;
  const currentSegRate = minute <= 15 ? timingGoalRate('t1_15')
    : minute <= 30 ? timingGoalRate('t16_30')
    : minute <= 45 ? timingGoalRate('t31_45')
    : minute <= 60 ? timingGoalRate('t46_60')
    : minute <= 75 ? timingGoalRate('t61_75')
    : timingGoalRate('t76_90');
  // 高危进球段（31-45 / 76-90）
  const isHighGoalWindow = (minute >= 31 && minute <= 45) || (minute >= 76 && minute <= 90);

  // ════════════════════════════════════════════
  // 场景1：压力指数 ≥ 66% — 单边压制进球
  // ════════════════════════════════════════════
  if (dominantSide && minute >= 25 && minute <= 80) {
    const label     = dominantSide === 'home' ? '主队' : '客队';
    const pressPct  = dominantSide === 'home' ? homePressurePct : awayPressurePct;
    const shotOn    = dominantSide === 'home' ? homeShotOn : awayShotOn;
    const danger    = dominantSide === 'home' ? homeDanger : awayDanger;
    // 若盘口方向也支持该队：信心 +10
    const bookBonus = (asianFavorSide === dominantSide) ? 10 : 0;
    const conf      = Math.min(88, 58 + bookBonus + (pressPct - 66) * 0.8);
    const bookNote  = bookBonus > 0 ? `，庄家水位也偏向${label}（低水${dominantSide==='home'?curHW:curAW}）` : '';
    suggestions.push({
      type: 'asian', signal: `⚡压制${label}`,
      title: `${minute}' ${label}压力指数${pressPct.toFixed(0)}%，补${label}进球/让球`,
      confidence: Math.round(conf),
      reason: `${label}危险进攻${danger}次，射正${shotOn}次，压力指数${pressPct.toFixed(0)}%（≥66%为显著压制）${bookNote}`,
    });
  }

  // ════════════════════════════════════════════
  // 场景2：庄家水位异动 → 大球信号（水位升 = 庄家预期无球 vs 降 = 庄家预期有球）
  // ════════════════════════════════════════════
  if (ouLine > 0 && minute >= 20) {
    if (ouSignalBig && totalGoals === 0) {
      // 大球水偏低 + 无进球 = 庄家预期本场有球，值得跟
      const conf = Math.min(82, 60 + (ouUnder - ouOver) * 5);
      suggestions.push({
        type: 'ou', signal: '📉大球水低',
        title: `${minute}' 大球水${ouOver} < 小球水${ouUnder}，庄家偏向有球`,
        confidence: Math.round(conf),
        reason: `即时大球水${ouOver} < 小球水${ouUnder}，低水代表庄家预期有球，${totalGoals === 0 ? '目前0-0，' : ''}盘线${ouLine}，跟大球`,
      });
    }
    if (ouSignalSmall && totalGoals >= 2) {
      // 小球水偏低 + 已有≥2球 = 庄家预期不再进球
      const conf = Math.min(78, 55 + (ouOver - ouUnder) * 5);
      suggestions.push({
        type: 'ou', signal: '📈小球水低',
        title: `${minute}' 小球水${ouUnder} < 大球水${ouOver}，庄家偏向无更多球`,
        confidence: Math.round(conf),
        reason: `已${totalGoals}球，即时小球水${ouUnder} < 大球水${ouOver}，庄家预期不再进球，考虑补小球（${ouLine}以下）`,
      });
    }
  }

  // ════════════════════════════════════════════
  // 场景3：下半场 0-0 大球补单（时间窗口 46-70 分钟）
  // ════════════════════════════════════════════
  if (minute >= 46 && minute <= 70 && totalGoals === 0) {
    const avgExpected = (homeAvgGoal + awayAvgGoal + homeAvgConcede + awayAvgConcede) / 4;
    const lateRate    = (timingGoalRate('t46_60') + timingGoalRate('t61_75') + timingGoalRate('t76_90')) / 3;
    if (avgExpected >= 1.0 || lateRate >= 15 || ouSignalBig) {
      const conf = Math.min(85, 52
        + (avgExpected >= 1.5 ? 10 : avgExpected >= 1.0 ? 5 : 0)
        + (lateRate >= 20 ? 10 : lateRate >= 15 ? 5 : 0)
        + (ouSignalBig ? 8 : 0));
      suggestions.push({
        type: 'ou', signal: '⬆下半大球',
        title: `${minute}' 0-0补大球 (${ouLine || '?'})`,
        confidence: conf,
        reason: `下半场${minute}分仍0-0，双队近期场均进/失球${avgExpected.toFixed(1)}，历史下半场进球率${lateRate.toFixed(0)}%${ouSignalBig ? `，大球水(${ouOver})<小球水(${ouUnder})庄家看好有球` : ''}`,
      });
    }
  }

  // ════════════════════════════════════════════
  // 场景4：高危时段进球（31-45 / 76-90 分钟）
  // ════════════════════════════════════════════
  if (isHighGoalWindow && currentSegRate >= 18) {
    const segLabel = minute <= 45 ? '31~45分' : '76~90分';
    const conf     = Math.min(80, 50 + currentSegRate);
    suggestions.push({
      type: 'goal', signal: '⏰高危时段',
      title: `${minute}' 处于${segLabel}高概率进球段`,
      confidence: Math.round(conf),
      reason: `当前处于${segLabel}，历史该段进球率${currentSegRate.toFixed(0)}%（≥18%为高危段），${totalGoals === 0 ? '0-0攻势更集中' : `${totalGoals}球已入`}，补单价值窗口`,
    });
  }

  // ════════════════════════════════════════════
  // 场景5：角球速率超越历史均值（角球大）
  // ════════════════════════════════════════════
  if (minute >= 20 && cornerRate90 > 0 && avgCornerTotal > 0) {
    const excessRate = cornerRate90 / avgCornerTotal;
    if (cornerRate90 >= 11 || (excessRate >= 1.3 && cornerRate90 >= 9)) {
      const conf = Math.min(80, 50 + (cornerRate90 - 9) * 2.5);
      suggestions.push({
        type: 'corner', signal: '🚩角球速率高',
        title: `${minute}' 角球速率${cornerRate90.toFixed(1)}/90，预计超盘`,
        confidence: Math.round(conf),
        reason: `${minute}分已${totalCorner}角球，推算全场${cornerRate90.toFixed(1)}个，双队近期场均${avgCornerTotal.toFixed(1)}个，速率超出${((excessRate-1)*100).toFixed(0)}%，角球大有价值`,
      });
    }
  }

  // ════════════════════════════════════════════
  // 场景6：追球压力（落后1球 + 攻方近期强）
  // ════════════════════════════════════════════
  if (minute >= 60 && minute <= 85 && Math.abs(homeGoals - awayGoals) === 1) {
    const losingTeam   = homeGoals < awayGoals ? 'home' : 'away';
    const losingAvgG   = losingTeam === 'home' ? homeAvgGoal : awayAvgGoal;
    const losingPressP = losingTeam === 'home' ? homePressurePct : awayPressurePct;
    const losingLabel  = losingTeam === 'home' ? '主队' : '客队';
    if (losingAvgG >= 1.2 || losingPressP >= 55) {
      const conf = Math.min(75, 48
        + (losingAvgG >= 1.5 ? 10 : losingAvgG >= 1.2 ? 5 : 0)
        + (losingPressP >= 60 ? 10 : losingPressP >= 55 ? 5 : 0));
      suggestions.push({
        type: 'goal', signal: '🔥追球进球',
        title: `${minute}' ${losingLabel}落后1球强追，补大球/进球`,
        confidence: conf,
        reason: `${losingLabel}落后1球，近期场均进球${losingAvgG.toFixed(1)}，当前压力指数${losingPressP.toFixed(0)}%，攻势强劲阶段概率高`,
      });
    }
  }

  // ════════════════════════════════════════════
  // 场景7：中场休息 0-0 复盘信号
  // ════════════════════════════════════════════
  if (isHalf && totalGoals === 0) {
    const halfHighPress = Math.max(homePressurePct, awayPressurePct) >= 60;
    const halfOuBig    = ouSignalBig;
    if (halfHighPress || halfOuBig) {
      const label = homePressurePct >= awayPressurePct ? '主队' : '客队';
      const conf  = Math.min(78, 52 + (halfHighPress ? 10 : 0) + (halfOuBig ? 10 : 0));
      suggestions.push({
        type: 'ou', signal: '⏸️中场大球',
        title: `中场0-0，下半场补大球 (${ouLine || '?'})`,
        confidence: conf,
        reason: `上半场0-0，${halfHighPress ? `${label}压力指数${Math.max(homePressurePct,awayPressurePct).toFixed(0)}%` : ''}${halfOuBig ? `，大球水(${ouOver})<小球水(${ouUnder})` : ''}，下半场进球概率高`,
      });
    }
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

// ===== 深度预测编排 (2.0) =====
// 流程：原始数据报告 → 本地量化模型 → 联网情报检索 → AI综合裁决
// 任一辅助环节失败都不阻断主流程，AI 仍可基于原始数据 + 自身联网完成预测。
async function runDeepPrediction(stored, matchId, recentStats) {
  const steps = { quant: false, intel: false };
  let quantResult = null, quantMd = '', intelResult = null, intelMd = '';

  // 1) 生成原始数据报告（事实基础）
  const report = reportGen.generate(stored);

  // 2) 本地量化模型（确定性数学，带推导说明）
  try {
    const md = stored?.data || stored;
    const matchData = {
      winDrawWin: md.winDrawWin || {},
      asian: md.asian || {},
      overunder: md.overunder || {},
      analysis: md.analysis || {}
    };
    // 近期场均：优先用传入值，其次用 analysis 富统计解析值，最后尝试从 live 缓存读取
    let rs = recentStats || md.analysis?.recentStats || null;
    if (!rs) {
      const liveCache = await chrome.storage.local.get(`live_${matchId}`);
      rs = liveCache[`live_${matchId}`]?.data?.recentStats || null;
    }
    quantResult = quantAnalyze(matchData, rs);
    quantMd = quantToMarkdown(quantResult);
    steps.quant = !!quantResult;
  } catch (e) {
    console.warn('[BG] 量化分析失败:', e.message);
    quantMd = '### 📐 本地量化模型参考结论\n> 量化计算异常（' + e.message + '），请依赖原始数据独立判断。';
  }

  // 3) 联网情报检索（多源降级，失败不阻断）
  try {
    const mi = report.structured?.matchInfo || stored?.data?.analysis?.matchInfo || {};
    const home = mi.home || report.structured?.home;
    const away = mi.away || report.structured?.away;
    const league = mi.league || '';
    const { tavilyApiKey: tKey } = await chrome.storage.sync.get('tavilyApiKey');
    intelResult = await gatherMatchIntel({ home, away, league, tavilyApiKey: tKey || '' });
    intelMd = intelToMarkdown(intelResult);
    steps.intel = !!(intelResult && intelResult.ok);
  } catch (e) {
    console.warn('[BG] 情报检索失败:', e.message);
    intelMd = intelToMarkdown(null);
  }

  // 4) AI 深度综合裁决（保留原始数据 + 量化参考 + 情报，启用模型联网）
  const prediction = await aiClient.predictDeep(report, matchId, {
    quantMarkdown: quantMd,
    intelMarkdown: intelMd
  });

  return {
    ok: !prediction?.error,
    error: prediction?.error,
    needConfig: prediction?.needConfig,
    prediction,
    reportMarkdown: report.markdown,
    quant: quantResult,
    quantMarkdown: quantMd,
    intel: intelResult,
    intelMarkdown: intelMd,
    steps
  };
}

// ===== 战绩验证：采集赛果比分 + 判断盘口命中 =====
// 比分来源优先级：滚球/现场分析页(liveScore，完场后即最终比分) → analysis页兜底
async function verifyBetRecord(matchId, betType, selection, matchHome, matchAway) {
  let score = '';
  let homeGoals = NaN, awayGoals = NaN;
  let scoreSource = '';

  // 1) 现场分析页（detail/{id}sb.htm）：extractLiveData 可靠返回 liveScore.score 与完场状态
  try {
    const live = await collectLiveData(matchId);
    const ls = live?.liveScore;
    if (ls && (ls.score || (isFinite(ls.home) && isFinite(ls.away)))) {
      if (isFinite(ls.home) && isFinite(ls.away)) {
        homeGoals = ls.home; awayGoals = ls.away;
      } else {
        const m = String(ls.score).match(/(\d{1,2})\s*[-:]\s*(\d{1,2})/);
        if (m) { homeGoals = parseInt(m[1], 10); awayGoals = parseInt(m[2], 10); }
      }
      if (isFinite(homeGoals) && isFinite(awayGoals)) {
        score = `${homeGoals}:${awayGoals}`;
        scoreSource = 'detail现场分析页';
      }
    }
  } catch (e) { /* 继续兜底 */ }

  // 2) 兜底：analysis 页文本里搜"完(主-客)"或顶部比分
  if (!score) {
    try {
      const dbg = await extractOneTab(`https://zq.titan007.com/analysis/${matchId}cn.htm`, 'debug');
      const sample = (dbg?.textSample || '') + ' ' + (dbg?.title || '');
      const m = sample.match(/完\s*\(?\s*(\d{1,2})\s*[-:]\s*(\d{1,2})\s*\)?/) ||
                sample.match(/(\d{1,2})\s*[-:]\s*(\d{1,2})/);
      if (m) {
        homeGoals = parseInt(m[1], 10); awayGoals = parseInt(m[2], 10);
        score = `${homeGoals}:${awayGoals}`;
        scoreSource = 'analysis页兜底';
      }
    } catch (e) { /* ignore */ }
  }

  if (!score || !isFinite(homeGoals) || !isFinite(awayGoals)) {
    return { ok: false, score: '', betResult: '', autoJudge: '',
      error: '未能获取赛果比分（可能比赛未结束，或页面结构变化）' };
  }

  const totalGoals = homeGoals + awayGoals;
  const diff = homeGoals - awayGoals; // 主队净胜球
  const bt = String(betType || '').toLowerCase();
  const sel = String(selection || '').replace(/\s+/g, '');

  let betResult = '';
  let autoJudge = '';

  // 解析盘口数值，支持 0.25 / 0.5 / 0.75 / 平半(0.25) / 半一(0.75) 等
  const parseHandicapValue = (s) => {
    // 中文盘口词 → 数值
    const cnMap = {
      '平手': 0, '平': 0, '平半': 0.25, '半球': 0.5, '半': 0.5,
      '半一': 0.75, '一球': 1, '一球半': 1.25, '球半': 1.5, '一球半/两球': 1.75,
      '两球': 2, '两球半': 2.5, '三球': 3
    };
    for (const k of Object.keys(cnMap).sort((a, b) => b.length - a.length)) {
      if (s.includes(k)) return cnMap[k];
    }
    // 数字盘口：a/b 取均值（如 0/0.5=0.25, 0.5/1=0.75）
    const frac = s.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if (frac) return (parseFloat(frac[1]) + parseFloat(frac[2])) / 2;
    const single = s.match(/([+-]?\d+(?:\.\d+)?)/);
    if (single) return parseFloat(single[1]);
    return NaN;
  };

  // 走盘判定工具：对 adjusted（让球后净胜）判定输赢，支持 ±0.25 半赢半输
  const judgeQuarter = (adjusted) => {
    if (adjusted >= 0.5) return '✓';
    if (adjusted <= -0.5) return '✗';
    if (adjusted === 0.25) return '◐'; // 半赢
    if (adjusted === -0.25) return '◑'; // 半输
    if (adjusted === 0) return '➖';     // 走盘退款
    return adjusted > 0 ? '✓' : '✗';
  };

  if (bt.includes('大小') || /over|under/i.test(bt) || /大球|小球|进球数/.test(bt) || /大|小|over|under/i.test(sel)) {
    // 大小球：isBig/isSmall 只从 sel 判断，bt 含"大小"两字不能用于判断方向
    const isBig = /大|over/i.test(sel);
    const isSmall = /小|under/i.test(sel);
    // 两者都无法从sel判断时，fallback 看 bt 是否明确只含大/小
    const isBigBt = /^(大球|over)/i.test(bt);
    const isSmallBt = /^(小球|under)/i.test(bt);
    const dirBig  = isBig  || (!isSmall && isBigBt);
    const dirSmall = isSmall || (!isBig && isSmallBt);

    const line = parseHandicapValue(sel.replace(/大|小|over|under/gi, ''));
    if (isFinite(line)) {
      const adj = totalGoals - line;
      let r;
      // .25/.75 盘口：(line*4)%2 !== 0；整数和 .5 盘口：(line*4)%2 === 0
      const isQuarter = (Math.round(line * 4) % 2) !== 0;
      if (isQuarter) {
        // 四分之一盘：分半赢/半输
        if (adj > 0) r = dirBig ? '✓' : dirSmall ? '✗' : '?';
        else if (adj < 0) r = dirBig ? '✗' : dirSmall ? '✓' : '?';
        else r = '➖';
      } else if (adj === 0 && Number.isInteger(line)) {
        r = '➖'; // 整数线正好平局走盘
      } else {
        if (adj > 0) r = dirBig ? '✓' : dirSmall ? '✗' : '?';
        else r = dirBig ? '✗' : dirSmall ? '✓' : '?';
      }
      betResult = r;
      const dir = dirBig ? '大' : dirSmall ? '小' : '未知方向';
      autoJudge = `总进球${totalGoals}，盘口${line}（${dir}）→ ${betResult}`;
    } else {
      autoJudge = `比分${homeGoals}-${awayGoals}，大小盘口无法解析（sel="${sel}"），请手动判断`;
    }
  } else if (bt.includes('亚盘') || bt.includes('让球') || bt.includes('让') || /主|客|home|away/i.test(sel) || (matchHome && sel.includes(matchHome)) || (matchAway && sel.includes(matchAway))) {
    // 亚盘让球
    // 优先用队名判断押主还是押客（AI生成的selection如"阿森纳+0.25"带队名）
    let isHome;
    if (matchHome && matchAway) {
      if (sel.includes(matchHome)) isHome = true;
      else if (sel.includes(matchAway)) isHome = false;
      else isHome = /主|home/i.test(sel) || (!/(客|away)/i.test(sel) && diff >= 0);
    } else {
      isHome = /主|home/i.test(sel) || (!/(客|away)/i.test(sel) && /^[+-]/.test(sel) === false && diff >= 0);
    }
    // 让球方向：选项里带"-"或"受让"语义
    let h = parseHandicapValue(sel);
    if (!isFinite(h)) {
      autoJudge = `比分${homeGoals}-${awayGoals}，让球盘口无法解析，请手动判断`;
    } else {
      // 选项中显式符号：如"主-0.5"表示主让0.5；"主+0.25"主受让
      const signM = sel.match(/([+-])\s*\d/);
      let signed = h;
      if (signM) signed = (signM[1] === '-' ? -1 : 1) * Math.abs(h);
      else if (/受让|\+/.test(sel)) signed = Math.abs(h);
      else signed = -Math.abs(h); // 默认让出
      // adjusted = （主队净胜 if 押主，否则客队净胜） + 让球
      const base = isHome ? diff : -diff;
      const adjusted = base + signed;
      betResult = judgeQuarter(Math.round(adjusted * 4) / 4);
      const sideLabel = isHome ? '主' : '客';
      autoJudge = `比分${homeGoals}-${awayGoals}，押${sideLabel}让${signed}，校正后${adjusted.toFixed(2)} → ${betResult}`;
    }
  } else if (/胜平负|独赢|主胜|客胜|平局/.test(bt) || /主胜|客胜|平局|和/.test(sel)) {
    // 胜平负
    const wantHome = /主胜|主赢/.test(sel) || /主胜/.test(bt);
    const wantAway = /客胜|客赢/.test(sel) || /客胜/.test(bt);
    const wantDraw = /平|和/.test(sel) || /平局/.test(bt);
    const actual = diff > 0 ? 'home' : diff < 0 ? 'away' : 'draw';
    if (wantHome) betResult = actual === 'home' ? '✓' : '✗';
    else if (wantAway) betResult = actual === 'away' ? '✓' : '✗';
    else if (wantDraw) betResult = actual === 'draw' ? '✓' : '✗';
    autoJudge = `比分${homeGoals}-${awayGoals}（${actual === 'home' ? '主胜' : actual === 'away' ? '客胜' : '平局'}） → ${betResult}`;
  } else {
    // 角球/其它：仅返回比分，提示手动
    autoJudge = `比分 ${homeGoals}-${awayGoals}（来源:${scoreSource}），该盘口类型需手动判断`;
  }

  return { ok: true, score, betResult, autoJudge, scoreSource };
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

// ===== 公共 PHP + MySQL 同步网关 =====
async function getPublicSyncSettings() {
  const s = await chrome.storage.sync.get(PUBLIC_SYNC_KEYS);
  // 优先用已保存的 apiUrl，否则用默认地址
  const DEFAULT_API_URL = 'http://cdu.cc.cd/football-api/api.php';
  const apiUrl = String(s.publicApiUrl || DEFAULT_API_URL).trim();
  const adminKey = String(s.publicAdminKey || '').trim();
  const hasValidUrl = /^https?:\/\//i.test(apiUrl);
  // publicSyncEnabled 未明确保存时（undefined），只要 apiUrl 有效就默认启用
  const enabled = (s.publicSyncEnabled === undefined ? hasValidUrl : !!s.publicSyncEnabled) && hasValidUrl;
  return {
    enabled,
    apiUrl,
    adminKey,
    isAdmin: enabled && !!adminKey
  };
}

function buildPublicApiUrl(apiUrl, action, params = {}) {
  const url = new URL(apiUrl);
  url.searchParams.set('action', action);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return url.toString();
}

async function publicApi(action, options = {}) {
  const settings = options.settings || await getPublicSyncSettings();
  if (!settings.enabled) throw new Error('公共数据同步未启用或 API 地址无效');
  if (options.requireAdmin && !settings.isAdmin) throw new Error('普通用户只读：缺少管理员密钥');

  const headers = { 'Content-Type': 'application/json' };
  if (settings.adminKey) {
    headers.Authorization = `Bearer ${settings.adminKey}`;
    headers['X-Api-Key'] = settings.adminKey;
  }

  let fetchUrl = buildPublicApiUrl(settings.apiUrl, action, options.params);
  let resp;
  try {
    resp = await fetch(fetchUrl, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
  } catch (fetchErr) {
    // https 失败时自动降级 http 重试一次
    if (fetchUrl.startsWith('https://')) {
      fetchUrl = fetchUrl.replace(/^https:\/\//, 'http://');
      resp = await fetch(fetchUrl, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } else {
      throw fetchErr;
    }
  }

  let json = null;
  try { json = await resp.json(); } catch (_) {}
  if (!resp.ok || json?.ok === false) {
    const msg = json?.error || `公共 API 请求失败（HTTP ${resp.status}）`;
    const err = new Error(msg);
    err.status = resp.status;
    err.response = json;
    throw err;
  }
  return json || { ok: true };
}

async function uploadPublicMatchDataIfAdmin(matchId, data) {
  const settings = await getPublicSyncSettings();
  if (!settings.enabled || !settings.isAdmin) return false;
  try {
    await publicApi('match.upsert', {
      settings,
      requireAdmin: true,
      method: 'POST',
      body: { matchId, data }
    });
    return true;
  } catch (e) {
    console.warn('[BG] 公共比赛数据上传失败:', e.message);
    return false;
  }
}

async function loadPublicMatchData(matchId) {
  const settings = await getPublicSyncSettings();
  if (!settings.enabled || !matchId) return null;
  try {
    const resp = await publicApi('match.get', { settings, params: { matchId } });
    const m = resp.match;
    if (!m?.data) return null;
    return {
      matchId: String(m.matchId || matchId),
      fetchTime: m.updatedAt ? Date.parse(m.updatedAt) || Date.now() : Date.now(),
      data: m.data,
      public: true,
      serverUpdatedAt: m.updatedAt || ''
    };
  } catch (e) {
    if (e.status !== 404) console.warn('[BG] 公共比赛数据读取失败:', e.message);
    return null;
  }
}

async function officialRecordPermission() {
  const settings = await getPublicSyncSettings();
  if (!settings.enabled) {
    return { publicSyncEnabled: false, canManage: true, isAdmin: true, mode: 'local' };
  }
  if (settings.isAdmin) {
    return { publicSyncEnabled: true, canManage: true, isAdmin: true, mode: 'official', settings };
  }
  return {
    publicSyncEnabled: true,
    canManage: false,
    isAdmin: false,
    mode: 'official',
    settings,
    reason: '普通用户只能查看官方战绩；自己的 AI 推荐会保存为本地私有记录，不会发布到官方战绩'
  };
}

async function getOfficialBetRecords() {
  const permission = await officialRecordPermission();
  if (!permission.publicSyncEnabled) {
    const r = await chrome.storage.local.get('bet_records');
    return {
      ok: true,
      records: r.bet_records || [],
      publicSyncEnabled: false,
      canManageOfficialRecords: true,
      isAdmin: true,
      mode: 'local'
    };
  }

  try {
    const resp = await publicApi('record.list', {
      settings: permission.settings,
      params: { limit: OFFICIAL_RECORD_LIMIT }
    });
    const records = (resp.records || []).map(r => ({ ...r, official: true }));
    await chrome.storage.local.set({ official_bet_records_cache: records });
    return {
      ok: true,
      records,
      publicSyncEnabled: true,
      canManageOfficialRecords: permission.canManage,
      isAdmin: permission.isAdmin,
      mode: 'official'
    };
  } catch (e) {
    const cache = await chrome.storage.local.get('official_bet_records_cache');
    return {
      ok: true,
      records: cache.official_bet_records_cache || [],
      publicSyncEnabled: true,
      canManageOfficialRecords: permission.canManage,
      isAdmin: permission.isAdmin,
      mode: 'official',
      offline: true,
      error: e.message
    };
  }
}

async function saveRecordsToLocalKey(storageKey, betRecords) {
  const r = await chrome.storage.local.get(storageKey);
  const existing = r[storageKey] || [];
  const newIds = new Set(betRecords.map(b => b.id));
  const merged = [...betRecords, ...existing.filter(b => !newIds.has(b.id))];
  while (merged.length > 500) merged.pop();
  await chrome.storage.local.set({ [storageKey]: merged });
  return merged;
}

async function saveBetRecordsByRole(betRecords) {
  betRecords = Array.isArray(betRecords) ? betRecords : [];
  if (!betRecords.length) return { ok: true, count: 0 };

  const permission = await officialRecordPermission();
  if (!permission.publicSyncEnabled) {
    await saveRecordsToLocalKey('bet_records', betRecords);
    return { ok: true, count: betRecords.length, mode: 'local', canManageOfficialRecords: true };
  }

  if (!permission.canManage) {
    const privateRecords = betRecords.map(r => ({ ...r, official: false, private: true }));
    await saveRecordsToLocalKey('private_bet_records', privateRecords);
    return {
      ok: true,
      count: betRecords.length,
      savedPrivate: true,
      mode: 'private',
      canManageOfficialRecords: false,
      message: '普通用户推荐已保存为本地私有记录，未发布到官方战绩'
    };
  }

  const officialRecords = betRecords.map(r => ({ ...r, official: true }));
  const resp = await publicApi('record.upsert', {
    settings: permission.settings,
    requireAdmin: true,
    method: 'POST',
    body: { records: officialRecords }
  });
  return { ok: true, count: resp.count ?? officialRecords.length, mode: 'official', canManageOfficialRecords: true };
}

async function updateOfficialBetRecordByRole(id, patch) {
  const permission = await officialRecordPermission();
  if (!permission.publicSyncEnabled) {
    const r = await chrome.storage.local.get('bet_records');
    const records = r.bet_records || [];
    const rec = records.find(x => x.id === id);
    if (rec) {
      if (patch.actualScore !== undefined) rec.actualScore = patch.actualScore;
      if (patch.betResult !== undefined) rec.betResult = patch.betResult;
    }
    await chrome.storage.local.set({ bet_records: records });
    return { ok: true, mode: 'local', record: rec || null };
  }
  if (!permission.canManage) return { ok: false, error: permission.reason };

  const resp = await publicApi('record.update', {
    settings: permission.settings,
    requireAdmin: true,
    method: 'POST',
    body: { id, ...patch }
  });
  return { ok: true, mode: 'official', record: resp.record || null };
}

async function deleteOfficialBetRecordByRole(id) {
  const permission = await officialRecordPermission();
  if (!permission.publicSyncEnabled) {
    const r = await chrome.storage.local.get('bet_records');
    const records = (r.bet_records || []).filter(x => x.id !== id);
    await chrome.storage.local.set({ bet_records: records });
    return { ok: true, mode: 'local' };
  }
  if (!permission.canManage) return { ok: false, error: permission.reason };

  await publicApi('record.delete', {
    settings: permission.settings,
    requireAdmin: true,
    method: 'POST',
    body: { id }
  });
  return { ok: true, mode: 'official' };
}

async function deleteOfficialBetRecordsByDateByRole(date) {
  const permission = await officialRecordPermission();
  if (!permission.publicSyncEnabled) {
    const r = await chrome.storage.local.get('bet_records');
    const records = (r.bet_records || []).filter(x => x.date !== date);
    await chrome.storage.local.set({ bet_records: records });
    return { ok: true, mode: 'local' };
  }
  if (!permission.canManage) return { ok: false, error: permission.reason };

  await publicApi('record.deleteDate', {
    settings: permission.settings,
    requireAdmin: true,
    method: 'POST',
    body: { date }
  });
  return { ok: true, mode: 'official' };
}

async function saveVerifiedBetResult(recordId, matchId, betType, selection, verifyRes) {
  const permission = await officialRecordPermission();
  let targetId = recordId || '';

  if (!targetId) {
    if (permission.publicSyncEnabled) {
      const list = await getOfficialBetRecords();
      targetId = list.records?.find(x => x.matchId === matchId && x.betType === betType && x.selection === selection)?.id || '';
    } else {
      const r = await chrome.storage.local.get('bet_records');
      targetId = (r.bet_records || []).find(x => x.matchId === matchId && x.betType === betType && x.selection === selection)?.id || '';
    }
  }

  if (!targetId) return { ok: false, error: '未找到需要写回的战绩记录' };
  return updateOfficialBetRecordByRole(targetId, { actualScore: verifyRes.score, betResult: verifyRes.betResult });
}

async function storeData(matchId, data) {
  const entry = { matchId, fetchTime: Date.now(), data };
  await chrome.storage.local.set({ [`match_${matchId}`]: entry });
  await uploadPublicMatchDataIfAdmin(matchId, data);
}

async function getStoredData(matchId) {
  const r = await chrome.storage.local.get(`match_${matchId}`);
  if (r[`match_${matchId}`]) return r[`match_${matchId}`];

  const publicEntry = await loadPublicMatchData(matchId);
  if (publicEntry) {
    await chrome.storage.local.set({ [`match_${matchId}`]: publicEntry });
    return publicEntry;
  }
  return null;
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
