/**
 * daily-analyzer.js
 * 今日比赛分析模块 - 联赛热门排序、盈利性评估、持久化记录
 */

// 联赛热门优先级配置
const LEAGUE_PRIORITY = {
  // 顶级: 世界杯/欧冠/欧联/亚冠 = 100
  tier1: {
    score: 100,
    patterns: ['世界杯', 'FIFA', '欧冠', '冠军联赛', '欧洲杯', '美洲杯', '非洲杯', '亚洲杯', '金杯赛', 'Champions', 'Europa League', '欧联']
  },
  // 五大联赛 = 80
  tier2: {
    score: 80,
    patterns: ['英超', '西甲', '德甲', '意甲', '法甲', 'Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1']
  },
  // 热门联赛 = 60
  tier3: {
    score: 60,
    patterns: ['葡超', '荷甲', '比甲', '土超', '俄超', '苏超', '英冠', '西乙', '意乙', '德乙', '法乙', '欧洲联盟杯', 'MLS', 'J联赛', 'K联赛', '中超', '澳超', '巴西', '阿根廷', '国际', '友谊']
  }
  // 其他 = 20
};

/**
 * 根据联赛名称获取优先级分数
 */
function getLeaguePriority(leagueName) {
  if (!leagueName) return 20;
  const name = String(leagueName);
  for (const tier of [LEAGUE_PRIORITY.tier1, LEAGUE_PRIORITY.tier2, LEAGUE_PRIORITY.tier3]) {
    if (tier.patterns.some(p => name.includes(p))) return tier.score;
  }
  return 20;
}

/**
 * 获取联赛分类标签
 */
function getLeagueTierLabel(leagueName) {
  if (!leagueName) return '其他';
  const name = String(leagueName);
  if (LEAGUE_PRIORITY.tier1.patterns.some(p => name.includes(p))) return '顶级赛事';
  if (LEAGUE_PRIORITY.tier2.patterns.some(p => name.includes(p))) return '五大联赛';
  if (LEAGUE_PRIORITY.tier3.patterns.some(p => name.includes(p))) return '热门联赛';
  return '其他';
}

/**
 * 计算比赛可投注盈利性评分 (0-100)
 * 基于亚盘、欧赔、大小球综合评估
 */
function calcProfitabilityScore(matchData) {
  if (!matchData) return { score: 0, signals: [], recommendation: '数据不足' };

  const signals = [];
  let score = 50; // 基础分

  const { asian, overunder, winDrawWin, analysis } = matchData;

  // === 亚盘分析 ===
  if (asian && !asian.error && asian.companies?.length > 0) {
    const ao = asian.keyOdds?.ao;
    if (ao) {
      const homePay = parseFloat(ao.currentHomePay || ao.initialHomePay);
      const awayPay = parseFloat(ao.currentAwayPay || ao.initialAwayPay);
      const handicap = parseFloat(ao.currentHandicap || ao.initialHandicap);

      // 水位异常检测
      if (isFinite(homePay) && isFinite(awayPay)) {
        const diff = Math.abs(homePay - awayPay);
        if (diff < 0.03) {
          signals.push({ type: 'asian', level: 'high', msg: '亚盘水位平衡，双方势均力敌' });
          score += 8;
        } else if (diff > 0.1) {
          const favorSide = homePay > awayPay ? '客' : '主';
          signals.push({ type: 'asian', level: 'medium', msg: `亚盘水位倾向${favorSide}队` });
          score += 5;
        }
      }

      // 让球分析
      if (isFinite(handicap)) {
        if (handicap === 0) signals.push({ type: 'asian', level: 'high', msg: '亚盘平手盘，高关注' });
        else if (Math.abs(handicap) <= 0.5) signals.push({ type: 'asian', level: 'medium', msg: `亚盘让${handicap > 0 ? '主' : '客'}${Math.abs(handicap)}球` });
      }
    }

    // 公司数量
    if (asian.companies.length >= 5) score += 5;
  } else {
    score -= 10;
  }

  // === 欧赔分析 ===
  if (winDrawWin && !winDrawWin.error && winDrawWin.summary) {
    const sum = winDrawWin.summary;
    if (sum.averageReturnRate) {
      const rr = parseFloat(sum.averageReturnRate);
      if (rr >= 93) {
        signals.push({ type: 'europe', level: 'high', msg: `欧赔返还率高(${sum.averageReturnRate})，市场效率高` });
        score += 8;
      }
    }
    if (sum.impliedAverage) {
      const winP = parseFloat(sum.impliedAverage.win);
      const drawP = parseFloat(sum.impliedAverage.draw);
      const lossP = parseFloat(sum.impliedAverage.loss);
      // 结果倾向明确
      if (Math.max(winP, drawP, lossP) > 60) {
        const dominant = winP > drawP && winP > lossP ? '主胜' : lossP > winP && lossP > drawP ? '客胜' : '平局';
        signals.push({ type: 'europe', level: 'medium', msg: `欧赔市场偏向${dominant}(${Math.max(winP, drawP, lossP).toFixed(0)}%)` });
        score += 5;
      }
    }
    // 欧赔变化方向
    if (sum.movement) {
      const m = sum.movement;
      if (m.winDown > m.winUp * 2) {
        signals.push({ type: 'europe', level: 'high', msg: '主胜赔率普遍下降，主队被看好' });
        score += 6;
      } else if (m.lossDown > m.lossUp * 2) {
        signals.push({ type: 'europe', level: 'high', msg: '客胜赔率普遍下降，客队被看好' });
        score += 6;
      }
    }
  }

  // === 大小球分析 ===
  if (overunder && !overunder.error && overunder.companies?.length > 0) {
    const ao = overunder.keyOdds?.ao;
    if (ao) {
      const line = parseFloat(ao.currentLine || ao.initialLine);
      if (isFinite(line)) {
        if (line >= 2.5 && line <= 3) {
          signals.push({ type: 'ou', level: 'medium', msg: `大小球标准盘口(${line})，进球预测适中` });
          score += 3;
        }
      }
    }
  }

  // === 历史战绩 ===
  if (analysis && !analysis.error) {
    const home = analysis.homeStats;
    const away = analysis.awayStats;
    if (home?.winRate || away?.winRate) {
      score += 5;
      signals.push({ type: 'stats', level: 'low', msg: '有历史战绩数据参考' });
    }
  }

  score = Math.max(0, Math.min(100, score));

  let recommendation;
  if (score >= 75) recommendation = '强烈推荐';
  else if (score >= 60) recommendation = '推荐';
  else if (score >= 45) recommendation = '一般';
  else recommendation = '观望';

  return { score, signals, recommendation };
}

/**
 * 从今日比赛列表页面提取比赛
 * 解析 oldIndexall.aspx 页面中的比赛信息
 */
function parseTodayMatchesFromHtml(html, text) {
  const matches = [];

  // 解析"析"字链接，提取比赛ID和名称
  // 链接格式类似 href="detail/2925444sb.htm" 或 href="/zjAnalysis/2925444cn.htm" 
  const analysisLinkRe = /href=['"](?:[^'"]*\/)?(\d{6,8})(?:cn|sb)?\.htm['"]/gi;
  const leagueMatchMap = new Map();

  // 尝试从行中提取比赛信息
  const rows = html.split(/<tr[^>]*>/i).slice(1);
  
  rows.forEach(row => {
    // 提取ID
    const idMatch = row.match(/href=['"][^'"]*?(\d{6,8})(?:cn|sb)?\.htm['"]/i);
    if (!idMatch) return;
    const matchId = idMatch[1];

    // 提取文本内容
    const cellTexts = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRe.exec(row)) !== null) {
      const t = cm[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (t) cellTexts.push(t);
    }

    if (cellTexts.length < 3) return;

    // 比赛时间
    const timeMatch = row.match(/(\d{1,2}:\d{2})/);
    const matchTime = timeMatch ? timeMatch[1] : '';

    // 联赛名（通常在前面的格中）
    let league = '';
    let home = '';
    let away = '';
    let score = '';

    // 简单解析：找球队名（包含vs的行）
    const vsMatch = row.match(/([^\s<>]{2,12})\s*(?:vs|VS|对|－)\s*([^\s<>]{2,12})/);
    if (vsMatch) {
      home = vsMatch[1].trim();
      away = vsMatch[2].trim();
    }

    // 联赛通常是第一个有汉字的单元格，长度2-15
    for (const cell of cellTexts) {
      if (/[\u4e00-\u9fa5]/.test(cell) && cell.length >= 2 && cell.length <= 20 && !cell.includes('vs') && !cell.includes('VS')) {
        if (!league) league = cell;
        break;
      }
    }

    // 比分
    const scoreMatch = row.match(/(\d+)\s*[:\-]\s*(\d+)/);
    if (scoreMatch) score = `${scoreMatch[1]}:${scoreMatch[2]}`;

    if (matchId && !matches.find(m => m.id === matchId)) {
      matches.push({
        id: matchId,
        league: league || '未知',
        home: home || '主队',
        away: away || '客队',
        time: matchTime,
        score: score || '-',
        status: score && score !== '-' ? 'live' : 'upcoming',
        leaguePriority: getLeaguePriority(league),
        leagueTier: getLeagueTierLabel(league)
      });
    }
  });

  // 如果行解析失败，用正则从全文提取ID
  if (matches.length === 0) {
    const allIds = new Set();
    let m;
    while ((m = analysisLinkRe.exec(html)) !== null) {
      const id = m[1];
      if (id && !allIds.has(id)) {
        allIds.add(id);
        matches.push({
          id,
          league: '未知',
          home: '主队',
          away: '客队',
          time: '',
          score: '-',
          status: 'upcoming',
          leaguePriority: 20,
          leagueTier: '其他'
        });
      }
    }
  }

  return matches;
}

/**
 * 评估单场比赛的投注价值建议
 */
function buildAIPromptForDailyMatch(match, matchData) {
  const { id, league, home, away, time } = match;
  let prompt = `请分析以下比赛的投注价值：\n\n`;
  prompt += `比赛：${home} vs ${away}\n`;
  prompt += `联赛：${league}\n`;
  prompt += `时间：${time}\n`;
  prompt += `比赛ID：${id}\n\n`;

  if (matchData) {
    const { asian, overunder, winDrawWin, analysis } = matchData;
    if (winDrawWin?.summary?.averageCurrent) {
      const s = winDrawWin.summary.averageCurrent;
      prompt += `欧赔均值：主${s.win} 平${s.draw} 客${s.loss}\n`;
    }
    if (winDrawWin?.summary?.impliedAverage) {
      const s = winDrawWin.summary.impliedAverage;
      prompt += `欧赔概率：主胜${s.win} 平${s.draw} 客胜${s.loss}\n`;
    }
    if (asian?.keyOdds?.ao) {
      const ao = asian.keyOdds.ao;
      prompt += `亚盘主要盘口：${ao.currentHandicap || ao.initialHandicap} 主水${ao.currentHomePay || ao.initialHomePay} 客水${ao.currentAwayPay || ao.initialAwayPay}\n`;
    }
    if (overunder?.keyOdds?.ao) {
      const ao = overunder.keyOdds.ao;
      prompt += `大小球：${ao.currentLine || ao.initialLine} 大${ao.currentOver || ao.initialOver} 小${ao.currentUnder || ao.initialUnder}\n`;
    }
    if (analysis?.matchInfo) {
      const mi = analysis.matchInfo;
      if (mi.weather) prompt += `天气：${mi.weather} ${mi.temperature || ''}\n`;
    }
  }

  prompt += `\n请提供：1. 是否值得投注 2. 推荐方向（主胜/平/客胜/大/小/主让/客让） 3. 投注建议和理由（简洁）`;
  return prompt;
}

/**
 * 构建批量今日比赛AI推送提示词
 */
function buildBatchAIPrompt(matchItems) {
  let prompt = `今日足球比赛批量投注分析（${new Date().toLocaleDateString('zh-CN')}）\n\n`;
  prompt += `请对以下${matchItems.length}场比赛逐一分析投注价值，给出推荐方向、置信度和简要理由。最后汇总最高价值的3-5场重点推荐。\n\n`;

  matchItems.forEach((item, i) => {
    prompt += `【${i + 1}】${item.match.league} - ${item.match.home} vs ${item.match.away} (${item.match.time})\n`;
    if (item.matchData) {
      const { winDrawWin, asian, overunder } = item.matchData;
      if (winDrawWin?.summary?.averageCurrent) {
        const s = winDrawWin.summary.averageCurrent;
        prompt += `  欧赔：主${s.win}/平${s.draw}/客${s.loss}`;
        if (winDrawWin.summary.impliedAverage) {
          const imp = winDrawWin.summary.impliedAverage;
          prompt += ` [概率 ${imp.win}/${imp.draw}/${imp.loss}]`;
        }
        prompt += '\n';
      }
      if (asian?.keyOdds?.ao) {
        const ao = asian.keyOdds.ao;
        prompt += `  亚盘：${ao.currentHandicap ?? ao.initialHandicap} 主水${ao.currentHomePay ?? ao.initialHomePay}/客水${ao.currentAwayPay ?? ao.initialAwayPay}\n`;
      }
      if (overunder?.keyOdds?.ao) {
        const ao = overunder.keyOdds.ao;
        prompt += `  大小球：${ao.currentLine ?? ao.initialLine} 大${ao.currentOver ?? ao.initialOver}/小${ao.currentUnder ?? ao.initialUnder}\n`;
      }
    }
    prompt += `  价值评分：${item.profitability?.score ?? '-'} 初步判断：${item.profitability?.recommendation ?? '待分析'}\n\n`;
  });

  prompt += `输出格式：\n每场：[序号] 推荐/观望 - 方向 - 理由（30字内）\n最后：重点推荐TOP3（按价值排序）`;
  return prompt;
}

/**
 * 解析AI返回的投注建议，提取每场推荐
 */
function parseAIBetAdvice(aiContent, matchItems) {
  const results = [];
  const lines = aiContent.split('\n');

  matchItems.forEach((item, i) => {
    const idx = i + 1;
    // 查找对应行
    const line = lines.find(l => {
      const m = l.match(/^[\[【]?(\d+)[\]】]?\s*/);
      return m && parseInt(m[1]) === idx;
    }) || '';

    let recommendation = '';
    let direction = '';
    let reason = '';

    // 解析推荐方向
    const recMatch = line.match(/(推荐|强烈推荐|建议|观望|不推荐)/);
    if (recMatch) recommendation = recMatch[1];
    const dirMatch = line.match(/(主胜|平局|客胜|大球|小球|主让|客让|亚主|亚客)/);
    if (dirMatch) direction = dirMatch[1];
    const dashParts = line.split('-');
    if (dashParts.length >= 3) reason = dashParts.slice(2).join('-').trim().slice(0, 60);

    results.push({
      matchId: item.match.id,
      recommendation: recommendation || (line.includes('推荐') ? '推荐' : '观望'),
      direction,
      reason,
      rawLine: line.trim()
    });
  });

  return results;
}

export {
  getLeaguePriority,
  getLeagueTierLabel,
  calcProfitabilityScore,
  parseTodayMatchesFromHtml,
  buildAIPromptForDailyMatch,
  buildBatchAIPrompt,
  parseAIBetAdvice
};
