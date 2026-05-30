/**
 * Predictor - 内置预测算法（支持赛前 + 滚球实时预测）
 */
export class Predictor {

  predict(stored) {
    const { data, fetchTime } = stored;
    const liveData = data?.live || null;
    const isLive = liveData && liveData.minute > 0;

    const result = {
      matchId: stored.matchId,
      generatedAt: new Date().toISOString(),
      fetchTime,
      isLive,
      confidence: 0,
      recommendations: [],
      liveRecommendations: [],
      analysis: {},
      alerts: [] // 重要提示
    };

    if (!data) { result.error = '无数据'; return result; }

    const { analysis, asian, overunder, corner } = data;

    // 盘口分析
    const asianAnalysis = this._analyzeAsian(asian);
    const ouAnalysis = this._analyzeOverUnder(overunder);
    const cornerAnalysis = this._analyzeCorner(corner);
    const statsAnalysis = this._analyzeStats(analysis);

    result.analysis = { asian: asianAnalysis, overunder: ouAnalysis, corner: cornerAnalysis, stats: statsAnalysis };

    // 综合评分
    const composite = this._compositeScore(asianAnalysis, ouAnalysis, statsAnalysis, analysis);
    result.confidence = composite.confidence;
    result.recommendations = composite.recommendations;
    result.summary = composite.summary;
    result.alerts = composite.alerts;

    // 滚球预测
    if (isLive) {
      result.liveRecommendations = this._livePredict(liveData, asianAnalysis, ouAnalysis, data);
    }

    return result;
  }

  _analyzeAsian(asian) {
    if (!asian || asian.error) return { valid: false, reason: '数据缺失', signals: [] };

    const res = { valid: true, signals: [] };
    const { summary, companies } = asian;

    // 升降盘分析
    const up = parseInt(summary?.up || 0);
    const down = parseInt(summary?.down || 0);
    if (up > down * 2 && up >= 3) {
      res.signals.push({ signal: 'bullish_home', desc: `升盘${up}家>降盘${down}家，主队被看好`, weight: 2 });
    } else if (down > up * 2 && down >= 3) {
      res.signals.push({ signal: 'bullish_away', desc: `降盘${down}家>升盘${up}家，客队被看好`, weight: 2 });
    }

    // 高低水分析
    const high = parseInt(summary?.highWater || 0);
    const low = parseInt(summary?.lowWater || 0);
    if (high > 8) {
      res.signals.push({ signal: 'high_water', desc: `高水${high}家，资金流向客队`, weight: 1 });
    }

    // 主流盘口
    res.mainLine = summary?.mainLine || '';

    // 澳门/第一家公司盘口分析
    const aoCompany = companies?.[0];
    if (aoCompany?.mainLine) {
      const ml = aoCompany.mainLine;
      const initHome = parseFloat(ml.initialHome || 0);
      const currHome = parseFloat(ml.currentHome || 0);
      const initAway = parseFloat(ml.initialAway || 0);
      const currAway = parseFloat(ml.currentAway || 0);

      res.aoInitial = { line: ml.initialHandicap, home: initHome, away: initAway };
      res.aoCurrent = { line: ml.currentHandicap, home: currHome, away: currAway };

      // 水位变化
      if (initHome - currHome > 0.05) {
        res.signals.push({ signal: 'ao_home_water_down', desc: `澳门主队水位降(${initHome}→${currHome})，主队受欢迎`, weight: 2 });
      } else if (currHome - initHome > 0.05) {
        res.signals.push({ signal: 'ao_home_water_up', desc: `澳门主队水位升(${initHome}→${currHome})，主队不受欢迎`, weight: -1 });
      }

      if (initAway - currAway > 0.05) {
        res.signals.push({ signal: 'ao_away_water_down', desc: `澳门客队水位降(${initAway}→${currAway})，客队受欢迎`, weight: 2 });
      }

      // 盘口变动
      if (ml.initialHandicap !== ml.currentHandicap) {
        res.signals.push({ signal: 'handicap_changed', desc: `澳门盘口变动: ${ml.initialHandicap}→${ml.currentHandicap}`, weight: 1 });
      }

      res.handicapLine = ml.currentHandicap;
      res.homeGiving = this._handicapValue(ml.currentHandicap) <= 0;
    }

    // 多家公司一致性分析
    if (Array.isArray(companies) && companies.length >= 5) {
      const lines = companies.map(c => c.mainLine?.currentHandicap).filter(Boolean);
      const lineCount = {};
      lines.forEach(l => { lineCount[l] = (lineCount[l] || 0) + 1; });
      const mainLineEntry = Object.entries(lineCount).sort((a, b) => b[1] - a[1])[0];
      if (mainLineEntry && mainLineEntry[1] >= companies.length * 0.6) {
        res.signals.push({ signal: 'consensus', desc: `${companies.length}家公司中${mainLineEntry[1]}家给${mainLineEntry[0]}，盘口高度一致`, weight: 1 });
      }
    }

    return res;
  }

  _analyzeOverUnder(overunder) {
    if (!overunder || overunder.error) return { valid: false, signals: [] };
    const res = { valid: true, signals: [] };
    const { summary, companies } = overunder;

    res.mainLine = summary?.mainLine || '';

    const aoCompany = companies?.[0];
    if (aoCompany?.mainLine) {
      const ml = aoCompany.mainLine;
      const initLine = parseFloat(ml.initialLine || 0);
      const currLine = parseFloat(ml.currentLine || 0);
      const initOver = parseFloat(ml.initialOver || 0);
      const currOver = parseFloat(ml.currentOver || 0);

      res.initialLine = ml.initialLine;
      res.currentLine = ml.currentLine;

      if (currLine > initLine) {
        res.signals.push({ signal: 'line_up', desc: `大球线上移(${initLine}→${currLine})，预期进球增多`, weight: 1 });
        res.trend = 'over';
      } else if (currLine < initLine) {
        res.signals.push({ signal: 'line_down', desc: `大球线下移(${initLine}→${currLine})，预计低分`, weight: 1 });
        res.trend = 'under';
      }

      if (initOver - currOver > 0.05) {
        res.signals.push({ signal: 'over_water_down', desc: `大球水位降(${initOver}→${currOver})，资金流向大球`, weight: 1 });
        res.moneyFlow = 'over';
      } else if (currOver - initOver > 0.05) {
        res.signals.push({ signal: 'over_water_up', desc: `大球水位升(${initOver}→${currOver})，资金流向小球`, weight: 1 });
        res.moneyFlow = 'under';
      }
    }

    // 降盘统计
    const down = parseInt(summary?.down || 0);
    if (down >= 10) {
      res.signals.push({ signal: 'many_down', desc: `${down}家降盘，主流线从高线降至${res.mainLine}，预期小球`, weight: 1 });
      res.trend = res.trend || 'under';
    }

    return res;
  }

  _analyzeCorner(corner) {
    if (!corner || corner.error) return { valid: false };
    const companies = corner.companies || [];
    const mainLine = corner.mainLine || (companies[0]?.currentLine);
    return {
      valid: true,
      mainLine,
      prediction: parseFloat(mainLine) > 10 ? '预计角球偏多(大角球)' : '预计角球适中(小角球)',
      companies: companies.slice(0, 4)
    };
  }

  _analyzeStats(analysis) {
    if (!analysis || analysis.error) return { valid: false };
    const res = { valid: true };
    const home = analysis.homeStats;
    const away = analysis.awayStats;

    if (home?.total) {
      res.homeWinRate = home.total.winRate;
      res.homePoints = home.total.points;
      res.homeRank = home.total.rank;
      res.homePlayed = home.total.played;
      res.homeGoalsFor = home.total.goalsFor;
      res.homeGoalsAgainst = home.total.goalsAgainst;
    }
    if (away?.total) {
      res.awayWinRate = away.total.winRate;
      res.awayPoints = away.total.points;
      res.awayRank = away.total.rank;
      res.awayPlayed = away.total.played;
      res.awayGoalsFor = away.total.goalsFor;
      res.awayGoalsAgainst = away.total.goalsAgainst;
    }
    if (home?.last6 && away?.last6) {
      res.homeForm = `${home.last6.win}胜${home.last6.draw}平${home.last6.loss}负`;
      res.awayForm = `${away.last6.win}胜${away.last6.draw}平${away.last6.loss}负`;
    }

    // 伤停情况
    const homeInjuries = analysis.injuries?.home?.length || 0;
    const awayInjuries = analysis.injuries?.away?.length || 0;
    res.homeInjuries = homeInjuries;
    res.awayInjuries = awayInjuries;

    // 赛前简报
    res.preBriefing = analysis.preBriefing || '';

    return res;
  }

  _compositeScore(asian, ou, stats, analysis) {
    const recommendations = [];
    let confidence = 50;
    const factors = [];
    const alerts = [];

    // === 亚让盘 ===
    if (asian.valid) {
      asian.signals.forEach(s => {
        if (s.weight > 0) factors.push({ direction: 'home', weight: s.weight, reason: s.desc });
        else if (s.weight < 0) factors.push({ direction: 'away', weight: Math.abs(s.weight), reason: s.desc });
      });

      if (asian.aoCurrent) {
        const { home, away, line } = asian.aoCurrent;
        recommendations.push({
          market: '亚让盘',
          line: line,
          suggestion: `当前盘口 ${line}`,
          homePay: home,
          awayPay: away,
          edge: this._calcEdge(home, away)
        });
      }
    }

    // === 大小球 ===
    if (ou.valid) {
      const trend = ou.moneyFlow || ou.trend || 'neutral';
      recommendations.push({
        market: '大小球',
        line: ou.currentLine || ou.mainLine,
        suggestion: trend === 'over' ? `推荐大球(>${ou.currentLine})` :
                    trend === 'under' ? `推荐小球(<${ou.currentLine})` :
                    `盘口${ou.currentLine}，暂无明显倾向`,
        trend
      });
    }

    // === 角球 ===
    if (analysis?.corner?.mainLine) {
      recommendations.push({
        market: '角球',
        line: analysis.corner.mainLine,
        suggestion: `角球线 ${analysis.corner.mainLine}，${parseFloat(analysis.corner.mainLine) > 10 ? '倾向大角球' : '倾向小角球'}`
      });
    }

    // 主客综合倾向
    const homeScore = factors.filter(f => f.direction === 'home').reduce((s, f) => s + f.weight, 0);
    const awayScore = factors.filter(f => f.direction === 'away').reduce((s, f) => s + f.weight, 0);

    let mainSuggestion = '暂无明确信号，建议观望';
    if (homeScore > awayScore + 1) {
      mainSuggestion = '盘口信号倾向【主队】';
      confidence = Math.min(75, 55 + (homeScore - awayScore) * 5);
    } else if (awayScore > homeScore + 1) {
      mainSuggestion = '盘口信号倾向【客队】';
      confidence = Math.min(75, 55 + (awayScore - homeScore) * 5);
    }

    // 战绩加成
    if (stats.valid) {
      const homeWR = parseFloat(stats.homeWinRate) || 50;
      const awayWR = parseFloat(stats.awayWinRate) || 50;
      if (homeWR > awayWR + 15) confidence = Math.min(confidence + 3, 80);
      if (awayWR > homeWR + 15) confidence = Math.min(confidence + 3, 80);
    }

    // 伤停警报
    if (stats.homeInjuries >= 3) {
      alerts.push({ level: 'warn', msg: `主队${stats.homeInjuries}人缺阵，影响战力` });
    }
    if (stats.awayInjuries >= 3) {
      alerts.push({ level: 'warn', msg: `客队${stats.awayInjuries}人缺阵，影响战力` });
    }

    // 高信心提醒
    if (confidence >= 70) {
      alerts.push({ level: 'high', msg: `⚡ 高信心推荐(${confidence}%)：${mainSuggestion}`, playSound: true });
    }

    return {
      confidence: Math.round(confidence),
      summary: mainSuggestion,
      recommendations,
      factors,
      alerts
    };
  }

  // ===== 滚球实时预测 =====
  _livePredict(liveData, asianAnalysis, ouAnalysis, data) {
    const recs = [];
    const { minute, homeScore, awayScore, homeCorners, awayCorners } = liveData;
    const totalGoals = (homeScore || 0) + (awayScore || 0);
    const totalCorners = (homeCorners || 0) + (awayCorners || 0);
    const remaining = 90 - (minute || 0);

    // 进球数预测（当前进球 + 预计剩余进球）
    const ouLine = parseFloat(ouAnalysis.currentLine || ouAnalysis.mainLine || 2.5);
    const projectedGoals = totalGoals + (totalGoals / Math.max(minute, 1)) * remaining;

    if (minute >= 30 && minute <= 75) {
      if (projectedGoals > ouLine + 0.5) {
        recs.push({
          type: 'overunder', timing: `${minute}'`,
          suggestion: `当前${totalGoals}球，预计全场>${ouLine}，倾向大球`,
          confidence: 60, alert: totalGoals >= 2 && minute < 60
        });
      } else if (projectedGoals < ouLine - 0.5) {
        recs.push({
          type: 'overunder', timing: `${minute}'`,
          suggestion: `当前${totalGoals}球，预计全场<${ouLine}，倾向小球`,
          confidence: 60, alert: totalGoals === 0 && minute > 45
        });
      }
    }

    // 角球预测
    const cornerLine = parseFloat(data?.corner?.mainLine || 9.5);
    const projectedCorners = totalCorners + (totalCorners / Math.max(minute, 1)) * remaining;
    if (minute >= 20) {
      if (projectedCorners > cornerLine + 1) {
        recs.push({
          type: 'corner', timing: `${minute}'`,
          suggestion: `当前${totalCorners}角球，预计全场>${cornerLine}，推荐大角球`,
          confidence: 58, alert: false
        });
      } else if (projectedCorners < cornerLine - 1) {
        recs.push({
          type: 'corner', timing: `${minute}'`,
          suggestion: `当前${totalCorners}角球，预计全场<${cornerLine}，推荐小角球`,
          confidence: 58, alert: false
        });
      }
    }

    // 半场投注建议
    if (minute >= 30 && minute < 45) {
      recs.push({
        type: 'halftime', timing: `${minute}'`,
        suggestion: `半场前：当前${homeScore}-${awayScore}，半场进球数${totalGoals}，考虑半场大小球`,
        confidence: 55, alert: false
      });
    }

    // 比分投注建议（极端情况）
    if (totalGoals === 0 && minute >= 60) {
      recs.push({
        type: 'score', timing: `${minute}'`,
        suggestion: `${minute}'仍0-0，考虑进球/无进球盘`,
        confidence: 65, alert: true
      });
    }

    return recs;
  }

  _handicapValue(line) {
    const map = {
      '平手': 0, '平手/半球': 0.25, '半球': 0.5,
      '半球/一球': 0.75, '一球': 1, '一球/球半': 1.25,
      '球半': 1.5, '球半/两球': 1.75, '两球': 2
    };
    return map[line] ?? 0;
  }

  _calcEdge(home, away) {
    if (!home || !away) return 'unknown';
    if (parseFloat(home) < parseFloat(away) - 0.05) return 'home_value';
    if (parseFloat(away) < parseFloat(home) - 0.05) return 'away_value';
    return 'balanced';
  }
}

// ===== 预测记录管理 =====
export class PredictionLogger {
  static async save(prediction, matchInfo) {
    const key = `pred_history`;
    const result = await chrome.storage.local.get(key);
    const history = result[key] || [];

    history.unshift({
      id: Date.now(),
      matchId: prediction.matchId,
      matchInfo: matchInfo || {},
      generatedAt: prediction.generatedAt,
      isLive: prediction.isLive,
      confidence: prediction.confidence,
      summary: prediction.summary,
      recommendations: prediction.recommendations,
      liveRecommendations: prediction.liveRecommendations,
      alerts: prediction.alerts,
      // 赛后复盘字段
      actualResult: null,
      review: null
    });

    // 只保留最近100条
    if (history.length > 100) history.splice(100);

    await chrome.storage.local.set({ [key]: history });
    return history[0];
  }

  static async getAll() {
    const result = await chrome.storage.local.get('pred_history');
    return result['pred_history'] || [];
  }

  static async updateReview(id, actualResult, review) {
    const result = await chrome.storage.local.get('pred_history');
    const history = result['pred_history'] || [];
    const idx = history.findIndex(h => h.id === id);
    if (idx >= 0) {
      history[idx].actualResult = actualResult;
      history[idx].review = review;
      await chrome.storage.local.set({ 'pred_history': history });
    }
  }
}
